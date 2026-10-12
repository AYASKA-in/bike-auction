import type { PublicAuctionView, WsServerMessage } from "@bike/contracts";

/**
 * Client-side ordering for the live feed (pure, framework-free).
 * - snapshot: replaces state, sets lastSeq = view.seq
 * - event with seq === lastSeq + 1: applied
 * - event with seq <= lastSeq: duplicate/out-of-date → ignored
 * - event with seq > lastSeq + 1: GAP → status "stale"; caller sends {"type":"resync"} (or
 *   reconnects) and disables bidding until the next snapshot arrives.
 */
export type LiveState = {
  status: "connecting" | "live" | "stale";
  view: PublicAuctionView | null;
  lastSeq: number;
  serverOffsetMs: number;
  outbid: { currentPriceMinor: number; minNextBidMinor: number } | null;
};

export const initialLive: LiveState = {
  status: "connecting",
  view: null,
  lastSeq: 0,
  serverOffsetMs: 0,
  outbid: null,
};

export function applyMessage(s: LiveState, m: WsServerMessage, receivedAt: number): LiveState {
  switch (m.type) {
    case "hello":
      return { ...s, serverOffsetMs: m.serverTime - receivedAt };
    case "auction.snapshot":
      return {
        ...s,
        status: "live",
        view: m.view,
        lastSeq: m.view.seq,
        serverOffsetMs: m.serverTime - receivedAt,
      };
    case "you.outbid":
      return {
        ...s,
        outbid: { currentPriceMinor: m.currentPriceMinor, minNextBidMinor: m.minNextBidMinor },
      };
  }
  if (!s.view || s.status !== "live") return s; // wait for a snapshot
  if (m.seq <= s.lastSeq) return s;
  if (m.seq !== s.lastSeq + 1) return { ...s, status: "stale" };
  const v = s.view;
  const base = { ...s, lastSeq: m.seq };
  switch (m.type) {
    case "bid.accepted":
      return {
        ...base,
        view: {
          ...v,
          seq: m.seq,
          currentPriceMinor: m.amountMinor,
          minNextBidMinor: m.minNextBidMinor,
          bidCount: v.bidCount + 1,
          reserveMet: m.reserveMet,
          leadingBidder: m.bidder,
          closesAt: m.closesAt,
          // Who leads is known exactly only from a snapshot; never claim "you're leading" from a broadcast.
          viewer: v.viewer ? { ...v.viewer, isLeading: false } : null,
        },
      };
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
      return { ...base, view: { ...v, seq: m.seq, status: "CANCELLED", minNextBidMinor: null } };
    case "auction.ended":
      return {
        ...base,
        view: {
          ...v,
          seq: m.seq,
          status: "ENDED",
          outcome: m.outcome,
          minNextBidMinor: null,
          currentPriceMinor: m.finalPriceMinor,
        },
      };
  }
}
