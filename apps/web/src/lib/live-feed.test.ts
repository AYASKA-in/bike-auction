import {
  WS_PING,
  WS_PONG,
  WS_RESYNC,
  type BidHistoryPage,
  type PublicAuctionView,
} from "@bike/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireFeed,
  backoffDelay,
  FEED,
  LiveFeed,
  openFeedCount,
  releaseFeed,
  type FeedDeps,
  type SocketLike,
} from "./live-feed";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number | undefined } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.closed = { code };
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(m: unknown) {
    this.onmessage?.({
      data: typeof m === "string" ? m : JSON.stringify({ protocolVersion: 1, ...(m as object) }),
    });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const view = (over: Partial<PublicAuctionView> = {}): PublicAuctionView => ({
  auctionId: "auc-1",
  status: "LIVE",
  outcome: null,
  startsAt: 0,
  closesAt: Date.now() + 3_600_000,
  startPriceMinor: 100,
  currentPriceMinor: null,
  minNextBidMinor: 100,
  bidCount: 0,
  hasReserve: false,
  reserveMet: false,
  leadingBidder: null,
  extensionCount: 0,
  seq: 5,
  viewer: null,
  ...over,
});
const snapshot = (v = view()) => ({ type: "auction.snapshot", serverTime: Date.now(), view: v });
const bid = (seq: number, amount: number) => ({
  type: "bid.accepted",
  seq,
  bidId: `b${seq}`,
  bidder: "Bidder AAAA",
  amountMinor: amount,
  at: Date.now(),
  closesAt: Date.now() + 3_600_000,
  minNextBidMinor: amount + 100,
  reserveMet: false,
});

function harness(opts: { online?: boolean; history?: BidHistoryPage } = {}) {
  const sockets: FakeSocket[] = [];
  const handlers = new Map<string, Set<() => void>>();
  let online = opts.online ?? true;
  let visible = true;
  const fetchHistory = vi.fn(async () => opts.history ?? { items: [], nextBeforeSeq: null });
  const deps: FeedDeps = {
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    url: (id) => `ws://test/api/v1/auctions/${id}/stream`,
    fetchHistory,
    now: () => Date.now(),
    random: () => 0.5,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    isOnline: () => online,
    isVisible: () => visible,
    on: (type, fn) => {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
      return () => set.delete(fn);
    },
  };
  const emit = (type: string) => handlers.get(type)?.forEach((fn) => fn());
  return {
    deps,
    sockets,
    fetchHistory,
    last: () => sockets.at(-1)!,
    emit,
    listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    setOnline: (v: boolean) => {
      online = v;
      emit(v ? "online" : "offline");
    },
    setVisible: (v: boolean) => {
      visible = v;
      emit("visibilitychange");
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LiveFeed connection lifecycle", () => {
  it("connects (cookie auth only: no token in the URL), goes live on snapshot, loads history", async () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe("ws://test/api/v1/auctions/auc-1/stream");
    expect(f.getState().status).toBe("connecting");
    h.last().open();
    h.last().recv(snapshot());
    expect(f.getState()).toMatchObject({ status: "live", lastSeq: 5 });
    await vi.runOnlyPendingTimersAsync();
    expect(h.fetchHistory).toHaveBeenCalledWith("auc-1", null);
    f.stop();
  });

  it("reconnects with growing, capped, jittered delays and recovers on snapshot", () => {
    expect([1, 2, 3, 4, 10].map((n) => backoffDelay(n, 1))).toEqual([
      500, 1000, 2000, 4000, 30_000,
    ]);
    expect(backoffDelay(3, 0)).toBe(1000); // jitter keeps 50–100 %
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv(snapshot());
    h.last().drop(); // server restart / Wi-Fi blip
    expect(f.getState().status).toBe("reconnecting");
    expect(f.getState().view?.seq).toBe(5); // last known price stays visible
    vi.advanceTimersByTime(backoffDelay(1, 0.5) - 1);
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(2);
    h.last().drop();
    vi.advanceTimersByTime(backoffDelay(2, 0.5));
    expect(h.sockets).toHaveLength(3);
    h.last().open();
    h.last().recv(snapshot(view({ seq: 9, currentPriceMinor: 900, bidCount: 4 })));
    expect(f.getState()).toMatchObject({ status: "live", lastSeq: 9 });
    h.last().drop(); // attempts were reset by the snapshot: first delay again
    vi.advanceTimersByTime(backoffDelay(1, 0.5));
    expect(h.sockets).toHaveLength(4);
    f.stop();
  });

  it("reports 'failed' after repeated failures but keeps retrying; Retry now skips the wait", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    for (let i = 1; i <= FEED.failAfter; i++) {
      h.last().drop();
      vi.advanceTimersByTime(backoffDelay(i, 0.5));
    }
    expect(f.getState().status).toBe("failed");
    const before = h.sockets.length;
    h.last().drop();
    f.retryNow();
    expect(h.sockets.length).toBe(before + 1);
    expect(f.getState().status).toBe("connecting");
    f.stop();
  });

  it("offline: closes, doesn't retry; online: reconnects immediately and resyncs", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv(snapshot());
    h.setOnline(false);
    expect(f.getState().status).toBe("offline");
    expect(h.last().closed).not.toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1); // no pointless retries while offline
    h.setOnline(true);
    expect(h.sockets).toHaveLength(2);
    expect(f.getState().status).toBe("connecting");
    h.last().open();
    h.last().recv(snapshot(view({ seq: 7 })));
    expect(f.getState().status).toBe("live");
    f.stop();
  });

  it("starting while offline waits for 'online'", () => {
    const h = harness({ online: false });
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    expect(h.sockets).toHaveLength(0);
    expect(f.getState().status).toBe("offline");
    h.setOnline(true);
    expect(h.sockets).toHaveLength(1);
    f.stop();
  });

  it("tab visible again: resync on a healthy socket, immediate reconnect on a dead one", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv(snapshot());
    h.setVisible(false);
    h.setVisible(true);
    expect(h.last().sent).toContain(WS_RESYNC);
    h.last().recv(snapshot()); // answered
    h.last().drop(); // mobile OS killed it while backgrounded
    h.setVisible(false);
    h.setVisible(true);
    expect(h.sockets).toHaveLength(2); // no back-off wait
    f.stop();
  });

  it("heartbeat: pings, and reconnects a half-open socket that stopped talking", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv(snapshot());
    vi.advanceTimersByTime(FEED.pingEveryMs);
    expect(h.last().sent).toContain(WS_PING);
    h.last().recv(WS_PONG);
    vi.advanceTimersByTime(FEED.pingEveryMs);
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(FEED.deadAfterMs); // silence
    expect(h.sockets[0]!.closed).not.toBeNull();
    vi.advanceTimersByTime(backoffDelay(1, 0.5));
    expect(h.sockets).toHaveLength(2);
    f.stop();
  });

  it("seq gap → resync request; no snapshot within the timeout → reconnect", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv(snapshot());
    h.last().recv(bid(7, 700)); // 6 is missing
    expect(f.getState().status).toBe("stale");
    expect(h.last().sent.filter((m) => m === WS_RESYNC)).toHaveLength(1);
    h.last().recv(bid(8, 800)); // still stale: no duplicate resync request
    expect(h.last().sent.filter((m) => m === WS_RESYNC)).toHaveLength(1);
    vi.advanceTimersByTime(FEED.resyncTimeoutMs);
    expect(h.sockets[0]!.closed).not.toBeNull();
    vi.advanceTimersByTime(backoffDelay(1, 0.5));
    h.last().open();
    h.last().recv(snapshot(view({ seq: 8, currentPriceMinor: 800, bidCount: 3 })));
    expect(f.getState()).toMatchObject({ status: "live", lastSeq: 8 });
    f.stop();
  });

  it("deadline passed locally → asks the server (never ends the auction itself)", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv({ type: "hello", serverTime: Date.now() });
    h.last().recv(snapshot(view({ closesAt: Date.now() + 10_000 })));
    vi.advanceTimersByTime(10_000 + FEED.deadlineGraceMs);
    expect(h.last().sent).toContain(WS_RESYNC);
    expect(f.getState().view?.status).toBe("LIVE"); // still LIVE until the server says otherwise
    h.last().recv({
      type: "auction.ended",
      seq: 6,
      outcome: "NO_BIDS",
      finalPriceMinor: null,
      winningBidder: null,
      endedAt: Date.now(),
    });
    expect(f.getState().view?.status).toBe("ENDED");
    f.stop();
  });

  it("ignores garbage, unknown message types and messages from a replaced socket", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    const first = h.last();
    first.open();
    first.recv("not json");
    first.recv({ type: "something.new", seq: 1 });
    expect(f.getState().view).toBeNull();
    first.drop();
    vi.advanceTimersByTime(backoffDelay(1, 0.5));
    first.recv(snapshot(view({ seq: 99 }))); // late message from the dead socket
    expect(f.getState().view).toBeNull();
    f.stop();
  });

  it("stop(): closes the socket, removes listeners, cancels timers (no reconnect after leaving)", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv(snapshot());
    expect(h.listenerCount()).toBe(4);
    f.stop();
    expect(h.last().closed?.code).toBe(1000);
    expect(h.listenerCount()).toBe(0);
    h.setOnline(true);
    vi.advanceTimersByTime(600_000);
    expect(h.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("registry: one socket per auction view", () => {
  it("shares a feed between components, survives a StrictMode remount, closes when the last leaves", () => {
    const h = harness();
    const a = acquireFeed("auc-r", h.deps);
    const b = acquireFeed("auc-r", h.deps);
    expect(a).toBe(b);
    expect(h.sockets).toHaveLength(1);
    releaseFeed("auc-r", h.deps);
    releaseFeed("auc-r", h.deps);
    const again = acquireFeed("auc-r", h.deps); // remount in the same tick
    expect(again).toBe(a);
    expect(h.sockets).toHaveLength(1);
    releaseFeed("auc-r", h.deps);
    vi.advanceTimersByTime(1);
    expect(a.isDisposed).toBe(true);
    expect(h.sockets[0]!.closed).not.toBeNull();
    expect(openFeedCount()).toBe(0);
  });

  it("different auctions get different sockets; switching tabs between auctions doesn't leak", () => {
    const h = harness();
    acquireFeed("auc-x", h.deps);
    acquireFeed("auc-y", h.deps);
    expect(h.sockets.map((s) => s.url)).toEqual([
      "ws://test/api/v1/auctions/auc-x/stream",
      "ws://test/api/v1/auctions/auc-y/stream",
    ]);
    releaseFeed("auc-x", h.deps);
    releaseFeed("auc-y", h.deps);
    vi.advanceTimersByTime(1);
    expect(openFeedCount()).toBe(0);
  });
});

describe("own bids and HTTP views", () => {
  it("noteOwnBid marks leading once the event is applied; an older HTTP view is ignored", () => {
    const h = harness();
    const f = new LiveFeed("auc-1", h.deps);
    f.start();
    h.last().open();
    h.last().recv(snapshot(view({ viewer: { isLeading: false, isWinner: false } })));
    f.noteOwnBid({ bidId: "b6", seq: 6, amountMinor: 600, closesAt: 1, minNextBidMinor: 700 });
    h.last().recv(bid(6, 600));
    expect(f.getState().view?.viewer?.isLeading).toBe(true);
    f.seed(view({ seq: 5 })); // a slow HTTP response from before the bid
    expect(f.getState().view?.currentPriceMinor).toBe(600);
    f.stop();
  });
});
