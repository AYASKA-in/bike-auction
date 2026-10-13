import type { PublicAuctionView, PublicBid, WsServerMessage } from "@bike/contracts";

/**
 * Client-side live auction state (pure, framework-free; driven by `LiveFeed`).
 *
 * The Durable Object is the source of truth. This reducer never guesses a price or a leader:
 * - snapshot: replaces the view, sets lastSeq = view.seq, marks history for reload
 * - event with seq === lastSeq + 1: applied
 * - event with seq <= lastSeq: duplicate / out of date → ignored (same object returned)
 * - event with seq > lastSeq + 1: GAP → status "stale"; the feed asks for a fresh snapshot
 * - HTTP view ("seed"): applied only if its seq >= lastSeq (an older read never wins)
 *
 * "You're leading" comes from three authoritative sources only: a snapshot's `viewer`, an HTTP
 * view's `viewer`, or our own 201 bid response whose seq is the latest applied bid.
 */
export type ConnStatus = "connecting" | "live" | "stale" | "reconnecting" | "offline" | "failed";

export type Outbid = { currentPriceMinor: number; minNextBidMinor: number };

export type LiveState = {
  auctionId: string | null;
  status: ConnStatus;
  view: PublicAuctionView | null;
  lastSeq: number;
  serverOffsetMs: number;
  outbid: Outbid | null;
  /** Seqs of bids this viewer placed (from 201 responses and `isYou` history rows). */
  ownSeqs: readonly number[];
  /** Seq of the latest bid applied incrementally; null after a snapshot (snapshot is authoritative). */
  leaderSeq: number | null;
  /** Accepted bids, newest first, unique by seq. */
  bids: readonly PublicBid[];
  /** Cursor for older bids: undefined = not loaded yet, null = no more. */
  olderCursor: number | null | undefined;
  /** History must be (re)loaded: set when lastSeq jumped (snapshot / newer HTTP view). */
  historyDirty: boolean;
  /** Local time of the last authoritative update (socket message or HTTP view). */
  syncedAt: number | null;
};

export const initialLive: LiveState = {
  auctionId: null,
  status: "connecting",
  view: null,
  lastSeq: 0,
  serverOffsetMs: 0,
  outbid: null,
  ownSeqs: [],
  leaderSeq: null,
  bids: [],
  olderCursor: undefined,
  historyDirty: false,
  syncedAt: null,
};

export const initialFor = (auctionId: string): LiveState => ({ ...initialLive, auctionId });

export type LiveAction =
  | { kind: "msg"; msg: WsServerMessage; at: number }
  | { kind: "seed"; view: PublicAuctionView; at: number }
  | { kind: "conn"; status: ConnStatus }
  | { kind: "ownBid"; seq: number; bidId: string; amountMinor: number; at: number }
  | { kind: "history"; items: readonly PublicBid[]; nextBeforeSeq: number | null; older: boolean };

const MAX_BIDS = 200;

function mergeBids(a: readonly PublicBid[], b: readonly PublicBid[]): PublicBid[] {
  const bySeq = new Map<number, PublicBid>();
  for (const x of a) bySeq.set(x.seq, x);
  for (const x of b) {
    const prev = bySeq.get(x.seq);
    bySeq.set(x.seq, prev ? { ...x, isYou: x.isYou || prev.isYou } : x);
  }
  return [...bySeq.values()].sort((p, q) => q.seq - p.seq).slice(0, MAX_BIDS);
}

const withSeq = (seqs: readonly number[], seq: number) =>
  seqs.includes(seq) ? seqs : [...seqs, seq].slice(-50);

/** Applies an authoritative full view (snapshot or newer HTTP view). */
function replaceView(s: LiveState, view: PublicAuctionView, at: number): LiveState {
  const wasLeading = s.view?.viewer?.isLeading === true;
  const nowLeading = view.viewer?.isLeading === true;
  let outbid = s.outbid;
  if (nowLeading || view.status !== "LIVE") outbid = null;
  else if (wasLeading && view.seq > s.lastSeq && view.currentPriceMinor !== null) {
    // We missed the events (reconnect / background tab) but the authority says someone overtook us.
    outbid = {
      currentPriceMinor: view.currentPriceMinor,
      minNextBidMinor: view.minNextBidMinor ?? view.currentPriceMinor,
    };
  }
  return {
    ...s,
    view,
    lastSeq: view.seq,
    leaderSeq: null,
    outbid,
    historyDirty: s.historyDirty || view.seq !== s.lastSeq || s.olderCursor === undefined,
    syncedAt: at,
  };
}

