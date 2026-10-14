import { imageStore } from "./image-store";
import { createLogger, errorFields, type Logger } from "./logger";

/**
 * Daily retention job (cron in wrangler.jsonc → `scheduled` in src/index.ts). docs/privacy.md
 * ("Retention schedule") documents what it implements.
 *
 * - Idempotent: every step is "delete rows older than X"; a second run is a no-op.
 * - Bounded: each statement deletes at most BATCH rows by key, each step stops after MAX_ROUNDS
 *   statements, and the R2 sweep lists one page of ORPHAN_SCAN_PAGE objects per run (resuming from a
 *   saved cursor). A backlog is finished by the following days' runs.
 * - Independent: a failing step is logged and the others still run.
 * - Never deletes auction records (auctions_rm, auction_bids_rm, listings, bikes, DO ledgers) for
 *   being old. Expired idempotency records live inside each AuctionDO and are already removed by its
 *   own `idem-gc` timer after 24 h, so this job does not touch them.
 *
 * Periods are configurable with Worker vars (wrangler.jsonc); out-of-range or malformed values fall
 * back to the default, and security logs can't be configured below one year.
 */
export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type Knob = { var: string; unitMs: number; def: number; min: number; max: number };
export const RETENTION_KNOBS = {
  /** DPDP Rules 2025 require logs to be kept for at least one year: the floor is not configurable. */
  securityEvents: {
    var: "RETENTION_SECURITY_EVENTS_DAYS",
    unitMs: DAY_MS,
    def: 365,
    min: 365,
    max: 3650,
  },
  /** Watchlist rows for auctions that ended/were cancelled this long ago. */
  watchlistAfterEnd: {
    var: "RETENTION_WATCHLIST_AFTER_END_DAYS",
    unitMs: DAY_MS,
    def: 90,
    min: 1,
    max: 3650,
  },
  /** Login backoff rows untouched this long (the longest lock is 15 min). */
  loginThrottleIdle: {
    var: "RETENTION_LOGIN_THROTTLE_HOURS",
    unitMs: HOUR_MS,
    def: 24,
    min: 1,
    max: 24 * 365,
  },
  /** Minimal account-deletion records (routes/account.ts). */
  accountDeletions: {
    var: "RETENTION_ACCOUNT_DELETIONS_DAYS",
    unitMs: DAY_MS,
    def: 365,
    min: 30,
    max: 3650,
  },
  /** Grace before an R2 image without a D1 row counts as a failed upload (uploads are R2-then-D1). */
  orphanUploads: {
    var: "RETENTION_ORPHAN_UPLOAD_HOURS",
    unitMs: HOUR_MS,
    def: 24,
    min: 1,
    max: 24 * 30,
  },
} as const satisfies Record<string, Knob>;
export type RetentionKey = keyof typeof RETENTION_KNOBS;
export type RetentionPeriods = Record<RetentionKey, number>;

/** Resolves every period in ms from the Worker's vars (strings), clamping to sane bounds. */
export function retentionPeriods(env: Env, log?: Logger): RetentionPeriods {
  const vars = env as unknown as Record<string, unknown>;
  const out = {} as RetentionPeriods;
  for (const [key, k] of Object.entries(RETENTION_KNOBS) as [RetentionKey, Knob][]) {
    const raw = vars[k.var];
    let n = k.def;
    if (raw !== undefined && raw !== "") {
      const v = Number(raw);
      if (Number.isInteger(v) && v >= k.min && v <= k.max) n = v;
      else log?.warn("retention.invalid_config", { var: k.var, value: String(raw), using: k.def });
    }
    out[key] = n * k.unitMs;
  }
  return out;
}

export const BATCH = 500;
export const MAX_ROUNDS = 20;
export const ORPHAN_SCAN_PAGE = 500;

export type RetentionReport = Record<string, number | "failed" | "skipped">;

type Step = { name: string; sql: string; binds: (now: number, p: RetentionPeriods) => unknown[] };

