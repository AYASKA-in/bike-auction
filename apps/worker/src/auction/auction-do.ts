import { DurableObject } from "cloudflare:workers";
import { WS_PING, WS_PONG, WS_PROTOCOL_VERSION, type WsServerMessage } from "@bike/contracts";
import { isValidAmount, minNextBid } from "@bike/domain";
import { createLogger, errorFields } from "../lib/logger";
import { migrateAuctionSchema } from "./schema";

/**
 * Day-1 AuctionDO: the authoritative coordinator for ONE auction.
 *
 * Proven on Day 1 (see docs/spike-results.md):
 *  - SQLite-backed persistent state, reloaded after eviction.
 *  - Atomic bid commit with no awaits in the critical section.
 *  - Commits succeed while D1 is unavailable; the outbox catches D1 up later.
 *  - Alarm multiplexer over a `timers` table (a DO has exactly one alarm).
 *  - Hibernatable WebSockets with auto-responded heartbeats.
 *
 * The full auction engine (lifecycle, reserve, soft close, idempotency, proxy bids) moves into
 * the pure `@bike/domain` package on Day 3 and is invoked from here on Day 4.
 */

export type AuctionStatus = "DRAFT" | "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";

export type AuctionSnapshot = {
  auctionId: string;
  status: AuctionStatus;
  startPriceMinor: number;
  currentPriceMinor: number | null;
  minNextBidMinor: number;
  leaderUserId: string | null;
  bidCount: number;
  closesAt: number;
  seq: number;
  serverTime: number;
};

export type PlaceBidCommand = { bidId: string; userId: string; amountMinor: number };

export type PlaceBidResult =
  | { ok: true; seq: number; amountMinor: number; minNextBidMinor: number; closesAt: number }
  | {
      ok: false;
      code:
        "NOT_FOUND" | "AUCTION_NOT_LIVE" | "AUCTION_ENDED" | "BID_TOO_LOW" | "VALIDATION_FAILED";
      minNextBidMinor?: number;
    };

type StateRow = {
  auction_id: string;
  status: AuctionStatus;
  start_price_minor: number;
  current_price_minor: number | null;
  leader_user_id: string | null;
  bid_count: number;
  closes_at: number;
  seq: number;
};

export type TimerKind = "close" | "outbox";

const OUTBOX_MAX_BACKOFF_MS = 60_000;
const MAX_CLIENT_MESSAGES = 20;

