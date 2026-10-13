import {
  WS_PING,
  WS_PONG,
  WS_RESYNC,
  WsServerMessage,
  type BidHistoryPage,
  type PlaceBidResult,
  type PublicAuctionView,
} from "@bike/contracts";
import { initialFor, reduceLive, type LiveAction, type LiveState } from "./live-auction";

/**
 * One live connection per auction, framework-free (React binds to it via useSyncExternalStore).
 *
 * - Connects to /api/v1/auctions/:id/stream (session cookie only; no tokens in the URL).
 * - Reconnects with exponential back-off + jitter (0.5 s … 30 s); "failed" after 6 attempts in a
 *   row (it keeps retrying at the cap, and `retryNow()` skips the wait).
 * - Browser offline → closes and waits for "online" (no pointless retries); online → reconnects now.
 * - Tab visible again / page restored from bfcache → reconnects now, or asks for a fresh snapshot.
 * - Heartbeat: a ping every 20 s; no message for 45 s means a dead (half-open) socket → reconnect.
 * - Seq gap → resync; no snapshot within 5 s → reconnect.
 * - Deadline passed locally → resync (the DO resolves due starts/closes on resync). The local clock
 *   never ends an auction; only the server's `auction.ended` does.
 * - Every snapshot / jump in seq reloads the latest bid page and merges it (dedupe by seq).
 */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type FeedDeps = {
  createSocket(url: string): SocketLike;
  url(auctionId: string): string;
  fetchHistory(auctionId: string, beforeSeq: number | null): Promise<BidHistoryPage>;
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  isOnline(): boolean;
  isVisible(): boolean;
  /** Subscribe to a window/document event ("online", "offline", "visibilitychange", "pageshow"). */
  on(type: string, fn: () => void): () => void;
};

const OPEN = 1;
export const FEED = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  failAfter: 6,
  pingEveryMs: 20_000,
  deadAfterMs: 45_000,
  resyncTimeoutMs: 5_000,
  deadlineGraceMs: 1_500,
  historyPage: 20,
} as const;

export class LiveFeed {
  private state: LiveState;
  private readonly listeners = new Set<() => void>();
  private ws: SocketLike | null = null;
  private attempts = 0;
  private disposed = false;
  private started = false;
  private lastMessageAt = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private resyncTimer: unknown = null;
  private deadlineTimer: unknown = null;
  private deadlineKey = "";
  private historyLoading = false;
  private olderLoading = false;
  private offs: (() => void)[] = [];

  constructor(
    readonly auctionId: string,
    private readonly deps: FeedDeps,
  ) {
    this.state = initialFor(auctionId);
  }

  // --- store API -------------------------------------------------------------------------------
  getState = (): LiveState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private dispatch(a: LiveAction): void {
    const next = reduceLive(this.state, a);
    if (next === this.state) return;
    this.state = next;
    this.afterChange();
    for (const l of this.listeners) l();
  }

  // --- lifecycle -------------------------------------------------------------------------------
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const d = this.deps;
    this.offs = [
      d.on("online", () => this.wake(true)),
      d.on("offline", () => this.goOffline()),
      d.on("visibilitychange", () => d.isVisible() && this.wake(false)),
      d.on("pageshow", () => this.wake(false)),
    ];
    this.connect();
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.clearTimers();
    this.dropSocket(1000, "page closed");
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Skip the back-off wait (the "Retry now" button). */
  retryNow(): void {
    this.attempts = 0;
    this.wake(true);
  }

  // --- inputs from HTTP ------------------------------------------------------------------------
  seed(view: PublicAuctionView): void {
    this.dispatch({ kind: "seed", view, at: this.deps.now() });
  }

  noteOwnBid(r: PlaceBidResult): void {
    this.dispatch({
      kind: "ownBid",
      seq: r.seq,
      bidId: r.bidId,
      amountMinor: r.amountMinor,
      at: this.deps.now(),
    });
  }

