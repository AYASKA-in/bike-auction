import {
  AccountExport,
  DeleteAccountInput,
  PRIVACY_NOTICE_VERSION,
  Role,
  SETTLEMENT_WINDOW_DAYS,
  type AccountSummary,
  type ConsentRecord,
  type DeleteAccountResult,
  type DeletionBlocker,
} from "@bike/contracts";
import { Hono, type Context } from "hono";
import { getAuth } from "../auth/auth";
import { recordSecurityEvent } from "../auth/security-events";
import { hmacHex } from "../lib/crypto";
import { newId } from "../lib/ids";
import { errorFields } from "../lib/logger";
import { AppError } from "../lib/problem";
import { clientIp, overLimit, rateLimited } from "../middleware/security";
import { requireUser } from "../middleware/session";
import type { AppEnv } from "../types";
import type { RetireResult } from "../auction/auction-do";
import { auctionStub } from "./auctions";
import { settleWithin, type Settled } from "./admin-ops";
import { EFFECTIVE } from "./catalogue";

/**
 * Data-principal rights (DPDP Act 2023 §11–§13; docs/privacy.md):
 *
 * - `GET /me/account`: profile basics + consent history for the account page.
 * - `GET /me/export`: everything we hold about the caller, as a JSON attachment.
 * - `DELETE /me`: erase the account (refused while it would break an auction in progress).
 *
 * Identity comes only from the session. Mounted under /api/v1 after loadSession (/me/*).
 */
export const accountRoutes = new Hono<AppEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;
export const SETTLEMENT_WINDOW_MS = SETTLEMENT_WINDOW_DAYS * DAY_MS;
/** Upper bound on auctions checked against their Durable Objects in one deletion request. */
const MAX_DELETION_CANDIDATES = 200;
/** Auctions checked per deletion; above this we fail closed (operator handles it). */
const MAX_RETIRE_AUCTIONS = 1000;
const DO_TIMEOUT_MS = 3_000;
const DO_CONCURRENCY = 8;

/** Runs `fn` over `items` with bounded concurrency; each call gets its own timeout. */
async function boundedAll<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<Settled<R>[]> {
  const out: Settled<R>[] = new Array<Settled<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await settleWithin(fn(items[i]!), DO_TIMEOUT_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DO_CONCURRENCY, items.length) }, worker));
  return out;
}

async function limitedPerUser(c: Context<AppEnv>, prefix: string): Promise<Response | null> {
  if (await overLimit(c.env.AUTH_RATE_LIMIT, `${prefix}:${c.get("user")!.id}`)) {
    return rateLimited(c, "Too many requests for your account. Wait a minute.", 60);
  }
  return null;
}

const iso = (v: unknown) => new Date(String(v)).toISOString();
const ms = (v: unknown) => {
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
};

