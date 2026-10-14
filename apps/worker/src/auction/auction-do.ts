import { DurableObject } from "cloudflare:workers";
import { WS_PING, WS_PONG, WS_PROTOCOL_VERSION } from "@bike/contracts";
import {
  bidFingerprint,
  cancel as cancelAuction,
  codeFromDigest,
  createAuction,
  DEFAULT_RULES,
  formatPseudonym,
  IDEMPOTENCY_RETENTION_MS,
  makeIdempotencyRecord,
  makeMaxIdempotencyRecord,
  maxBidFingerprint,
  placeBid as evaluateBid,
  minNextBidFor,
  proxyOf,
  pseudonymMessage,
  resolveIdempotency,
  schedule as scheduleAuction,
  setMaxBid as evaluateMaxBid,
  tick,
  toPublicEvent,
  toPublicView,
  updateTerms,
  type AuctionEvent,
  type AuctionPatch,
  type AuctionState,
  type BidKind,
  type CommandResult,
  type DomainError,
  type IdempotencyRecord,
  type ProxyBid,
  type PublicAuctionView,
  type StoredBidResult,
  type StoredMaxBidResult,
} from "@bike/domain";
import { hmacSha256 } from "../lib/crypto";
import { createLogger, errorFields } from "../lib/logger";
import { writeMetric, type MetricPoint, type MetricsSink } from "../lib/metrics";
import { migrateAuctionSchema } from "./schema";

/**
 * AuctionDO: the single authoritative coordinator for ONE auction (ADR 001).
 *
 * All auction rules live in @bike/domain (ADR 004); this class is persistence + transport:
 *   read state → resolve idempotency → evaluate (pure) → ONE transactionSync commit of
 *   {state, events/outbox, bid rows, idempotency record, pseudonym, timers} → then broadcast + D1.
 * There is no `await` between reading state and the commit; every await (HMAC, D1) happens either
 * before the read or after the commit.
 */

export type TimerKind = "lifecycle" | "outbox" | "idem-gc";

export type BidRpcResult<R = StoredBidResult> =
  | { kind: "evaluated"; replayed: boolean; result: R }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "account_closed" };
export type RetireResult =
  { ok: true } | { ok: false; reason: "LEADING" | "ACTIVE_MAX" | "WON_UNSETTLED" };
export type MaxBidRpcResult = BidRpcResult<StoredMaxBidResult>;

export type AdminResult =
  | { ok: true; details: AdminAuctionDetails }
  | { ok: false; error: DomainError | { code: "NOT_FOUND"; message: string } };

export interface OpsInfo {
  seq: number;
  projectedSeq: number;
  pendingOutbox: number;
  oldestPendingAgeMs: number | null;
  sync: {
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    consecutiveFailures: number;
    lastError: string | null;
  };
  connections: number;
  alarm: number | null;
  timers: { kind: TimerKind; dueAt: number }[];
}

/**
 * Admin-only: includes the reserve and the leader's user id. Never returned on buyer routes.
 * Hidden maxima are excluded even here: a maximum is visible to its owner only (ADR 004).
 */
export interface AdminAuctionDetails {
  state: Omit<AuctionState, "proxies">;
  view: PublicAuctionView;
  ops: OpsInfo;
}

/**
 * Compact, PII-free ops snapshot for the admin ops summary (one RPC per live auction). Read-only:
 * it never commits a due transition, so polling it cannot change auction state.
 */
export interface OpsSnapshot {
  status: AuctionState["status"];
  seq: number;
  projectedSeq: number;
  pendingOutbox: number;
  oldestPendingAgeMs: number | null;
  viewers: number;
  bidCount: number;
  currentPriceMinor: number | null;
  startsAt: number;
  closesAt: number;
  extensionCount: number;
  lastSyncError: string | null;
  consecutiveFailures: number;
  lastSyncSuccessAt: number | null;
  lastSyncAttemptAt: number | null;
  /** Accepted bids in the last 5 minutes and the newest bid's time (from the ledger). */
  bidsLast5m: number;
  lastBidAt: number | null;
  /** Timers due more than OPS_GRACE_MS ago (alarm late or failing). */
  overdueTimers: number;
  /** LIVE past closesAt, or SCHEDULED past startsAt, by more than OPS_GRACE_MS. */
  deadlineOverdue: boolean;
  /** Last alarm handler failure since this object instance started (in memory only). */
  lastAlarmError: { at: number; message: string } | null;
}

/** Grace before a missed deadline or an overdue timer is reported as an anomaly. */
export const OPS_GRACE_MS = 60_000;

export interface PublicBid {
  seq: number;
  bidId: string;
  bidder: string;
  amountMinor: number;
  kind: BidKind;
  at: number;
  isYou: boolean;
}

const OUTBOX_BATCH = 100;
const OUTBOX_MAX_BACKOFF_MS = 60_000;
/** Client → server messages (resyncs) allowed per socket per minute; pings are auto-answered. */
const MAX_CLIENT_MESSAGES = 30;
const CLIENT_MESSAGE_WINDOW_MS = 60_000;
/** Exact per-user, per-auction command throttle, persisted in SQLite (survives restarts). */
const BID_THROTTLE = { limit: 10, windowMs: 10_000 };

type Attachment = {
  userId: string | null;
  connectedAt: number;
  messages: number;
  windowStart?: number;
};