  async loadOlder(): Promise<void> {
    const cursor = this.state.olderCursor;
    if (this.olderLoading || cursor === null || cursor === undefined) return;
    this.olderLoading = true;
    try {
      const page = await this.deps.fetchHistory(this.auctionId, cursor);
      if (!this.disposed)
        this.dispatch({
          kind: "history",
          items: page.items,
          nextBeforeSeq: page.nextBeforeSeq,
          older: true,
        });
    } finally {
      this.olderLoading = false;
    }
  }

  // --- socket ----------------------------------------------------------------------------------
  private connect(): void {
    if (this.disposed || this.ws) return;
    if (!this.deps.isOnline()) {
      this.dispatch({ kind: "conn", status: "offline" });
      return;
    }
    this.dispatch({
      kind: "conn",
      status:
        this.attempts >= FEED.failAfter
          ? "failed"
          : this.attempts > 0
            ? "reconnecting"
            : "connecting",
    });
    let ws: SocketLike;
    try {
      ws = this.deps.createSocket(this.deps.url(this.auctionId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastMessageAt = this.deps.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastMessageAt = this.deps.now();
      this.armHeartbeat();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return; // late message from a socket we already replaced
      this.lastMessageAt = this.deps.now();
      if (typeof ev.data !== "string" || ev.data === WS_PONG) return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const parsed = WsServerMessage.safeParse(raw);
      if (!parsed.success) return; // unknown/newer message type: ignore safely
      const msg = parsed.data;
      this.dispatch({ kind: "msg", msg, at: this.deps.now() });
      if (msg.type === "auction.snapshot") {
        this.attempts = 0;
        this.clear("resyncTimer");
      }
    };
    ws.onerror = () => {}; // a close event always follows
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clear("heartbeatTimer");
      this.clear("resyncTimer");
      if (!this.disposed) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.clear("reconnectTimer");
    if (!this.deps.isOnline()) {
      this.dispatch({ kind: "conn", status: "offline" });
      return;
    }
    this.attempts += 1;
    this.dispatch({
      kind: "conn",
      status: this.attempts >= FEED.failAfter ? "failed" : "reconnecting",
    });
    this.reconnectTimer = this.deps.setTimeout(
      () => {
        this.reconnectTimer = null;
        this.connect();
      },
      backoffDelay(this.attempts, this.deps.random()),
    );
  }

  private dropSocket(code = 1000, reason = ""): void {
    const ws = this.ws;
    this.ws = null;
    this.clear("heartbeatTimer");
    this.clear("resyncTimer");
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  /** Reconnect immediately (network back, tab visible again, dead socket, failed resync). */
  private wake(resetBackoff: boolean): void {
    if (this.disposed) return;
    if (resetBackoff) this.attempts = 0;
    if (this.ws && this.ws.readyState === OPEN) {
      this.requestResync(); // catch up on anything missed while in the background
      return;
    }
    if (this.ws) return; // still connecting
    this.clear("reconnectTimer");
    this.connect();
  }

  private goOffline(): void {
    this.clear("reconnectTimer");
    this.dropSocket(1000, "offline");
    this.dispatch({ kind: "conn", status: "offline" });
  }

  private forceReconnect(): void {
    this.dropSocket(4000, "reconnect");
    if (!this.disposed) this.scheduleReconnect();
  }

  requestResync(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    if (this.resyncTimer !== null) return; // one outstanding request is enough
    try {
      ws.send(WS_RESYNC);
    } catch {
      this.forceReconnect();
      return;
    }
    this.resyncTimer = this.deps.setTimeout(() => {
      this.resyncTimer = null;
      this.forceReconnect(); // no snapshot came back: the socket is not healthy
    }, FEED.resyncTimeoutMs);
  }

  private armHeartbeat(): void {
    this.clear("heartbeatTimer");
    this.heartbeatTimer = this.deps.setTimeout(() => {
      this.heartbeatTimer = null;
      const ws = this.ws;
      if (!ws || ws.readyState !== OPEN) return;
      if (this.deps.now() - this.lastMessageAt > FEED.deadAfterMs) {
        this.forceReconnect();
        return;
      }
      try {
        ws.send(WS_PING);
      } catch {
        this.forceReconnect();
        return;
      }
      this.armHeartbeat();
    }, FEED.pingEveryMs);
  }

  // --- reactions to state changes --------------------------------------------------------------
  private afterChange(): void {
    const s = this.state;
    if (s.status === "stale") this.requestResync();
    if (s.historyDirty) void this.loadLatestHistory();
    this.scheduleDeadline();
  }

  private async loadLatestHistory(): Promise<void> {
    if (this.historyLoading) return;
    this.historyLoading = true;
    try {
      const page = await this.deps.fetchHistory(this.auctionId, null);
      if (!this.disposed)
        this.dispatch({
          kind: "history",
          items: page.items,
          nextBeforeSeq: page.nextBeforeSeq,
          older: false,
        });
    } catch {
      // keep historyDirty; the next snapshot or seed retries
    } finally {
      this.historyLoading = false;
    }
  }

  /** When the local (server-corrected) clock passes a start/close, ask the authority. */
  private scheduleDeadline(): void {
    const v = this.state.view;
    const due = v?.status === "LIVE" ? v.closesAt : v?.status === "SCHEDULED" ? v.startsAt : null;
    const key = due === null ? "" : `${v!.status}:${due}:${this.state.lastSeq}`;
    if (key === this.deadlineKey) return;
    this.deadlineKey = key;
    this.clear("deadlineTimer");
    if (due === null) return;
    const localDue = due - this.state.serverOffsetMs;
    const wait = Math.max(0, localDue - this.deps.now()) + FEED.deadlineGraceMs;
    this.deadlineTimer = this.deps.setTimeout(
      () => {
        this.deadlineTimer = null;
        this.deadlineKey = ""; // allow a re-check if nothing changes
        this.requestResync();
        this.scheduleDeadlineRetry();
      },
      Math.min(wait, 2_147_000_000),
    );
  }

  private scheduleDeadlineRetry(): void {
    this.deadlineTimer = this.deps.setTimeout(() => {
      this.deadlineTimer = null;
      this.scheduleDeadline();
    }, FEED.resyncTimeoutMs);
  }

  private clear(name: "reconnectTimer" | "heartbeatTimer" | "resyncTimer" | "deadlineTimer"): void {
    if (this[name] !== null) this.deps.clearTimeout(this[name]);
    this[name] = null;
  }

  private clearTimers(): void {
    this.clear("reconnectTimer");
    this.clear("heartbeatTimer");
    this.clear("resyncTimer");
    this.clear("deadlineTimer");
  }
}

/** Full-jitter-ish exponential back-off: base·2^(n-1), capped, scaled to 50–100 %. */
export function backoffDelay(attempt: number, random: number): number {
  const exp = Math.min(FEED.maxDelayMs, FEED.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + random * 0.5));
}

// --- registry: one feed per auction, shared by every component on the page --------------------
const feeds = new Map<string, { feed: LiveFeed; refs: number; closeTimer: unknown }>();

export function acquireFeed(auctionId: string, deps: FeedDeps): LiveFeed {
  let entry = feeds.get(auctionId);
  if (!entry || entry.feed.isDisposed) {
    entry = { feed: new LiveFeed(auctionId, deps), refs: 0, closeTimer: null };
    feeds.set(auctionId, entry);
  }
  if (entry.closeTimer !== null) deps.clearTimeout(entry.closeTimer);
  entry.closeTimer = null;
  entry.refs += 1;
  entry.feed.start();
  return entry.feed;
}

/** Closes the socket when the last user leaves (deferred one tick so StrictMode remounts reuse it). */
export function releaseFeed(auctionId: string, deps: Pick<FeedDeps, "setTimeout">): void {
  const entry = feeds.get(auctionId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.closeTimer = deps.setTimeout(() => {
    if (entry.refs > 0) return;
    entry.feed.stop();
    feeds.delete(auctionId);
  }, 0);
}

export const openFeedCount = () => feeds.size;

/** The feed for an auction if one is open (no reference taken). */
export const peekFeed = (auctionId: string): LiveFeed | null => {
  const f = feeds.get(auctionId)?.feed;
  return f && !f.isDisposed ? f : null;
};