async function consentsOf(env: Env, userId: string): Promise<ConsentRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT purpose, version, at FROM consents WHERE user_id = ? ORDER BY at, id`,
  )
    .bind(userId)
    .all<ConsentRecord>();
  return rows.results;
}

accountRoutes.get("/me/account", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const me = c.get("user")!;
  const row = await c.env.DB.prepare(`SELECT "createdAt" AS created FROM "user" WHERE id = ?`)
    .bind(me.id)
    .first<{ created: string }>();
  return c.json<AccountSummary>({
    name: me.name,
    email: me.email,
    role: me.role,
    createdAt: ms(row?.created),
    consents: await consentsOf(c.env, me.id),
    noticeVersion: PRIVACY_NOTICE_VERSION,
  });
});

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  role: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Export: the caller's own rows only (every query is bound to the session user id). Excludes
 * secrets (password hash, session tokens), HMACed identifiers, other users' data and the reserve
 * prices / pseudonyms of auctions; `notes` says what is held elsewhere and why.
 */
accountRoutes.get("/me/export", requireUser, async (c) => {
  const limited = await limitedPerUser(c, "export");
  if (limited) return limited;
  const userId = c.get("user")!.id;
  const now = Date.now();
  const [user, sessions, consents, watch, bids, events, purchases, payments, deposits] =
    await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT id, name, email, "emailVerified", role, "createdAt", "updatedAt" FROM "user" WHERE id = ?`,
      ).bind(userId),
      c.env.DB.prepare(
        `SELECT "createdAt", "expiresAt", "ipAddress", "userAgent" FROM "session"
       WHERE "userId" = ? AND "expiresAt" > ? ORDER BY "createdAt" DESC LIMIT 100`,
      ).bind(userId, new Date(now).toISOString()),
      c.env.DB.prepare(
        `SELECT purpose, version, at FROM consents WHERE user_id = ? ORDER BY at, id`,
      ).bind(userId),
      c.env.DB.prepare(
        `SELECT w.auction_id, l.title, w.created_at FROM watchlist w
       LEFT JOIN auction_listings l ON l.auction_id = w.auction_id
       WHERE w.user_id = ? ORDER BY w.created_at DESC`,
      ).bind(userId),
      c.env.DB.prepare(
        `SELECT u.auction_id, l.title, u.highest_amount_minor, u.updated_at, r.status, r.outcome,
         (r.status = 'ENDED' AND r.outcome = 'SOLD' AND r.winner_user_id = u.user_id) AS won
       FROM user_bids_rm u
       LEFT JOIN auctions_rm r ON r.id = u.auction_id
       LEFT JOIN auction_listings l ON l.auction_id = u.auction_id
       WHERE u.user_id = ? ORDER BY u.updated_at DESC`,
      ).bind(userId),
      c.env.DB.prepare(
        `SELECT type, created_at, request_id FROM security_events
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 1000`,
      ).bind(userId),
      c.env.DB.prepare(
        `SELECT id, auction_id, title, status, price_minor FROM settlements WHERE buyer_user_id = ? ORDER BY created_at`,
      ).bind(userId),
      c.env.DB.prepare(
        `SELECT p.settlement_id, p.amount_minor, p.method, p.reference, p.status, p.reported_at
       FROM settlement_payments p JOIN settlements s ON s.id = p.settlement_id
       WHERE s.buyer_user_id = ? ORDER BY p.reported_at`,
      ).bind(userId),
      c.env.DB.prepare(
        `SELECT amount_minor, method, reference, status, created_at FROM deposits WHERE user_id = ? ORDER BY created_at`,
      ).bind(userId),
    ]);
  const u = (user?.results[0] ?? null) as UserRow | null;
  if (!u) throw new AppError("AUTH_REQUIRED", "Sign in to continue");

  // Own hidden maxima live only in the auction objects. Ask only the auctions this user bid in
  // (bounded), through the owner view (getView(userId) → viewer.myMaxMinor is the caller's own).
  const bidAuctions = (bids?.results ?? []) as { auction_id: string; title: string | null }[];
  const maxBids: AccountExport["maxBids"] = [];
  try {
    const asked = bidAuctions.slice(0, MAX_DELETION_CANDIDATES);
    // Parallel (bounded) with a timeout per object, so one slow auction can't stall the export.
    const views = await boundedAll(asked, (b) => auctionStub(c.env, b.auction_id).getView(userId));
    if (views.some((v) => !v.ok)) throw new Error("auction object unavailable");
    views.forEach((v, i) => {
      const view = v.ok ? v.value : null;
      const b = asked[i]!;
      const max = view?.viewer?.myMaxMinor ?? null;
      if (view && max !== null) {
        maxBids.push({
          auctionId: b.auction_id,
          title: b.title ?? null,
          maxMinor: max,
          auctionStatus: view.status,
          youAreLeading: view.viewer?.isLeading ?? false,
        });
      }
    });
  } catch (err) {
    c.get("log").error("account.export.max_bids_failed", errorFields(err));
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "We couldn't collect all of your data just now. Try again shortly.",
    );
  }

  const body = AccountExport.parse({
    format: "bike-auction.account-export.v1",
    generatedAt: new Date(now).toISOString(),
    noticeVersion: PRIVACY_NOTICE_VERSION,
    account: {
      id: u.id,
      name: u.name,
      email: u.email,
      emailVerified: Boolean(u.emailVerified),
      role: Role.catch("USER").parse(u.role),
      createdAt: iso(u.createdAt),
      updatedAt: iso(u.updatedAt),
    },
    sessions: (sessions?.results ?? []).map((r) => {
      const s = r as Record<string, string | null>;
      return {
        createdAt: iso(s.createdAt),
        expiresAt: iso(s.expiresAt),
        ipAddress: s.ipAddress ?? null,
        userAgent: s.userAgent ?? null,
      };
    }),
    consents: consents?.results ?? [],
    watchlist: (watch?.results ?? []).map((r) => {
      const w = r as { auction_id: string; title: string | null; created_at: number };
      return { auctionId: w.auction_id, title: w.title ?? null, watchedAt: w.created_at };
    }),
    bids: (bids?.results ?? []).map((r) => {
      const b = r as {
        auction_id: string;
        title: string | null;
        highest_amount_minor: number;
        updated_at: number;
        status: string | null;
        outcome: string | null;
        won: number | null;
      };
      return {
        auctionId: b.auction_id,
        title: b.title ?? null,
        myHighestMinor: b.highest_amount_minor,
        updatedAt: b.updated_at,
        auctionStatus: b.status ?? null,
        outcome: b.outcome ?? null,
        youWon: b.won === 1,
      };
    }),
    maxBids,
    purchases: (
      (purchases?.results ?? []) as {
        id: string;
        auction_id: string;
        title: string;
        status: string;
        price_minor: number;
      }[]
    ).map((s) => ({
      settlementId: s.id,
      auctionId: s.auction_id,
      title: s.title,
      status: s.status,
      priceMinor: s.price_minor,
      payments: (
        (payments?.results ?? []) as {
          settlement_id: string;
          amount_minor: number;
          method: string;
          reference: string;
          status: string;
          reported_at: number;
        }[]
      )
        .filter((p) => p.settlement_id === s.id)
        .map((p) => ({
          amountMinor: p.amount_minor,
          method: p.method,
          reference: p.reference,
          status: p.status,
          reportedAt: p.reported_at,
        })),
    })),
    deposits: (
      (deposits?.results ?? []) as {
        amount_minor: number;
        method: string;
        reference: string;
        status: string;
        created_at: number;
      }[]
    ).map((d) => ({
      amountMinor: d.amount_minor,
      method: d.method,
      reference: d.reference,
      status: d.status,
      createdAt: d.created_at,
    })),
    securityEvents: (events?.results ?? []).map((r) => {
      const e = r as { type: string; created_at: number; request_id: string };
      return { type: e.type, at: e.created_at, requestId: e.request_id };
    }),
    notes: [
      "Your password is stored only as a salted scrypt hash and is never exported.",
      "Each auction's bid ledger records your bids under an internal account id; other bidders only ever see a per-auction pseudonym. The 'bids' list above summarises your highest bid per auction.",
      "Security logs also contain keyed hashes (HMAC) of your email and IP address for abuse detection; the hashes are not reversible and are not included.",
      "Server request logs are kept by our hosting provider (Cloudflare) for a short period and are not part of this export.",
    ],
  });

  await recordSecurityEvent(c.env, {
    type: "account.exported",
    requestId: c.get("requestId"),
    userId,
    ip: clientIp(c),
  });
  const date = body.generatedAt.slice(0, 10);
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="bike-auction-data-${date}.json"`,
      "cache-control": "no-store",
    },
  });
});

type Candidate = { auction_id: string; title: string | null };

/**
 * Every auction where this user COULD still matter: effectively scheduled/live, or closed within
 * the settlement window. Deliberately NOT narrowed by the user's D1 rows (the projection is
 * asynchronous, so a just-placed bid or maximum may not be there yet). Fails closed above the cap.
 */
async function candidateAuctions(c: Context<AppEnv>, since: number): Promise<Candidate[]> {
  const rows = await c.env.DB.prepare(
    `SELECT r.id AS auction_id, l.title FROM auctions_rm r
     LEFT JOIN auction_listings l ON l.auction_id = r.id
     WHERE r.status <> 'DRAFT'
       AND (${EFFECTIVE} IN ('SCHEDULED','LIVE') OR (r.status = 'ENDED' AND r.closes_at > ?2))
     ORDER BY r.id
     LIMIT ${MAX_RETIRE_AUCTIONS + 1}`,
  )
    .bind(Date.now(), since)
    .all<Candidate>();
  if (rows.results.length > MAX_RETIRE_AUCTIONS) {
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "Account deletion needs an operator right now (too many open auctions to check). Nothing was deleted.",
    );
  }
  return rows.results;
}

const BLOCKER_REASON = {
  LEADING: "LEADING_LIVE_AUCTION",
  ACTIVE_MAX: "ACTIVE_MAX_BID_LIVE_AUCTION",
  WON_UNSETTLED: "WON_UNSETTLED_AUCTION",
} as const;

/**
 * Asks every candidate auction's Durable Object (the authority) to retire this user atomically:
 * each one either refuses (the user leads, holds a maximum that can still bid, or won within the
 * settlement window) or blocks every further bid/maximum from them. All-or-nothing: on any refusal
 * or unreachable object, the auctions already retired are rolled back.
 */
async function retireEverywhere(
  c: Context<AppEnv>,
  userId: string,
  candidates: readonly Candidate[],
  since: number,
): Promise<
  { ok: true; retired: string[] } | { ok: false; blockers: DeletionBlocker[]; unavailable: boolean }
> {
  const results = await boundedAll(
    candidates,
    (a) =>
      auctionStub(c.env, a.auction_id).retireUser(userId, since) as Promise<RetireResult | null>,
  );
  const retired: string[] = [];
  const blockers: DeletionBlocker[] = [];
  let unavailable = false;
  results.forEach((r, i) => {
    const a = candidates[i]!;
    if (!r.ok) unavailable = true;
    else if (r.value === null)
      return; // no such auction object
    else if (r.value.ok) retired.push(a.auction_id);
    else
      blockers.push({
        auctionId: a.auction_id,
        title: a.title ?? null,
        reason: BLOCKER_REASON[r.value.reason],
      });
  });
  if (blockers.length === 0 && !unavailable) return { ok: true, retired };
  await boundedAll(retired, (id) => auctionStub(c.env, id).unretireUser(userId));
  return { ok: false, blockers, unavailable };
}

/** Expired copies of every Better Auth cookie, so the browser forgets the revoked session. */
async function clearedAuthCookies(c: Context<AppEnv>): Promise<string[]> {
  const ctx = await (await getAuth(c.env, c.req.raw)).$context;
  const https = new URL(c.req.url).protocol === "https:";
  const { sessionToken, sessionData, dontRememberToken } = ctx.authCookies;
  return [sessionToken, sessionData, dontRememberToken].map(
    (ck) => `${ck.name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${https ? "; Secure" : ""}`,
  );
}

/**
 * Erase the caller's account. Body `{ confirmEmail }` must match the account email.
 *
 * Refused (409 CONFLICT, `blockers`) while the user leads a LIVE auction or won one that closed
 * less than SETTLEMENT_WINDOW_DAYS ago: erasing a counterparty mid-transaction would break the
 * auction for everyone else. Administrators are refused (403): their accounts anchor the audit
 * trail and are closed by an operator.
 *
 * Otherwise, in ONE atomic D1 batch: deletion record + audit + security event; delete sessions
 * (revokes every sign-in immediately), credentials, verification tokens, watchlist, consents,
 * login-throttle row and the user; re-key "My bids" rows to a random tombstone. Auction ledgers in
 * the Durable Objects are kept: they hold only the opaque user id and are needed for auction
 * integrity (docs/privacy.md → "Deletion"). A retry after success gets 401 (no session left).
 */
accountRoutes.delete("/me", requireUser, async (c) => {
  const limited = await limitedPerUser(c, "account");
  if (limited) return limited;
  const me = c.get("user")!;
  const input = DeleteAccountInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.confirmEmail.toLowerCase() !== me.email.toLowerCase()) {
    throw new AppError("VALIDATION_FAILED", "Type your account email exactly to confirm.");
  }
  if (me.role === "ADMIN") {
    throw new AppError(
      "FORBIDDEN",
      "Administrator accounts can't be deleted here. Ask an operator to close it.",
    );
  }

  // Money first: an open purchase or a deposit we still hold must be settled before erasure.
  const [owing, held] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT 1 FROM settlements WHERE buyer_user_id = ?
         AND (status IN ('OFFERED','AWAITING_INITIAL','AWAITING_BALANCE','PAID')
              OR (refund_due_minor > 0 AND refunded_at IS NULL)) LIMIT 1`,
    ).bind(me.id),
    c.env.DB.prepare(
      `SELECT 1 FROM deposits WHERE user_id = ? AND status IN ('PENDING','HELD','APPLIED','REFUND_REQUESTED') LIMIT 1`,
    ).bind(me.id),
  ]);
  if ((owing?.results?.length ?? 0) > 0 || (held?.results?.length ?? 0) > 0) {
    throw new AppError(
      "CONFLICT",
      (owing?.results?.length ?? 0) > 0
        ? "You have a purchase or a refund still in progress. You can delete your account once it's complete."
        : "We still hold a deposit for you. Ask for it back (Account → Deposit), then delete your account.",
      { blockers: [] },
    );
  }

  const since = Date.now() - SETTLEMENT_WINDOW_MS;
  let candidates: Candidate[];
  let retirement: Awaited<ReturnType<typeof retireEverywhere>>;
  try {
    candidates = await candidateAuctions(c, since);
    retirement = await retireEverywhere(c, me.id, candidates, since);
  } catch (err) {
    if (err instanceof AppError) throw err;
    c.get("log").error("account.delete.check_failed", errorFields(err));
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "We couldn't check your auctions just now. Nothing was deleted; try again shortly.",
    );
  }
  if (!retirement.ok && retirement.unavailable && retirement.blockers.length === 0) {
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "We couldn't check all of your auctions just now. Nothing was deleted; try again shortly.",
    );
  }
  const blockers = retirement.ok ? [] : retirement.blockers;
  if (blockers.length > 0) {
    await recordSecurityEvent(c.env, {
      type: "account.delete_refused",
      requestId: c.get("requestId"),
      userId: me.id,
      ip: clientIp(c),
    });
    const live = blockers.some((b) => b.reason !== "WON_UNSETTLED_AUCTION");
    throw new AppError(
      "CONFLICT",
      live
        ? "You have the highest bid or an active maximum bid in a live auction. You can delete your account once it has ended and been settled."
        : `You won an auction in the last ${SETTLEMENT_WINDOW_DAYS} days. You can delete your account once the settlement window has passed.`,
      { blockers },
    );
  }

  const now = Date.now();
  const requestId = c.get("requestId");
  const tombstone = newId("deleted");
  const throttleKey = await hmacHex(
    c.env.BETTER_AUTH_SECRET,
    "login",
    me.email.trim().toLowerCase(),
  );
  const bidRows = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM user_bids_rm WHERE user_id = ?`)
    .bind(me.id)
    .first<{ n: number }>();
  const ipHash = clientIp(c) ? await hmacHex(c.env.BETTER_AUTH_SECRET, "ip", clientIp(c)!) : null;
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO account_deletions (user_id, deleted_at, request_id, bid_rows_anonymised)
         VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING`,
      )
      .bind(me.id, now, requestId, bidRows?.n ?? 0),
    db
      .prepare(
        `INSERT INTO audit_log (id, actor_user_id, action, resource_type, resource_id, metadata_json, request_id, created_at)
         VALUES (?, ?, 'ACCOUNT_DELETED', 'user', ?, ?, ?, ?)`,
      )
      .bind(
        newId("aud"),
        me.id,
        me.id,
        JSON.stringify({ bidRowsAnonymised: bidRows?.n ?? 0, self: true }),
        requestId,
        now,
      ),
    db
      .prepare(
        `INSERT INTO security_events (id, type, user_id, subject_hash, ip_hash, request_id, created_at)
         VALUES (?, 'account.deleted', ?, NULL, ?, ?, ?)`,
      )
      .bind(newId("sev"), me.id, ipHash, requestId, now),
    db.prepare(`DELETE FROM "session" WHERE "userId" = ?`).bind(me.id),
    db.prepare(`DELETE FROM "account" WHERE "userId" = ?`).bind(me.id),
    db
      .prepare(`DELETE FROM "verification" WHERE "identifier" = ? OR "value" = ?`)
      .bind(me.email.toLowerCase(), me.id),
    db.prepare(`DELETE FROM watchlist WHERE user_id = ?`).bind(me.id),
    db.prepare(`DELETE FROM consents WHERE user_id = ?`).bind(me.id),
    db.prepare(`DELETE FROM login_throttle WHERE key = ?`).bind(throttleKey),
    db.prepare(`UPDATE user_bids_rm SET user_id = ? WHERE user_id = ?`).bind(tombstone, me.id),
    db
      .prepare(`UPDATE settlements SET buyer_user_id = ? WHERE buyer_user_id = ?`)
      .bind(tombstone, me.id),
    db
      .prepare(`UPDATE settlement_payments SET reported_by = ? WHERE reported_by = ?`)
      .bind(tombstone, me.id),
    db.prepare(`UPDATE deposits SET user_id = ? WHERE user_id = ?`).bind(tombstone, me.id),
    db.prepare(`DELETE FROM bidder_flags WHERE user_id = ?`).bind(me.id),
    db.prepare(`DELETE FROM "user" WHERE id = ?`).bind(me.id),
  ]);
  c.get("log").info("account.deleted", { bidRowsAnonymised: bidRows?.n ?? 0 });
  // Auctions scheduled during the deletion: retire there too (best effort; the user and sessions
  // are already gone, so this only closes a sub-second window for an in-flight request).
  try {
    const known = new Set(candidates.map((a) => a.auction_id));
    const fresh = (await candidateAuctions(c, since)).filter((a) => !known.has(a.auction_id));
    if (fresh.length > 0) await retireEverywhere(c, me.id, fresh, since);
  } catch (err) {
    c.get("log").warn("account.delete.late_retire_failed", errorFields(err));
  }

  const headers = new Headers({ "cache-control": "no-store", "content-type": "application/json" });
  for (const cookie of await clearedAuthCookies(c)) headers.append("set-cookie", cookie);
  const result: DeleteAccountResult = { deleted: true, deletedAt: now };
  return new Response(JSON.stringify(result), { status: 200, headers });
});