export class AuctionDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly log = createLogger({ component: "AuctionDO" });
  private cached: AuctionState | null | undefined; // undefined = not loaded
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrateAuctionSchema(ctx.storage);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_PING, WS_PONG));
    // Recovery: every kind of pending work gets a scheduled alarm after any restart.
    this.ctx.storage.transactionSync(() => {
      const s = this.load();
      if (s) this.syncLifecycleTimer(s);
      if (this.pendingOutbox() > 0 && !this.hasTimer("outbox")) this.setTimer("outbox", Date.now());
      if (this.oldestIdempotency() !== null && !this.hasTimer("idem-gc")) this.scheduleIdemGc();
    });
  }

  // ═════════════════════════════ admin commands ═════════════════════════════

  create(input: {
    auctionId: string;
    startPriceMinor: number;
    reserveMinor: number | null;
    startsAt: number;
    closesAt: number;
    schedule: boolean;
    /** Anti-sniping (soft close) is on by default; an admin may disable it per auction. */
    antiSniping?: boolean;
  }): AdminResult {
    if (this.load()) {
      return {
        ok: false,
        error: { code: "INVALID_TRANSITION", message: "Auction already exists" },
      };
    }
    const now = Date.now();
    const { antiSniping = true, schedule: _schedule, ...terms } = input;
    const rules = antiSniping ? DEFAULT_RULES : { ...DEFAULT_RULES, softClose: null };
    const created = createAuction({ ...terms, rules, now });
    if (!created.ok) return { ok: false, error: created.error };
    let result: CommandResult = created;
    if (input.schedule) {
      const s = scheduleAuction(created.state, now);
      if (!s.ok) return { ok: false, error: s.error };
      result = { ...s, events: [...created.events, ...s.events] };
    }
    this.commitAndPublish(result.events, result.state, null);
    return { ok: true, details: this.adminDetails() };
  }

  schedule(): AdminResult {
    return this.adminCommand((s, now) => scheduleAuction(s, now));
  }

  update(patch: AuctionPatch): AdminResult {
    return this.adminCommand((s, now) => updateTerms(s, patch, now));
  }

  cancel(reason: string): AdminResult {
    return this.adminCommand((s, now) => cancelAuction(s, { reason, now }));
  }

  getAdminDetails(): AdminAuctionDetails | null {
    if (!this.resolveNow()) return null;
    return this.adminDetails();
  }

  private adminCommand(run: (s: AuctionState, now: number) => CommandResult): AdminResult {
    const state = this.load();
    if (!state) return { ok: false, error: { code: "NOT_FOUND", message: "Auction not found" } };
    const r = run(state, Date.now());
    // Lifecycle events produced while resolving time are committed even when the command fails.
    this.commitAndPublish(r.events, r.state, state.leaderUserId);
    return r.ok ? { ok: true, details: this.adminDetails() } : { ok: false, error: r.error };
  }

  // ═════════════════════════════ bidding ═════════════════════════════

  async placeBid(cmd: {
    userId: string;
    amountMinor: number;
    idempotencyKey: string;
    requestId: string;
  }): Promise<BidRpcResult> {
    // ── async work BEFORE the critical section ──
    const started = Date.now();
    const auctionId = this.load()?.auctionId;
    if (!auctionId) return { kind: "not_found" };
    const digest = await hmacSha256(
      this.env.PSEUDONYM_SECRET,
      pseudonymMessage(auctionId, cmd.userId),
    );

    // ── critical section: synchronous from here to the end of commit() ──
    const now = Date.now();
    const state = this.load()!;
    const fingerprint = bidFingerprint({ auctionId, amountMinor: cmd.amountMinor });
    const request = { userId: cmd.userId, key: cmd.idempotencyKey, fingerprint };
    const idem = resolveIdempotency(
      this.loadIdempotency<StoredBidResult>(cmd.userId, cmd.idempotencyKey),
      request,
      now,
    );
    if (idem.kind === "replay") {
      this.log.info("auction.bid.replayed", { auctionId, requestId: cmd.requestId });
      return { kind: "evaluated", replayed: true, result: idem.result };
    }
    if (idem.kind === "conflict") return { kind: "conflict" };
    if (this.isRetired(cmd.userId)) return { kind: "account_closed" };
    // Throttle only NEW commands: retries of a stored result are always answered.
    const throttled = this.throttle(cmd.userId, now);
    if (throttled > 0) return { kind: "rate_limited", retryAfterMs: throttled };

    const decision = evaluateBid(state, {
      bidId: crypto.randomUUID(),
      userId: cmd.userId,
      amountMinor: cmd.amountMinor,
      now,
    });
    const record = makeIdempotencyRecord(request, decision, now);
    this.commit(decision.events, decision.state, () => {
      if (decision.ok) this.ensurePseudonym(cmd.userId, digest);
      this.storeIdempotency(record, now);
    });
    // ── committed ──
    this.publish(decision.events, state.leaderUserId);
    this.log.info(decision.ok ? "auction.bid.accepted" : "auction.bid.rejected", {
      auctionId,
      requestId: cmd.requestId,
      seq: decision.state.seq,
      ...(decision.ok
        ? { amountMinor: decision.bid.amountMinor }
        : { reason: decision.error.code }),
      // Automatic responses are public bids; the maxima behind them are never logged.
      automaticBids: decision.events.filter((e) => e.type === "bid.accepted" && e.kind === "PROXY")
        .length,
    });
    this.metric({
      event: decision.ok ? "bid_accepted" : "bid_rejected",
      outcome: decision.ok ? "MANUAL" : decision.error.code,
      // In-object processing time (pseudonym HMAC + evaluate + commit + broadcast).
      durationMs: Date.now() - started,
      count: decision.events.filter((e) => e.type === "bid.accepted").length,
      index: auctionId,
    });
    return { kind: "evaluated", replayed: false, result: record.result };
  }

  /**
   * Sets (or replaces) the caller's hidden maximum (BLUEPRINT §4.7). Same critical section, atomic
   * commit, idempotency table and persistent throttle as placeBid. The maximum is stored only in
   * `proxy_bids`; any automatic bids it causes are ordinary ledger rows with kind = 'PROXY'.
   */
  async setMaxBid(cmd: {
    userId: string;
    maxMinor: number;
    idempotencyKey: string;
    requestId: string;
  }): Promise<MaxBidRpcResult> {
    const auctionId = this.load()?.auctionId;
    if (!auctionId) return { kind: "not_found" };
    const digest = await hmacSha256(
      this.env.PSEUDONYM_SECRET,
      pseudonymMessage(auctionId, cmd.userId),
    );

    // ── critical section: synchronous from here to the end of commit() ──
    const now = Date.now();
    const state = this.load()!;
    const fingerprint = maxBidFingerprint({ auctionId, maxMinor: cmd.maxMinor });
    const request = { userId: cmd.userId, key: cmd.idempotencyKey, fingerprint };
    const idem = resolveIdempotency(
      this.loadIdempotency<StoredMaxBidResult>(cmd.userId, cmd.idempotencyKey),
      request,
      now,
    );
    if (idem.kind === "replay") {
      this.log.info("auction.max_bid.replayed", { auctionId, requestId: cmd.requestId });
      return { kind: "evaluated", replayed: true, result: idem.result };
    }
    if (idem.kind === "conflict") return { kind: "conflict" };
    if (this.isRetired(cmd.userId)) return { kind: "account_closed" };
    const throttled = this.throttle(cmd.userId, now);
    if (throttled > 0) return { kind: "rate_limited", retryAfterMs: throttled };

    const decision = evaluateMaxBid(state, {
      bidId: crypto.randomUUID(),
      userId: cmd.userId,
      maxMinor: cmd.maxMinor,
      now,
    });
    const record = makeMaxIdempotencyRecord(request, decision, now);
    this.commit(decision.events, decision.state, () => {
      if (decision.ok) this.ensurePseudonym(cmd.userId, digest);
      this.storeIdempotency(record, now);
    });
    // ── committed ──
    this.publish(decision.events, state.leaderUserId, decision.ok ? [cmd.userId] : []);
    this.log.info(decision.ok ? "auction.max_bid.set" : "auction.max_bid.rejected", {
      auctionId,
      requestId: cmd.requestId,
      seq: decision.state.seq,
      ...(decision.ok
        ? { isLeading: decision.outcome.isLeading }
        : { reason: decision.error.code }),
      automaticBids: decision.events.filter((e) => e.type === "bid.accepted").length,
    });
    this.metric({
      event: decision.ok ? "max_bid_set" : "max_bid_rejected",
      outcome: decision.ok ? "ok" : decision.error.code,
      count: decision.events.filter((e) => e.type === "bid.accepted").length,
      index: auctionId,
    });
    return { kind: "evaluated", replayed: false, result: record.result };
  }

  private storeIdempotency(record: IdempotencyRecord<unknown>, now: number): void {
    this.sql.exec(
      `INSERT INTO idempotency (user_id, key, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET fingerprint = excluded.fingerprint,
         result_json = excluded.result_json, created_at = excluded.created_at`,
      record.userId,
      record.key,
      record.fingerprint,
      JSON.stringify(record.result),
      record.createdAt,
    );
    if (!this.hasTimer("idem-gc")) this.setTimer("idem-gc", now + IDEMPOTENCY_RETENTION_MS);
  }

  /** Sliding window over SQLite rows (synchronous: safe inside the critical section). */
  private throttle(userId: string, now: number): number {
    const since = now - BID_THROTTLE.windowMs;
    this.sql.exec(`DELETE FROM bid_attempts WHERE at <= ?`, since);
    const r = this.sql
      .exec<{ n: number; first: number | null }>(
        `SELECT COUNT(*) AS n, MIN(at) AS first FROM bid_attempts WHERE user_id = ? AND at > ?`,
        userId,
        since,
      )
      .one();
    if (r.n >= BID_THROTTLE.limit) return BID_THROTTLE.windowMs - (now - (r.first ?? now));
    this.sql.exec(`INSERT INTO bid_attempts (user_id, at) VALUES (?, ?)`, userId, now);
    return 0;
  }

  // ═════════════════════════════ account closure ═════════════════════════════

  /**
   * Atomically decide whether `userId` may close their account as far as THIS auction is concerned,
   * and if so retire them here (no further bids or maxima from them; see the check in placeBid /
   * setMaxBid). Refused while they lead a LIVE auction, hold a maximum that can still bid, or won a
   * sale that closed after `wonSince`. Synchronous after resolveNow(): no command can interleave.
   */
  retireUser(userId: string, wonSince: number): RetireResult | null {
    const s = this.resolveNow();
    if (!s) return null;
    if (s.status === "LIVE") {
      if (s.leaderUserId === userId) return { ok: false, reason: "LEADING" };
      const max = proxyOf(s, userId)?.maxMinor ?? null;
      if (max !== null && max >= minNextBidFor(s)) return { ok: false, reason: "ACTIVE_MAX" };
    }
    if (
      s.status === "ENDED" &&
      s.outcome === "SOLD" &&
      s.leaderUserId === userId &&
      s.closesAt > wonSince
    ) {
      return { ok: false, reason: "WON_UNSETTLED" };
    }
    this.sql.exec(
      `INSERT INTO retired_users (user_id, retired_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`,
      userId,
      Date.now(),
    );
    return { ok: true };
  }

  /** Undo retireUser (the deletion was refused elsewhere and is rolled back). */
  unretireUser(userId: string): void {
    this.sql.exec(`DELETE FROM retired_users WHERE user_id = ?`, userId);
  }

  private isRetired(userId: string): boolean {
    return (
      this.sql.exec(`SELECT 1 FROM retired_users WHERE user_id = ?`, userId).toArray().length > 0
    );
  }

  // ═════════════════════════════ reads ═════════════════════════════

  getView(viewerUserId: string | null): PublicAuctionView | null {
    const s = this.resolveNow();
    return s ? this.viewFor(s, viewerUserId) : null;
  }

  listBids(q: {
    beforeSeq: number | null;
    limit: number;
    viewerUserId: string | null;
  }): { items: PublicBid[]; nextBeforeSeq: number | null } | null {
    if (!this.resolveNow()) return null;
    const rows = this.sql
      .exec<{
        seq: number;
        bid_id: string;
        user_id: string;
        amount_minor: number;
        kind: BidKind;
        at: number;
        code: string | null;
      }>(
        `SELECT b.seq, b.bid_id, b.user_id, b.amount_minor, b.kind, b.at, p.code
         FROM bids b LEFT JOIN pseudonyms p ON p.user_id = b.user_id
         WHERE b.seq < ? ORDER BY b.seq DESC LIMIT ?`,
        q.beforeSeq ?? Number.MAX_SAFE_INTEGER,
        q.limit,
      )
      .toArray();
    const items = rows.map((r) => ({
      seq: r.seq,
      bidId: r.bid_id,
      bidder: formatPseudonym(r.code ?? "0000"),
      amountMinor: r.amount_minor,
      kind: r.kind,
      at: r.at,
      isYou: q.viewerUserId !== null && r.user_id === q.viewerUserId,
    }));
    return { items, nextBeforeSeq: items.length === q.limit ? items.at(-1)!.seq : null };
  }

  ops(): OpsInfo {
    const s = this.load();
    const pending = this.sql
      .exec<{ n: number; minSeq: number | null; minAt: number | null }>(
        `SELECT COUNT(*) AS n, MIN(seq) AS minSeq, MIN(at) AS minAt FROM events WHERE projected_at IS NULL`,
      )
      .one();
    const sync = this.sql
      .exec<{
        last_attempt_at: number | null;
        last_success_at: number | null;
        consecutive_failures: number;
        last_error: string | null;
      }>(`SELECT * FROM sync_status WHERE id = 1`)
      .one();
    const timers = this.sql
      .exec<{ kind: TimerKind; due_at: number }>(`SELECT kind, due_at FROM timers ORDER BY due_at`)
      .toArray()
      .map((t) => ({ kind: t.kind, dueAt: t.due_at }));
    const seq = s?.seq ?? 0;
    return {
      seq,
      projectedSeq: pending.minSeq === null ? seq : pending.minSeq - 1,
      pendingOutbox: pending.n,
      oldestPendingAgeMs: pending.minAt === null ? null : Date.now() - pending.minAt,
      sync: {
        lastAttemptAt: sync.last_attempt_at,
        lastSuccessAt: sync.last_success_at,
        consecutiveFailures: sync.consecutive_failures,
        lastError: sync.last_error,
      },
      connections: this.ctx.getWebSockets("all").length,
      alarm: null,
      timers,
    };
  }

  /** Admin ops summary row (read-only; null when the object holds no auction). */
  opsSnapshot(): OpsSnapshot | null {
    const s = this.load();
    if (!s) return null;
    const o = this.ops();
    const now = Date.now();
    const bids = this.sql
      .exec<{ n: number; last: number | null }>(
        `SELECT (SELECT COUNT(*) FROM bids WHERE at >= ?) AS n, (SELECT MAX(at) FROM bids) AS last`,
        now - 5 * 60_000,
      )
      .one();
    const deadline =
      s.status === "LIVE" ? s.closesAt : s.status === "SCHEDULED" ? s.startsAt : null;
    return {
      status: s.status,
      seq: o.seq,
      projectedSeq: o.projectedSeq,
      pendingOutbox: o.pendingOutbox,
      oldestPendingAgeMs: o.oldestPendingAgeMs,
      viewers: o.connections,
      bidCount: s.bidCount,
      currentPriceMinor: s.currentPriceMinor,
      startsAt: s.startsAt,
      closesAt: s.closesAt,
      extensionCount: s.extensionCount,
      lastSyncError: o.sync.lastError,
      consecutiveFailures: o.sync.consecutiveFailures,
      lastSyncSuccessAt: o.sync.lastSuccessAt,
      lastSyncAttemptAt: o.sync.lastAttemptAt,
      bidsLast5m: bids.n,
      lastBidAt: bids.last,
      overdueTimers: o.timers.filter((t) => t.dueAt < now - OPS_GRACE_MS).length,
      deadlineOverdue: deadline !== null && deadline < now - OPS_GRACE_MS,
      lastAlarmError: this.lastAlarmError,
    };
  }

  private lastAlarmError: { at: number; message: string } | null = null;

  /** Best-effort metric for this auction (no-op when Analytics Engine is not bound). */
  private metric(p: MetricPoint): void {
    writeMetric((this.env as { METRICS?: MetricsSink }).METRICS, {
      ...p,
      index: p.index ?? this.cached?.auctionId ?? undefined,
      version: this.env.APP_VERSION,
    });
  }

  async opsWithAlarm(): Promise<OpsInfo> {
    return { ...this.ops(), alarm: await this.ctx.storage.getAlarm() };
  }

  /** Ops action (runbook: projection lag). Returns the number of events still pending. */
  async retryProjection(): Promise<number> {
    await this.drainOutbox();
    return this.pendingOutbox();
  }

  // ═════════════════════════════ persistence ═════════════════════════════

  /**
   * State = state_json (everything public-or-admin) + proxy_bids (hidden maxima). Maxima are kept
   * out of state_json on purpose, so the only place a maximum is stored is its own table.
   */
  private load(): AuctionState | null {
    if (this.cached === undefined) {
      const row = this.sql
        .exec<{ state_json: string }>(`SELECT state_json FROM auction_state WHERE id = 1`)
        .toArray()[0];
      if (!row) {
        this.cached = null;
      } else {
        const proxies: ProxyBid[] = this.sql
          .exec<{ user_id: string; max_minor: number; set_seq: number; updated_at: number }>(
            `SELECT user_id, max_minor, set_seq, updated_at FROM proxy_bids ORDER BY set_seq, user_id`,
          )
          .toArray()
          .map((r) => ({
            userId: r.user_id,
            maxMinor: r.max_minor,
            setSeq: r.set_seq,
            updatedAt: r.updated_at,
          }));
        const persisted = JSON.parse(row.state_json) as Omit<AuctionState, "proxies">;
        this.cached = { ...persisted, proxies };
      }
    }
    return this.cached;
  }

  /**
   * The ONLY write path for auction state. One transaction: state, events (= outbox), bid ledger
   * rows, lifecycle/outbox timers and any extra writes. Refuses a non-contiguous event sequence, so
   * a logic bug cannot corrupt the log. The in-memory cache changes only after the commit succeeds.
   */
  private commit(events: readonly AuctionEvent[], next: AuctionState, extra?: () => void): void {
    const current = this.load();
    if (events.length === 0 && next === current && !extra) return;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      let expected = (current?.seq ?? 0) + 1;
      for (const e of events) {
        if (e.seq !== expected)
          throw new Error(`Non-contiguous event seq ${e.seq}, expected ${expected}`);
        expected++;
        this.sql.exec(
          `INSERT INTO events (seq, type, payload_json, at) VALUES (?, ?, ?, ?)`,
          e.seq,
          e.type,
          JSON.stringify(e),
          e.at,
        );
        if (e.type === "bid.accepted") {
          this.sql.exec(
            `INSERT INTO bids (seq, bid_id, user_id, amount_minor, kind, at) VALUES (?, ?, ?, ?, ?, ?)`,
            e.seq,
            e.bidId,
            e.userId,
            e.amountMinor,
            e.kind,
            e.at,
          );
        }
      }
      if (next.seq !== expected - 1) {
        throw new Error(`State seq ${next.seq} does not match events (${expected - 1})`);
      }
      if (next !== current) {
        const { proxies, ...persisted } = next;
        this.sql.exec(
          `INSERT INTO auction_state (id, seq, state_json, updated_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
          next.seq,
          JSON.stringify(persisted),
          now,
        );
        // Maxima are only ever set or replaced (never removed), so upserting changes suffices.
        const before = new Map((current?.proxies ?? []).map((p) => [p.userId, p]));
        for (const p of proxies) {
          const old = before.get(p.userId);
          if (old && old.maxMinor === p.maxMinor && old.setSeq === p.setSeq) continue;
          this.sql.exec(
            `INSERT INTO proxy_bids (user_id, max_minor, set_seq, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET max_minor = excluded.max_minor,
               set_seq = excluded.set_seq, updated_at = excluded.updated_at`,
            p.userId,
            p.maxMinor,
            p.setSeq,
            p.updatedAt,
          );
        }
      }
      this.syncLifecycleTimer(next);
      if (events.length > 0) this.setTimer("outbox", now);
      extra?.();
    });
    this.cached = next;
  }

  private commitAndPublish(
    events: readonly AuctionEvent[],
    next: AuctionState,
    previousLeader: string | null,
  ): void {
    this.commit(events, next);
    this.publish(events, previousLeader);
  }

  /** Commits any lifecycle transition that is due now (lazy start/close), then returns state. */
  private resolveNow(): AuctionState | null {
    const s = this.load();
    if (!s) return null;
    const t = tick(s, Date.now());
    if (t.events.length > 0) this.commitAndPublish(t.events, t.state, s.leaderUserId);
    return t.state;
  }

  /** R is the result type of the command being retried; a different command's key conflicts. */
  private loadIdempotency<R>(userId: string, key: string): IdempotencyRecord<R> | null {
    const row = this.sql
      .exec<{ fingerprint: string; result_json: string; created_at: number }>(
        `SELECT fingerprint, result_json, created_at FROM idempotency WHERE user_id = ? AND key = ?`,
        userId,
        key,
      )
      .toArray()[0];
    return row
      ? {
          userId,
          key,
          fingerprint: row.fingerprint,
          result: JSON.parse(row.result_json) as R,
          createdAt: row.created_at,
        }
      : null;
  }

  private oldestIdempotency(): number | null {
    return this.sql.exec<{ m: number | null }>(`SELECT MIN(created_at) AS m FROM idempotency`).one()
      .m;
  }

  private ensurePseudonym(userId: string, digest: Uint8Array): void {
    if (this.sql.exec(`SELECT 1 FROM pseudonyms WHERE user_id = ?`, userId).toArray().length)
      return;
    const code = codeFromDigest(
      digest,
      (c) =>
        this.sql
          .exec(`SELECT 1 FROM pseudonyms WHERE code = ? AND user_id != ?`, c, userId)
          .toArray().length > 0,
    );
    this.sql.exec(`INSERT INTO pseudonyms (user_id, code) VALUES (?, ?)`, userId, code);
  }

  private pseudonymOf(userId: string): string {
    const row = this.sql
      .exec<{ code: string }>(`SELECT code FROM pseudonyms WHERE user_id = ?`, userId)
      .toArray()[0];
    if (!row) {
      this.log.error("auction.pseudonym_missing", {});
      return formatPseudonym("0000");
    }
    return formatPseudonym(row.code);
  }

  private viewFor(s: AuctionState, viewerUserId: string | null): PublicAuctionView {
    return toPublicView(s, {
      leaderPseudonym: s.leaderUserId === null ? null : this.pseudonymOf(s.leaderUserId),
      viewerUserId,
    });
  }

  private adminDetails(): AdminAuctionDetails {
    const { proxies: _hidden, ...state } = this.load()!;
    return { state, view: this.viewFor(this.load()!, null), ops: this.ops() };
  }

  // ═════════════════════════════ alarm multiplexer ═════════════════════════════

  /**
   * One alarm per object; all deadlines live in `timers` and the alarm is always the earliest.
   * Alarms are at-least-once (≤ 6 automatic retries): each handler is idempotent, errors are caught,
   * and the alarm is rescheduled in `finally` so work is never orphaned.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.sql
      .exec<{ kind: TimerKind }>(`SELECT kind FROM timers WHERE due_at <= ? ORDER BY due_at`, now)
      .toArray()
      .map((r) => r.kind);
    let outcome = "ok";
    try {
      for (const kind of due) {
        if (kind === "lifecycle") this.resolveNow();
        else if (kind === "outbox") await this.drainOutbox();
        else if (kind === "idem-gc") this.gcIdempotency(now);
      }
    } catch (err) {
      outcome = "error";
      const fields = errorFields(err);
      this.lastAlarmError = { at: now, message: String(fields.errorMessage).slice(0, 300) };
      this.log.error("auction.alarm_failed", { auctionId: this.cached?.auctionId, ...fields });
    } finally {
      this.rescheduleAlarm();
      this.metric({
        event: "alarm_run",
        outcome,
        durationMs: Date.now() - now,
        count: due.length,
      });
    }
  }

  private syncLifecycleTimer(s: AuctionState): void {
    const due = s.status === "SCHEDULED" ? s.startsAt : s.status === "LIVE" ? s.closesAt : null;
    if (due === null) this.clearTimer("lifecycle");
    else this.setTimer("lifecycle", due);
  }

  private gcIdempotency(now: number): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM idempotency WHERE created_at <= ?`,
        now - IDEMPOTENCY_RETENTION_MS,
      );
      this.clearTimer("idem-gc");
      this.scheduleIdemGc();
    });
  }

  private scheduleIdemGc(): void {
    const oldest = this.oldestIdempotency();
    if (oldest !== null) this.setTimer("idem-gc", oldest + IDEMPOTENCY_RETENTION_MS);
  }

  private setTimer(kind: TimerKind, dueAt: number): void {
    this.sql.exec(
      `INSERT INTO timers (kind, due_at) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET due_at = excluded.due_at`,
      kind,
      dueAt,
    );
    this.rescheduleAlarm();
  }

  private hasTimer(kind: TimerKind): boolean {
    return this.sql.exec(`SELECT 1 FROM timers WHERE kind = ?`, kind).toArray().length > 0;
  }

  private clearTimer(kind: TimerKind): void {
    this.sql.exec(`DELETE FROM timers WHERE kind = ?`, kind);
    this.rescheduleAlarm();
  }

  private rescheduleAlarm(): void {
    const next = this.sql.exec<{ m: number | null }>(`SELECT MIN(due_at) AS m FROM timers`).one().m;
    void (next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(next));
  }

  // ═════════════════════════════ outbox → D1 read models ═════════════════════════════

  private pendingOutbox(): number {
    return this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE projected_at IS NULL`)
      .one().n;
  }

  /** Coalesces concurrent drains (post-commit waitUntil + alarm) into one at a time. */
  private drainOutbox(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.drainAgain = false;
          await this.projectOnce();
        } while (this.drainAgain);
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /**
   * Projects pending events into D1 in ONE atomic D1 batch. Idempotent and monotonic:
   * bid rows use INSERT OR IGNORE on (auction_id, seq); summary rows only accept a newer seq. Events
   * are marked projected only after the batch succeeds, and only up to the seq projected.
   */
  private async projectOnce(): Promise<void> {
    const state = this.load();
    const pending = this.sql
      .exec<{ seq: number; payload_json: string; at: number }>(
        `SELECT seq, payload_json, at FROM events WHERE projected_at IS NULL ORDER BY seq LIMIT ?`,
        OUTBOX_BATCH,
      )
      .toArray();
    if (!state || pending.length === 0) {
      this.ctx.storage.transactionSync(() => this.clearTimer("outbox"));
      return;
    }
    const upTo = pending.at(-1)!.seq;
    const now = Date.now();
    const db = this.env.DB;
    const view = this.viewFor(state, null);
    const stmts: D1PreparedStatement[] = [];
    for (const row of pending) {
      const e = JSON.parse(row.payload_json) as AuctionEvent;
      if (e.type !== "bid.accepted") continue;
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO auction_bids_rm (auction_id, seq, bid_id, bidder, amount_minor, at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(state.auctionId, e.seq, e.bidId, this.pseudonymOf(e.userId), e.amountMinor, e.at),
        db
          .prepare(
            `INSERT INTO user_bids_rm (user_id, auction_id, highest_amount_minor, last_bid_seq, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id, auction_id) DO UPDATE SET
               highest_amount_minor = MAX(user_bids_rm.highest_amount_minor, excluded.highest_amount_minor),
               last_bid_seq = excluded.last_bid_seq, updated_at = excluded.updated_at
             WHERE excluded.last_bid_seq > user_bids_rm.last_bid_seq`,
          )
          .bind(e.userId, state.auctionId, e.amountMinor, e.seq, now),
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO auctions_rm (id, status, outcome, start_price_minor, current_price_minor, bid_count,
             starts_at, closes_at, has_reserve, reserve_met, leading_bidder, winner_user_id, extension_count,
             projection_seq, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status, outcome = excluded.outcome, start_price_minor = excluded.start_price_minor,
             current_price_minor = excluded.current_price_minor, bid_count = excluded.bid_count,
             starts_at = excluded.starts_at, closes_at = excluded.closes_at, has_reserve = excluded.has_reserve,
             reserve_met = excluded.reserve_met, leading_bidder = excluded.leading_bidder,
             winner_user_id = excluded.winner_user_id, extension_count = excluded.extension_count,
             projection_seq = excluded.projection_seq, updated_at = excluded.updated_at
           WHERE excluded.projection_seq > auctions_rm.projection_seq`,
        )
        .bind(
          state.auctionId,
          state.status,
          state.outcome,
          state.startPriceMinor,
          state.currentPriceMinor,
          state.bidCount,
          state.startsAt,
          state.closesAt,
          state.reserveMinor === null ? 0 : 1,
          view.reserveMet ? 1 : 0,
          view.leadingBidder,
          state.winnerUserId,
          state.extensionCount,
          state.seq,
          now,
        ),
    );
    if (state.status === "ENDED" || state.status === "CANCELLED") {
      // Release the bike for a new auction (clears the open-auction unique index).
      stmts.push(
        db
          .prepare(`UPDATE auction_listings SET active = 0 WHERE auction_id = ?`)
          .bind(state.auctionId),
      );
    }
    try {
      await db.batch(stmts);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE events SET projected_at = ? WHERE projected_at IS NULL AND seq <= ?`,
          now,
          upTo,
        );
        this.sql.exec(
          `UPDATE sync_status SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = 0,
             last_error = NULL WHERE id = 1`,
          now,
          now,
        );
        if (this.pendingOutbox() === 0) this.clearTimer("outbox");
        else this.setTimer("outbox", now);
      });
      this.log.info("auction.projection.ok", {
        auctionId: state.auctionId,
        upToSeq: upTo,
        lagMs: now - pending[0]!.at,
      });
      this.metric({
        event: "projection_lag",
        outcome: "ok",
        durationMs: now - pending[0]!.at,
        count: pending.length,
        value: this.pendingOutbox(),
        index: state.auctionId,
      });
    } catch (err) {
      let failures = 0;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE events SET attempts = attempts + 1 WHERE projected_at IS NULL AND seq <= ?`,
          upTo,
        );
        failures = this.sql
          .exec<{ f: number }>(
            `UPDATE sync_status SET last_attempt_at = ?, consecutive_failures = consecutive_failures + 1,
               last_error = ? WHERE id = 1 RETURNING consecutive_failures AS f`,
            now,
            err instanceof Error ? err.message.slice(0, 300) : String(err),
          )
          .one().f;
        this.setTimer(
          "outbox",
          now + Math.min(OUTBOX_MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 6)),
        );
      });
      this.log.warn("auction.projection.failed", {
        auctionId: state.auctionId,
        ...errorFields(err),
        consecutiveFailures: failures,
      });
      this.metric({
        event: "projection_failure",
        outcome: "d1_error",
        durationMs: now - pending[0]!.at,
        count: pending.length,
        value: failures,
        index: state.auctionId,
      });
    }
  }

  // ═════════════════════════════ WebSockets ═════════════════════════════

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const state = this.resolveNow();
    if (!state) return new Response("Auction not found", { status: 404 });
    // Set by the Worker from the verified session after stripping any client-supplied value.
    const userId = request.headers.get("x-user-id") || null;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["all", userId ? `user:${userId}` : "anon"]);
    const att: Attachment = { userId, connectedAt: Date.now(), messages: 0 };
    server.serializeAttachment(att);
    server.send(
      JSON.stringify({
        protocolVersion: WS_PROTOCOL_VERSION,
        type: "hello",
        serverTime: Date.now(),
      }),
    );
    this.sendSnapshot(server, state, userId);
    this.metric({
      event: "ws_connect",
      outcome: userId ? "user" : "anon",
      count: this.ctx.getWebSockets("all").length,
      index: state.auctionId,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendSnapshot(ws: WebSocket, state: AuctionState, userId: string | null): void {
    ws.send(
      JSON.stringify({
        protocolVersion: WS_PROTOCOL_VERSION,
        type: "auction.snapshot",
        serverTime: Date.now(),
        view: this.viewFor(state, userId),
      }),
    );
  }

  /**
   * The only client message is `{"type":"resync"}` (sent when a client detects a seq gap); it gets a
   * fresh snapshot. Heartbeats are auto-responded without waking the object. Anything else counts
   * towards an abuse limit.
   */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const att = (ws.deserializeAttachment() ?? {
      userId: null,
      connectedAt: 0,
      messages: 0,
    }) as Attachment;
    // Fixed one-minute window: a long-lived tab that resyncs on every visibility change stays
    // well within it; a client spamming messages is cut off.
    const now = Date.now();
    if (att.windowStart === undefined || now - att.windowStart >= CLIENT_MESSAGE_WINDOW_MS) {
      att.windowStart = now;
      att.messages = 0;
    }
    att.messages += 1;
    ws.serializeAttachment(att);
    if (att.messages > MAX_CLIENT_MESSAGES) {
      ws.close(1008, "Too many messages");
      return;
    }
    if (typeof message === "string" && message.length < 64 && message.includes('"resync"')) {
      const s = this.resolveNow();
      if (s) this.sendSnapshot(ws, s, att.userId);
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    let att: Attachment | null = null;
    try {
      att = ws.deserializeAttachment() as Attachment | null;
    } catch {
      // no attachment
    }
    this.metric({
      event: "ws_disconnect",
      // Close codes are a small fixed set (1000, 1001, 1006, 1008 …): bounded.
      outcome: String(code),
      durationMs: att?.connectedAt ? Date.now() - att.connectedAt : 0,
      count: Math.max(0, this.ctx.getWebSockets("all").length - 1),
      // 1 = abnormal close (no clean close frame / server error / policy): what clients see as a
      // dropped connection and must reconnect from. 1000/1001/1005 are normal.
      value: [1000, 1001, 1005].includes(code) ? 0 : 1,
      index: this.load()?.auctionId,
    });
  }

  override webSocketError(_ws: WebSocket, err: unknown): void {
    this.metric({ event: "ws_error", outcome: "error", count: 1, value: 1 });
    this.log.warn("auction.ws_error", { auctionId: this.cached?.auctionId, ...errorFields(err) });
  }

  connectionCount(): number {
    return this.ctx.getWebSockets("all").length;
  }

  /**
   * Broadcasts committed events in seq order (public form only), then targeted messages:
   *  - `you.outbid` once per commit, right after its LAST bid, to every user who led before or
   *    during the commit but not after it. A leader whose maximum defended the lead within the
   *    same commit is not told they were outbid; a manual bidder countered by a maximum is.
   *  - a personal `auction.snapshot` to `personal` users and to owners of automatic (PROXY) bids:
   *    their client did not send those bids, so it learns "you're leading" and its own
   *    `myMaxMinor` from the authoritative view rather than from the public feed.
   */
  private publish(
    events: readonly AuctionEvent[],
    previousLeader: string | null,
    personal: readonly string[] = [],
  ): void {
    let leader = previousLeader;
    const everLeading = new Set<string>(previousLeader === null ? [] : [previousLeader]);
    const snapshotFor = new Set(personal);
    let lastBid = -1;
    events.forEach((e, i) => {
      if (e.type === "bid.accepted") lastBid = i;
      else if (
        e.type === "auction.started" ||
        e.type === "auction.extended" ||
        e.type === "auction.ended" ||
        e.type === "auction.cancelled"
      ) {
        this.metric({
          event: "auction_lifecycle",
          // started | extended | ended:<SOLD|RESERVE_NOT_MET|NO_BIDS> | cancelled (bounded)
          outcome:
            e.type === "auction.ended"
              ? `ended:${(e as { outcome?: string }).outcome ?? ""}`
              : e.type.slice("auction.".length),
          // How late the transition was committed vs its deadline (alarm/lazy-close delay).
          durationMs:
            e.type === "auction.ended" ? Math.max(0, e.at - (this.cached?.closesAt ?? e.at)) : 0,
          count: 1,
        });
      }
    });
    events.forEach((e, i) => {
      const pub = toPublicEvent(e, (uid) => this.pseudonymOf(uid));
      if (pub) this.send("all", { protocolVersion: WS_PROTOCOL_VERSION, ...pub });
      if (e.type !== "bid.accepted") return;
      leader = e.userId;
      everLeading.add(e.userId);
      if (e.kind === "PROXY") snapshotFor.add(e.userId);
      if (i !== lastBid) return;
      for (const u of everLeading) {
        if (u === leader) continue;
        this.send(`user:${u}`, {
          protocolVersion: WS_PROTOCOL_VERSION,
          type: "you.outbid",
          seq: e.seq,
          currentPriceMinor: e.amountMinor,
          minNextBidMinor: e.minNextBidMinor,
        });
      }
    });
    const state = snapshotFor.size > 0 ? this.load() : null;
    if (state) {
      for (const u of snapshotFor) {
        for (const ws of this.ctx.getWebSockets(`user:${u}`)) {
          try {
            this.sendSnapshot(ws, state, u);
          } catch {
            // A broken socket never fails a committed command; the client resyncs on reconnect.
          }
        }
      }
    }
    if (events.length > 0) this.ctx.waitUntil(this.drainOutbox());
  }

  private send(tag: string, msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(data);
      } catch {
        // A broken socket never fails a committed command; the client resyncs on reconnect.
      }
    }
  }
}