// Each `sql` deletes up to ?1 (= BATCH) rows selected by primary key / rowid; binds start at ?2.
const STEPS: Step[] = [
  {
    name: "security_events",
    sql: `DELETE FROM security_events WHERE id IN (
            SELECT id FROM security_events WHERE created_at < ?2 LIMIT ?1)`,
    binds: (now, p) => [now - p.securityEvents],
  },
  {
    // Better Auth stores dates as ISO-8601 text on D1; the typeof guard means a row in any other
    // format is never mis-compared (in SQLite every number sorts before every string).
    name: "expired_sessions",
    sql: `DELETE FROM "session" WHERE id IN (
            SELECT id FROM "session" WHERE typeof("expiresAt") = 'text' AND "expiresAt" < ?2 LIMIT ?1)`,
    binds: (now) => [new Date(now).toISOString()],
  },
  {
    name: "expired_verifications",
    sql: `DELETE FROM "verification" WHERE id IN (
            SELECT id FROM "verification" WHERE typeof("expiresAt") = 'text' AND "expiresAt" < ?2 LIMIT ?1)`,
    binds: (now) => [new Date(now).toISOString()],
  },
  {
    name: "login_throttle",
    sql: `DELETE FROM login_throttle WHERE key IN (
            SELECT key FROM login_throttle WHERE updated_at < ?2 AND locked_until < ?3 LIMIT ?1)`,
    binds: (now, p) => [now - p.loginThrottleIdle, now],
  },
  {
    // Only the buyer's bookmark goes; the auction itself is never removed for being old.
    name: "stale_watchlist",
    sql: `DELETE FROM watchlist WHERE rowid IN (
            SELECT w.rowid FROM watchlist w JOIN auctions_rm r ON r.id = w.auction_id
            WHERE (r.status = 'ENDED' AND r.closes_at < ?2)
               OR (r.status = 'CANCELLED' AND r.updated_at < ?2)
            LIMIT ?1)`,
    binds: (now, p) => [now - p.watchlistAfterEnd],
  },
  {
    // A projection retry that lands after an account was deleted could re-create a "My bids" row
    // under the old id; sweep those (routes/account.ts re-keys the rows present at deletion).
    name: "orphaned_user_bids",
    sql: `DELETE FROM user_bids_rm WHERE rowid IN (
            SELECT u.rowid FROM user_bids_rm u JOIN account_deletions d ON d.user_id = u.user_id
            WHERE d.deleted_at < ?2 LIMIT ?1)`,
    binds: (now) => [now],
  },
  {
    name: "account_deletions",
    sql: `DELETE FROM account_deletions WHERE user_id IN (
            SELECT user_id FROM account_deletions WHERE deleted_at < ?2 LIMIT ?1)`,
    binds: (now, p) => [now - p.accountDeletions],
  },
];

const CURSOR_KEY = "r2_orphan_cursor";

/**
 * Failed temporary uploads: image objects under `bikes/` with no `bike_images` row, older than the
 * grace period (an upload writes R2 first, then D1, and removes the object if D1 fails; a crash in
 * between leaves an orphan). One listing page per run; the cursor is saved in `retention_state`.
 */
async function sweepOrphanUploads(
  env: Env,
  now: number,
  p: RetentionPeriods,
): Promise<number | "skipped"> {
  const bucket = imageStore(env);
  if (!bucket) return "skipped";
  const saved = await env.DB.prepare(`SELECT value FROM retention_state WHERE key = ?`)
    .bind(CURSOR_KEY)
    .first<{ value: string }>();
  const page = await bucket.list("bikes/", ORPHAN_SCAN_PAGE, saved?.value || undefined);
  const old = page.items.filter((o) => o.uploadedAt < now - p.orphanUploads);
  const known = new Set<string>();
  for (let i = 0; i < old.length; i += 90) {
    const keys = old.slice(i, i + 90).map((o) => o.key);
    const rows = await env.DB.prepare(
      `SELECT r2_key FROM bike_images WHERE r2_key IN (${keys.map(() => "?").join(",")})`,
    )
      .bind(...keys)
      .all<{ r2_key: string }>();
    for (const r of rows.results) known.add(r.r2_key);
  }
  const orphans = old.map((o) => o.key).filter((k) => !known.has(k));
  if (orphans.length > 0) await bucket.delete(orphans);
  const next = page.cursor;
  await env.DB.prepare(
    next
      ? `INSERT INTO retention_state (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`
      : `DELETE FROM retention_state WHERE key = ?1`,
  )
    .bind(...(next ? [CURSOR_KEY, next, now] : [CURSOR_KEY]))
    .run();
  return orphans.length;
}

export async function runRetention(env: Env, now = Date.now()): Promise<RetentionReport> {
  const log = createLogger({ component: "retention" });
  const periods = retentionPeriods(env, log);
  const report: RetentionReport = {};
  for (const step of STEPS) {
    let deleted = 0;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await env.DB.prepare(step.sql)
          .bind(BATCH, ...step.binds(now, periods))
          .run();
        const changes = res.meta.changes ?? 0;
        deleted += changes;
        if (changes < BATCH) break;
      }
      report[step.name] = deleted;
    } catch (err) {
      report[step.name] = "failed";
      log.error("retention.step_failed", { step: step.name, deleted, ...errorFields(err) });
    }
  }
  try {
    report.orphan_uploads = await sweepOrphanUploads(env, now, periods);
  } catch (err) {
    report.orphan_uploads = "failed";
    log.error("retention.step_failed", { step: "orphan_uploads", ...errorFields(err) });
  }
  log.info("retention.completed", { ...report });
  return report;
}
