import {
  AdminHealth,
  AdminLedgerPage,
  AuditFacets,
  AuditPage,
  AuditQuery,
  OPS_SUMMARY_MAX_AUCTIONS,
  OpsSummary,
  PROJECTION_LAG_SLO_MS,
  type OpsAuctionError,
  type OpsAuctionRow,
  type OpsHealth,
  type OpsWarning,
} from "@bike/contracts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { OPS_GRACE_MS, type OpsSnapshot } from "../auction/auction-do";
import { errorFields, redact } from "../lib/logger";
import { writeMetric } from "../lib/metrics";
import { AppError } from "../lib/problem";
import { metricsOf } from "../middleware/request-context";
import type { AppEnv } from "../types";
import { AuctionId, auctionStub } from "./auctions";
import { EFFECTIVE } from "./catalogue";

/**
 * Admin observability API (mounted under the admin router, which enforces ADMIN; covered by the
 * authz matrix in test/authz.test.ts). Read-only: nothing here is audited except through the
 * existing mutation endpoints (retry-projection, cancel).
 *
 * Privacy decision (data minimisation, DPDP): admins see bidder PSEUDONYMS only — no user ids, no
 * e-mails, no hidden maxima — in the ops summary and the ledger. Operating an auction never needs
 * a bidder's identity; a dispute that does is handled offline with an audited DB query.
 */
export const adminOpsRoutes = new Hono<AppEnv>();

/** Per-object RPC budget. A slow or broken auction is reported, never fails the whole summary. */
export const OPS_DO_TIMEOUT_MS = 2_000;

export type Settled<T> = { ok: true; value: T } | { ok: false; error: OpsAuctionError };