export function applyMessage(s: LiveState, m: WsServerMessage, receivedAt: number): LiveState {
  switch (m.type) {
    case "hello":
      return { ...s, serverOffsetMs: m.serverTime - receivedAt };
    case "auction.snapshot":
      if (s.auctionId !== null && m.view.auctionId !== s.auctionId) return s; // wrong auction
      return {
        ...replaceView(s, m.view, receivedAt),
        status: "live",
        serverOffsetMs: m.serverTime - receivedAt,
      };
    case "you.outbid":
      if (!s.view || m.seq < s.lastSeq) return s; // a later snapshot/event already superseded it
      return {
        ...s,
        outbid: { currentPriceMinor: m.currentPriceMinor, minNextBidMinor: m.minNextBidMinor },
        view: s.view.viewer
          ? { ...s.view, viewer: { ...s.view.viewer, isLeading: false } }
          : s.view,
      };
  }
  if (!s.view || s.status !== "live") return s; // wait for a snapshot
  if (m.seq <= s.lastSeq) return s;
  if (m.seq !== s.lastSeq + 1) return { ...s, status: "stale" };
  const v = s.view;
  const base = { ...s, lastSeq: m.seq, syncedAt: receivedAt };
  switch (m.type) {
    case "bid.accepted": {
      const mine = s.ownSeqs.includes(m.seq);
      const wasLeading = v.viewer?.isLeading === true;
      return {
        ...base,
        leaderSeq: m.seq,
        outbid: mine
          ? null
          : wasLeading
            ? { currentPriceMinor: m.amountMinor, minNextBidMinor: m.minNextBidMinor }
            : s.outbid,
        bids: mergeBids(s.bids, [
          {
            seq: m.seq,
            bidId: m.bidId,
            bidder: m.bidder,
            amountMinor: m.amountMinor,
            at: m.at,
            isYou: mine,
          },
        ]),
        view: {
          ...v,
          seq: m.seq,
          currentPriceMinor: m.amountMinor,
          minNextBidMinor: m.minNextBidMinor,
          bidCount: v.bidCount + 1,
          reserveMet: m.reserveMet,
          leadingBidder: m.bidder,
          closesAt: m.closesAt,
          viewer: v.viewer ? { ...v.viewer, isLeading: mine } : null,
        },
      };
    }
    case "auction.extended":
      return {
        ...base,
        view: { ...v, seq: m.seq, closesAt: m.closesAt, extensionCount: v.extensionCount + 1 },
      };
    case "auction.started":
      return { ...base, view: { ...v, seq: m.seq, status: "LIVE" } };
    case "auction.scheduled":
      return {
        ...base,
        view: { ...v, seq: m.seq, status: "SCHEDULED", startsAt: m.startsAt, closesAt: m.closesAt },
      };
    case "auction.cancelled":
      return {
        ...base,
        outbid: null,
        view: {
          ...v,
          seq: m.seq,
          status: "CANCELLED",
          minNextBidMinor: null,
          viewer: v.viewer ? { isLeading: false, isWinner: false } : null,
        },
      };
    case "auction.ended": {
      const won = m.outcome === "SOLD" && v.viewer?.isLeading === true;
      return {
        ...base,
        outbid: null,
        view: {
          ...v,
          seq: m.seq,
          status: "ENDED",
          outcome: m.outcome,
          minNextBidMinor: null,
          currentPriceMinor: m.finalPriceMinor,
          // The winner's public code only when sold; never for unsold outcomes.
          leadingBidder: m.outcome === "SOLD" ? m.winningBidder : v.leadingBidder,
          viewer: v.viewer ? { isLeading: v.viewer.isLeading, isWinner: won } : null,
        },
      };
    }
  }
}

export function reduceLive(s: LiveState, a: LiveAction): LiveState {
  switch (a.kind) {
    case "msg":
      return applyMessage(s, a.msg, a.at);
    case "conn":
      return s.status === a.status ? s : { ...s, status: a.status };
    case "seed":
      if (s.auctionId !== null && a.view.auctionId !== s.auctionId) return s;
      // Same seq still applies: the HTTP view carries this viewer's personal fields.
      if (s.view && a.view.seq < s.lastSeq) return s;
      return replaceView(s, a.view, a.at);
    case "ownBid": {
      const ownSeqs = withSeq(s.ownSeqs, a.seq);
      const bids = s.bids.map((b) => (b.seq === a.seq ? { ...b, isYou: true } : b));
      if (!s.view || a.seq > s.lastSeq) return { ...s, ownSeqs, bids }; // event not here yet
      const v = s.view;
      if (s.leaderSeq === a.seq && v.viewer) {
        return {
          ...s,
          ownSeqs,
          bids,
          outbid: null,
          view: { ...v, viewer: { ...v.viewer, isLeading: true } },
        };
      }
      if (s.leaderSeq !== null && s.leaderSeq > a.seq && v.viewer && v.status === "LIVE") {
        // Our bid was accepted but someone else's later bid is already applied.
        return {
          ...s,
          ownSeqs,
          bids,
          outbid: {
            currentPriceMinor: v.currentPriceMinor ?? a.amountMinor,
            minNextBidMinor: v.minNextBidMinor ?? a.amountMinor,
          },
          view: { ...v, viewer: { ...v.viewer, isLeading: false } },
        };
      }
      return { ...s, ownSeqs, bids }; // a snapshot already gave the authoritative answer
    }
    case "history": {
      let ownSeqs = s.ownSeqs;
      for (const b of a.items) if (b.isYou) ownSeqs = withSeq(ownSeqs, b.seq);
      // Rows newer than lastSeq are fine to show (they're committed); the view catches up via events.
      return {
        ...s,
        ownSeqs,
        bids: mergeBids(s.bids, a.items),
        olderCursor: a.older || s.olderCursor === undefined ? a.nextBeforeSeq : s.olderCursor,
        historyDirty: a.older ? s.historyDirty : false,
      };
    }
  }
}

/** True when the shown numbers might be behind the authority. */
export const isPossiblyStale = (s: LiveState) => s.status !== "live";