export class AuctionDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly log = createLogger({ component: "AuctionDO" });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The constructor completes before any request or alarm is delivered, and SQL calls are
    // synchronous, so the schema is guaranteed current for every handler.
    migrateAuctionSchema(ctx.storage);
    // Heartbeats are answered by the runtime without waking a hibernated object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_PING, WS_PONG));
  }

  // ───────────────────────────── RPC: lifecycle (Day-1 minimal) ─────────────────────────────

  /** Idempotent: creating an auction that already exists returns the existing snapshot. */
  initialize(input: {
    auctionId: string;
    startPriceMinor: number;
    closesAt: number;
  }): AuctionSnapshot {
    if (!isValidAmount(input.startPriceMinor)) throw new Error("Invalid start price");
    const existing = this.readState();
    if (!existing) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO state (id, auction_id, status, start_price_minor, current_price_minor,
                              leader_user_id, bid_count, closes_at, seq)
           VALUES (1, ?, 'LIVE', ?, NULL, NULL, 0, ?, 1)`,
          input.auctionId,
          input.startPriceMinor,
          input.closesAt,
        );
        this.appendOutbox(1, "auction.created");
        this.setTimer("close", input.closesAt);
      });
      this.setTimer("outbox", Date.now());
    }
    return this.snapshot();
  }

  getSnapshot(): AuctionSnapshot | null {
    return this.readState() ? this.snapshot() : null;
  }

  // ───────────────────────────── RPC: commands ─────────────────────────────

  /**
   * The critical section. Everything from reading state to committing is synchronous: there is
   * no `await` between the check and the write, so no other event can interleave. Network I/O
   * (D1 projection, broadcasts) happens strictly after commit.
   */
  placeBid(cmd: PlaceBidCommand): PlaceBidResult {
    if (!isValidAmount(cmd.amountMinor)) return { ok: false, code: "VALIDATION_FAILED" };
    this.maybeClose(Date.now()); // lazy close: correctness never depends on alarm timing
    const s = this.readState();
    if (!s) return { ok: false, code: "NOT_FOUND" };
    if (s.status === "ENDED") return { ok: false, code: "AUCTION_ENDED" };
    if (s.status !== "LIVE") return { ok: false, code: "AUCTION_NOT_LIVE" };

    const required = minNextBid({
      startPriceMinor: s.start_price_minor,
      currentPriceMinor: s.current_price_minor,
    });
    if (cmd.amountMinor < required) {
      return { ok: false, code: "BID_TOO_LOW", minNextBidMinor: required };
    }

    const seq = s.seq + 1;
    const at = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO bids (seq, bid_id, user_id, amount_minor, at) VALUES (?, ?, ?, ?, ?)`,
        seq,
        cmd.bidId,
        cmd.userId,
        cmd.amountMinor,
        at,
      );
      this.sql.exec(
        `UPDATE state SET current_price_minor = ?, leader_user_id = ?, bid_count = bid_count + 1,
                          seq = ? WHERE id = 1`,
        cmd.amountMinor,
        cmd.userId,
        seq,
      );
      this.appendOutbox(seq, "bid.accepted");
    });
    // ── committed ──
    const next = minNextBid({
      startPriceMinor: s.start_price_minor,
      currentPriceMinor: cmd.amountMinor,
    });
    this.broadcast({
      protocolVersion: WS_PROTOCOL_VERSION,
      type: "bid.accepted",
      seq,
      bidId: cmd.bidId,
      bidder: "Bidder", // per-auction HMAC pseudonyms arrive with the domain engine (Day 3-4)
      amountMinor: cmd.amountMinor,
      at,
      closesAt: s.closes_at,
      minNextBidMinor: next,
    });
    this.setTimer("outbox", Date.now());
    this.ctx.waitUntil(this.drainOutbox());
    return {
      ok: true,
      seq,
      amountMinor: cmd.amountMinor,
      minNextBidMinor: next,
      closesAt: s.closes_at,
    };
  }

  /** Ops action (runbook: "projection lag"): attempt to project pending events to D1 now. */
  async retryProjection(): Promise<number> {
    await this.drainOutbox();
    return this.pendingOutbox();
  }

  /** Test/ops helper: number of outbox events not yet projected to D1. */
  pendingOutbox(): number {
    return this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE projected_at IS NULL`)
      .one().n;
  }

  /** Ops helper: the next scheduled alarm time and the timers it multiplexes. */
  async timers(): Promise<{ alarm: number | null; timers: { kind: TimerKind; dueAt: number }[] }> {
    const timers = this.sql
      .exec<{ kind: TimerKind; due_at: number }>(`SELECT kind, due_at FROM timers ORDER BY due_at`)
      .toArray()
      .map((r) => ({ kind: r.kind, dueAt: r.due_at }));
    return { alarm: await this.ctx.storage.getAlarm(), timers };
  }

  // ───────────────────────────── Alarm multiplexer ─────────────────────────────

  /**
   * A Durable Object has ONE alarm; setAlarm() overwrites. All deadlines live in the `timers`
   * table and the single alarm is always set to the earliest one.
   * Alarms are at-least-once and retried at most 6 times, so every handler is idempotent and the
   * alarm is always rescheduled in `finally`, even after an error.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.sql
      .exec<{ kind: TimerKind }>(`SELECT kind FROM timers WHERE due_at <= ? ORDER BY due_at`, now)
      .toArray();
    try {
      for (const { kind } of due) {
        this.clearTimer(kind);
        if (kind === "close") this.maybeClose(now);
        else if (kind === "outbox") await this.drainOutbox();
      }
    } catch (err) {
      this.log.error("auction.alarm_failed", errorFields(err));
    } finally {
      this.rescheduleAlarm();
    }
  }

  private setTimer(kind: TimerKind, dueAt: number): void {
    this.sql.exec(
      `INSERT INTO timers (kind, due_at) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET due_at = excluded.due_at`,
      kind,
      dueAt,
    );
    this.rescheduleAlarm();
  }

  private clearTimer(kind: TimerKind): void {
    this.sql.exec(`DELETE FROM timers WHERE kind = ?`, kind);
  }

  private rescheduleAlarm(): void {
    const next = this.sql.exec<{ m: number | null }>(`SELECT MIN(due_at) AS m FROM timers`).one().m;
    // Storage writes are ordered by the runtime's output gate; awaiting is unnecessary here.
    void (next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(next));
  }

  // ───────────────────────────── Lifecycle ─────────────────────────────

  private maybeClose(now: number): void {
    const s = this.readState();
    if (!s || s.status !== "LIVE" || now < s.closes_at) return;
    const seq = s.seq + 1;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE state SET status = 'ENDED', seq = ? WHERE id = 1`, seq);
      this.appendOutbox(seq, "auction.ended");
      this.clearTimer("close");
    });
    this.setTimer("outbox", now);
  }

  // ───────────────────────────── Outbox → D1 projection ─────────────────────────────

  private appendOutbox(seq: number, type: string): void {
    this.sql.exec(
      `INSERT INTO outbox (event_id, seq, type, created_at) VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(),
      seq,
      type,
      Date.now(),
    );
  }

  /**
   * Projects the current snapshot into D1. Idempotent and monotonic: D1 only accepts a row whose
   * projection_seq is newer, so replays and out-of-order attempts are harmless. Only outbox rows
   * up to the projected seq are marked done, because state may advance while we await D1.
   */
  private async drainOutbox(): Promise<void> {
    const s = this.readState();
    if (!s || this.pendingOutbox() === 0) {
      this.clearTimer("outbox");
      this.rescheduleAlarm();
      return;
    }
    try {
      await this.env.DB.prepare(
        `INSERT INTO auctions_rm (id, status, current_price_minor, bid_count, closes_at, projection_seq, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, current_price_minor = excluded.current_price_minor,
           bid_count = excluded.bid_count, closes_at = excluded.closes_at,
           projection_seq = excluded.projection_seq, updated_at = excluded.updated_at
         WHERE excluded.projection_seq > auctions_rm.projection_seq`,
      )
        .bind(
          s.auction_id,
          s.status,
          s.current_price_minor,
          s.bid_count,
          s.closes_at,
          s.seq,
          Date.now(),
        )
        .run();
      this.sql.exec(
        `UPDATE outbox SET projected_at = ? WHERE projected_at IS NULL AND seq <= ?`,
        Date.now(),
        s.seq,
      );
      if (this.pendingOutbox() === 0) this.clearTimer("outbox");
      else this.setTimer("outbox", Date.now());
      this.rescheduleAlarm();
    } catch (err) {
      const attempts = this.sql
        .exec<{ a: number }>(
          `UPDATE outbox SET attempts = attempts + 1 WHERE projected_at IS NULL RETURNING attempts AS a`,
        )
        .toArray()
        .reduce((m, r) => Math.max(m, r.a), 0);
      const backoff = Math.min(OUTBOX_MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 6));
      this.log.warn("auction.projection_failed", {
        ...errorFields(err),
        attempts,
        backoffMs: backoff,
      });
      this.setTimer("outbox", Date.now() + backoff);
    }
  }

  // ───────────────────────────── WebSockets (hibernation API) ─────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const userId = request.headers.get("x-user-id");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Tags let us target one user's sockets later (e.g. "you were outbid").
    this.ctx.acceptWebSocket(server, ["all", userId ? `user:${userId}` : "anon"]);
    server.serializeAttachment({ userId, connectedAt: Date.now(), messages: 0 });
    server.send(
      JSON.stringify({
        protocolVersion: WS_PROTOCOL_VERSION,
        type: "hello",
        serverTime: Date.now(),
      }),
    );
    const snap = this.getSnapshot();
    if (snap)
      server.send(
        JSON.stringify({ protocolVersion: WS_PROTOCOL_VERSION, type: "auction.snapshot", ...snap }),
      );
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The feed is server→client only. Heartbeats never reach here (auto-response). */
  override webSocketMessage(ws: WebSocket): void {
    const att = (ws.deserializeAttachment() ?? {}) as { messages?: number };
    const messages = (att.messages ?? 0) + 1;
    ws.serializeAttachment({ ...att, messages });
    if (messages > MAX_CLIENT_MESSAGES) ws.close(1008, "Read-only feed");
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  connectionCount(): number {
    return this.ctx.getWebSockets("all").length;
  }

  private broadcast(msg: WsServerMessage | Record<string, unknown>, tag = "all"): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(data);
      } catch {
        // A broken socket must never fail a committed command; the client resyncs on reconnect.
      }
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private readState(): StateRow | null {
    return this.sql.exec<StateRow>(`SELECT * FROM state WHERE id = 1`).toArray()[0] ?? null;
  }

  private snapshot(): AuctionSnapshot {
    const s = this.readState();
    if (!s) throw new Error("Auction not initialized");
    return {
      auctionId: s.auction_id,
      status: s.status,
      startPriceMinor: s.start_price_minor,
      currentPriceMinor: s.current_price_minor,
      minNextBidMinor: minNextBid({
        startPriceMinor: s.start_price_minor,
        currentPriceMinor: s.current_price_minor,
      }),
      leaderUserId: s.leader_user_id,
      bidCount: s.bid_count,
      closesAt: s.closes_at,
      seq: s.seq,
      serverTime: Date.now(),
    };
  }
}