/** Resolves within `ms`: the value, or "timeout" / "unavailable" (threw). Never rejects. */
export function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), ms);
  });
  const value = p.then(
    (v): Settled<T> => ({ ok: true, value: v }),
    (): Settled<T> => ({ ok: false, error: "unavailable" }),
  );
  return Promise.race([value, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface LiveListing {
  auctionId: string;
  title: string;
  status: OpsAuctionRow["status"];
  bidCount: number;
  currentPriceMinor: number | null;
  closesAt: number;
}

export function healthOf(s: OpsSnapshot): OpsHealth {
  if (s.consecutiveFailures > 0) return "failing";
  if ((s.oldestPendingAgeMs ?? 0) > PROJECTION_LAG_SLO_MS) return "lagging";
  return "ok";
}

/**
 * Pure aggregation (unit-tested with a fake fetcher): queries every listing's object in parallel,
 * each bounded by `timeoutMs`, and folds failures into per-row errors.
 */
export async function collectOps(
  listings: readonly LiveListing[],
  fetchSnapshot: (auctionId: string) => Promise<OpsSnapshot | null>,
  timeoutMs: number,
): Promise<OpsAuctionRow[]> {
  const settled = await Promise.all(
    listings.map((l) => settleWithin(fetchSnapshot(l.auctionId), timeoutMs)),
  );
  return listings.map((l, i): OpsAuctionRow => {
    const r = settled[i]!;
    const snap = r.ok ? r.value : null;
    if (!snap) {
      return {
        ...l,
        health: "unreachable",
        error: r.ok ? "not_found" : r.error,
        seq: null,
        projectedSeq: null,
        projectionLagSeq: null,
        pendingOutbox: null,
        oldestPendingAgeMs: null,
        viewers: null,
        consecutiveFailures: null,
        lastSyncError: null,
        lastSyncSuccessAt: null,
        extensionCount: null,
        bidsLast5m: null,
        lastBidAt: null,
        overdueTimers: null,
        deadlineOverdue: null,
        lastAlarmError: null,
      };
    }
    const masked = (s: string) => (redact(s) as string).slice(0, 300);
    return {
      auctionId: l.auctionId,
      title: l.title,
      status: snap.status,
      health: healthOf(snap),
      error: null,
      seq: snap.seq,
      projectedSeq: snap.projectedSeq,
      projectionLagSeq: Math.max(0, snap.seq - snap.projectedSeq),
      pendingOutbox: snap.pendingOutbox,
      oldestPendingAgeMs:
        snap.oldestPendingAgeMs === null ? null : Math.max(0, snap.oldestPendingAgeMs),
      viewers: snap.viewers,
      consecutiveFailures: snap.consecutiveFailures,
      lastSyncError: snap.lastSyncError === null ? null : masked(snap.lastSyncError),
      lastSyncSuccessAt: snap.lastSyncSuccessAt,
      bidCount: snap.bidCount,
      currentPriceMinor: snap.currentPriceMinor,
      closesAt: snap.closesAt,
      extensionCount: snap.extensionCount,
      bidsLast5m: snap.bidsLast5m,
      lastBidAt: snap.lastBidAt,
      overdueTimers: snap.overdueTimers,
      deadlineOverdue: snap.deadlineOverdue,
      lastAlarmError: snap.lastAlarmError
        ? { at: snap.lastAlarmError.at, message: masked(snap.lastAlarmError.message) }
        : null,
    };
  });
}

/** Per-row warnings derived only from data the objects actually reported. */
export function rowWarnings(rows: readonly OpsAuctionRow[]): OpsWarning[] {
  const out: OpsWarning[] = [];
  for (const r of rows) {
    const w = (code: OpsWarning["code"], severity: OpsWarning["severity"], message: string) =>
      out.push({ code, severity, auctionId: r.auctionId, message });
    if (r.health === "unreachable")
      w("AUCTION_UNREACHABLE", "critical", `Auction object did not answer (${r.error}).`);
    if (r.health === "failing")
      w(
        "PROJECTION_FAILING",
        "critical",
        `D1 projection failed ${r.consecutiveFailures}× in a row; ${r.pendingOutbox} event(s) pending.`,
      );
    if (r.health === "lagging")
      w(
        "PROJECTION_LAGGING",
        "warn",
        `${r.pendingOutbox} event(s) pending for ${Math.round((r.oldestPendingAgeMs ?? 0) / 1000)} s.`,
      );
    if (r.deadlineOverdue)
      w("DEADLINE_OVERDUE", "critical", `${r.status} past its deadline by more than the grace.`);
    if (r.overdueTimers)
      w("TIMER_OVERDUE", "warn", `${r.overdueTimers} timer(s) overdue: the alarm is late.`);
    if (r.lastAlarmError)
      w("ALARM_FAILED", "warn", "An alarm run failed since the object started.");
  }
  return out;
}

async function d1Check(db: D1Database): Promise<{ status: "ok" | "down"; latencyMs: number }> {
  const started = Date.now();
  try {
    await db.prepare("SELECT 1").first();
    return { status: "ok", latencyMs: Date.now() - started };
  } catch {
    return { status: "down", latencyMs: Date.now() - started };
  }
}

/**
 * Read-model anomalies (D1 only, bounded): rows whose STORED status is still SCHEDULED/LIVE although
 * the schedule says they should have started/ended more than the grace ago. Either the object's
 * alarm did not fire or its projection is stuck. Catalogue reads already mask this (effective
 * status), so it is invisible to buyers — which is exactly why ops must surface it.
 */
async function staleReadModel(db: D1Database, now: number): Promise<OpsWarning[]> {
  const rows = await db
    .prepare(
      `SELECT id, status, starts_at AS startsAt, closes_at AS closesAt FROM auctions_rm
       WHERE (status IN ('SCHEDULED','LIVE') AND closes_at < ?1)
          OR (status = 'SCHEDULED' AND starts_at < ?1)
       ORDER BY closes_at LIMIT 20`,
    )
    .bind(now - OPS_GRACE_MS)
    .all<{ id: string; status: string; startsAt: number; closesAt: number }>();
  return rows.results.map((r) => ({
    code: "READ_MODEL_STALE" as const,
    severity: "warn" as const,
    auctionId: r.id,
    message:
      r.closesAt < now - OPS_GRACE_MS
        ? `Read model still ${r.status} ${Math.round((now - r.closesAt) / 1000)} s after close.`
        : `Read model still SCHEDULED ${Math.round((now - r.startsAt) / 1000)} s after start.`,
  }));
}

const metricsBound = (env: Env) => metricsOf(env) !== undefined;

adminOpsRoutes.get("/ops/summary", async (c) => {
  const now = Date.now();
  const log = c.get("log");
  const d1 = await d1Check(c.env.DB);
  let listings: LiveListing[] = [];
  let liveCount: number | null = null;
  const warnings: OpsWarning[] = [];
  if (d1.status === "ok") {
    try {
      const [rows, count] = await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT r.id AS auctionId, COALESCE(l.title, r.id) AS title, ${EFFECTIVE} AS status,
             r.bid_count AS bidCount, r.current_price_minor AS currentPriceMinor, r.closes_at AS closesAt
           FROM auctions_rm r LEFT JOIN auction_listings l ON l.auction_id = r.id
           WHERE ${EFFECTIVE} = 'LIVE'
           ORDER BY r.closes_at ASC LIMIT ?2`,
        ).bind(now, OPS_SUMMARY_MAX_AUCTIONS),
        c.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM auctions_rm r WHERE ${EFFECTIVE} = 'LIVE'`,
        ).bind(now),
      ]);
      listings = (rows?.results ?? []) as unknown as LiveListing[];
      liveCount = Number((count?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
      warnings.push(...(await staleReadModel(c.env.DB, now)));
    } catch (err) {
      log.warn("admin.ops.d1_failed", errorFields(err));
      d1.status = "down";
    }
  }
  if (d1.status === "down")
    warnings.push({
      code: "D1_UNAVAILABLE",
      severity: "critical",
      auctionId: null,
      message: "D1 is unavailable: live auctions cannot be listed. Bidding is unaffected.",
    });

  const metrics = metricsOf(c.env);
  const auctions = await collectOps(
    listings,
    (id) =>
      auctionStub(c.env, id)
        .opsSnapshot()
        .catch((err: unknown) => {
          log.warn("admin.ops.snapshot_failed", { auctionId: id, ...errorFields(err) });
          writeMetric(metrics, { event: "do_rpc_failure", outcome: "ops_snapshot", index: id });
          throw err;
        }),
    OPS_DO_TIMEOUT_MS,
  );
  warnings.unshift(...rowWarnings(auctions));
  if (liveCount !== null && liveCount > auctions.length)
    warnings.push({
      code: "TRUNCATED",
      severity: "warn",
      auctionId: null,
      message: `Only the ${auctions.length} auctions closing soonest of ${liveCount} live are inspected.`,
    });
  if (!metricsBound(c.env))
    warnings.push({
      code: "METRICS_UNBOUND",
      severity: "warn",
      auctionId: null,
      message: "Analytics Engine is not bound: metrics are not being recorded.",
    });
  const syncs = auctions.map((a) => a.lastSyncSuccessAt).filter((t): t is number => t !== null);
  const body = OpsSummary.parse({
    generatedAt: now,
    global: {
      status:
        d1.status === "down"
          ? "down"
          : warnings.some((w) => w.code !== "METRICS_UNBOUND" && w.code !== "TRUNCATED")
            ? "degraded"
            : "ok",
      d1,
      metricsBound: metricsBound(c.env),
      liveCount,
      shown: auctions.length,
      truncated: liveCount !== null && liveCount > auctions.length,
      totalViewers: auctions.reduce((n, a) => n + (a.viewers ?? 0), 0),
      auctionsWithLag: auctions.filter((a) => a.health === "lagging" || a.health === "failing")
        .length,
      auctionsUnreachable: auctions.filter((a) => a.health === "unreachable").length,
      pendingOutboxTotal: auctions.reduce((n, a) => n + (a.pendingOutbox ?? 0), 0),
      bidsLast5m: auctions.reduce((n, a) => n + (a.bidsLast5m ?? 0), 0),
      lastSuccessfulSyncAt: syncs.length ? Math.max(...syncs) : null,
    },
    warnings,
    auctions,
  });
  c.header("Cache-Control", "no-store");
  return c.json(body);
});

/** Detailed readiness for admins (the public /status stays minimal). No DO fan-out. */
adminOpsRoutes.get("/ops/health", async (c) => {
  const now = Date.now();
  const d1 = await d1Check(c.env.DB);
  let warnings: OpsWarning[] = [];
  if (d1.status === "ok") {
    try {
      warnings = await staleReadModel(c.env.DB, now);
    } catch {
      d1.status = "down";
    }
  }
  const body = AdminHealth.parse({
    status: d1.status === "down" ? "down" : warnings.length ? "degraded" : "ok",
    version: c.env.APP_VERSION,
    environment: c.env.ENVIRONMENT,
    serverTime: now,
    checks: { d1, metricsBound: metricsBound(c.env) },
    warnings,
  });
  c.header("Cache-Control", "no-store");
  return c.json(body, d1.status === "down" ? 503 : 200);
});

const LedgerQuery = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function auctionId(c: Context<AppEnv>): string {
  const p = AuctionId.safeParse(c.req.param("id"));
  if (!p.success) throw new AppError("NOT_FOUND", "Auction not found");
  return p.data;
}

/**
 * Full accepted-bid ledger, newest first, keyset by seq. Pseudonymous (same per-auction codes as
 * the public history), with kind MANUAL/PROXY. Never user ids, e-mails or maxima.
 */
adminOpsRoutes.get("/auctions/:id/ledger", async (c) => {
  const q = LedgerQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError("VALIDATION_FAILED", q.error.issues[0]?.message);
  const id = auctionId(c);
  const stub = auctionStub(c.env, id);
  const status = (await stub.getView(null))?.status ?? null;
  const page = await stub.listBids({
    beforeSeq: q.data.beforeSeq ?? null,
    limit: q.data.limit,
    viewerUserId: null,
  });
  if (!page) throw new AppError("NOT_FOUND", "Auction not found");
  const body = AdminLedgerPage.parse({
    auctionId: id,
    items: page.items.map((b, i) => ({
      seq: b.seq,
      bidId: b.bidId,
      bidder: b.bidder,
      amountMinor: b.amountMinor,
      kind: b.kind,
      at: b.at,
      // Accepted bids strictly increase, so the newest bid leads, but only while the auction is
      // LIVE (an ended auction has a winner or none; a cancelled one has neither).
      isLeading: status === "LIVE" && q.data.beforeSeq === undefined && i === 0,
    })),
    nextBeforeSeq: page.nextBeforeSeq,
  });
  c.header("Cache-Control", "no-store");
  return c.json(body);
});

function parseMeta(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Admin audit trail, newest first. Filters: action, actorId, resourceType, resourceId, from/to
 * (epoch ms). Keyset cursor `<createdAt>_<id>` (stable under ties). Bounded: limit ≤ 100.
 */
adminOpsRoutes.get("/audit", async (c) => {
  const q = AuditQuery.safeParse(c.req.query());
  if (!q.success) {
    const i = q.error.issues[0];
    throw new AppError("VALIDATION_FAILED", i ? `${i.path.join(".")}: ${i.message}` : undefined);
  }
  const { action, actorId, resourceType, resourceId, from, to, cursor, limit } = q.data;
  const sep = cursor?.indexOf("_") ?? -1;
  const cAt = cursor ? Number(cursor.slice(0, sep)) : null;
  const cId = cursor ? cursor.slice(sep + 1) : null;
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.actor_user_id AS actorId, u.name AS actorName,
       a.resource_type AS resourceType, a.resource_id AS resourceId, a.metadata_json AS metadata,
       a.request_id AS requestId, a.created_at AS createdAt
     FROM audit_log a LEFT JOIN "user" u ON u.id = a.actor_user_id
     WHERE (?1 IS NULL OR a.action = ?1)
       AND (?2 IS NULL OR a.actor_user_id = ?2)
       AND (?3 IS NULL OR a.resource_type = ?3)
       AND (?4 IS NULL OR a.resource_id = ?4)
       AND (?5 IS NULL OR a.created_at >= ?5)
       AND (?6 IS NULL OR a.created_at < ?6)
       AND (?7 IS NULL OR a.created_at < ?7 OR (a.created_at = ?7 AND a.id < ?8))
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ?9`,
  )
    .bind(
      action ?? null,
      actorId ?? null,
      resourceType ?? null,
      resourceId ?? null,
      from ?? null,
      to ?? null,
      cAt,
      cId,
      limit,
    )
    .all<{
      id: string;
      action: string;
      actorId: string;
      actorName: string | null;
      resourceType: string;
      resourceId: string;
      metadata: string;
      requestId: string;
      createdAt: number;
    }>();
  const items = rows.results.map((r) => ({
    id: r.id,
    action: r.action,
    actor: { id: r.actorId, name: r.actorName },
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    metadata: parseMeta(r.metadata),
    requestId: r.requestId,
    createdAt: r.createdAt,
  }));
  const last = items.at(-1);
  c.header("Cache-Control", "no-store");
  return c.json(
    AuditPage.parse({
      items,
      nextCursor: items.length === limit && last ? `${last.createdAt}_${last.id}` : null,
    }),
  );
});

/** Values for the audit filters: actions seen, and admins (name only, no e-mails). */
adminOpsRoutes.get("/audit/facets", async (c) => {
  const [actions, actors] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action LIMIT 100`),
    c.env.DB.prepare(
      `SELECT id, name FROM "user"
       WHERE role = 'ADMIN' OR id IN (SELECT DISTINCT actor_user_id FROM audit_log)
       ORDER BY name LIMIT 100`,
    ),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json(
    AuditFacets.parse({
      actions: ((actions?.results ?? []) as { action: string }[]).map((r) => r.action),
      actors: ((actors?.results ?? []) as { id: string; name: string | null }[]).map((r) => ({
        id: r.id,
        name: r.name,
      })),
    }),
  );
});
