import type { PublicAuctionView } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { applyMessage, initialLive } from "./live-auction";

const view: PublicAuctionView = {
  auctionId: "auc-1",
  status: "LIVE",
  outcome: null,
  startsAt: 0,
  closesAt: 100_000,
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
};
const V = 1 as const;
const bidEv = (seq: number, amount: number) =>
  ({
    protocolVersion: V,
    type: "bid.accepted",
    seq,
    bidId: `b${seq}`,
    bidder: "Bidder AAAA",
    amountMinor: amount,
    at: 1,
    closesAt: 100_000,
    minNextBidMinor: amount + 25_000,
    reserveMet: false,
  }) as const;

describe("live feed ordering", () => {
  const snap = applyMessage(
    initialLive,
    { protocolVersion: V, type: "auction.snapshot", serverTime: 1_000, view },
    900,
  );

  it("snapshot sets state and clock offset", () => {
    expect(snap).toMatchObject({ status: "live", lastSeq: 5, serverOffsetMs: 100 });
  });
  it("applies the next seq", () => {
    const s = applyMessage(snap, bidEv(6, 200), 0);
    expect(s).toMatchObject({ lastSeq: 6, view: { currentPriceMinor: 200, bidCount: 1 } });
  });
  it("ignores duplicates and older events", () => {
    const s = applyMessage(snap, bidEv(6, 200), 0);
    expect(applyMessage(s, bidEv(6, 200), 0)).toBe(s);
    expect(applyMessage(s, bidEv(3, 50), 0)).toBe(s);
  });
  it("marks a gap as stale until the next snapshot", () => {
    const s = applyMessage(snap, bidEv(8, 300), 0);
    expect(s.status).toBe("stale");
    expect(applyMessage(s, bidEv(9, 400), 0)).toBe(s); // nothing applied while stale
    const healed = applyMessage(
      s,
      { protocolVersion: V, type: "auction.snapshot", serverTime: 0, view: { ...view, seq: 9 } },
      0,
    );
    expect(healed).toMatchObject({ status: "live", lastSeq: 9 });
  });
  it("events before any snapshot are ignored; outbid is recorded", () => {
    expect(applyMessage(initialLive, bidEv(1, 100), 0)).toBe(initialLive);
    const s = applyMessage(
      snap,
      {
        protocolVersion: V,
        type: "you.outbid",
        seq: 6,
        currentPriceMinor: 200,
        minNextBidMinor: 225,
      },
      0,
    );
    expect(s.outbid).toEqual({ currentPriceMinor: 200, minNextBidMinor: 225 });
  });
  it("applies lifecycle events", () => {
    const ext = applyMessage(
      snap,
      {
        protocolVersion: V,
        type: "auction.extended",
        seq: 6,
        previousClosesAt: 100_000,
        closesAt: 220_000,
      },
      0,
    );
    expect(ext.view).toMatchObject({ closesAt: 220_000, extensionCount: 1 });
    const end = applyMessage(
      ext,
      {
        protocolVersion: V,
        type: "auction.ended",
        seq: 7,
        outcome: "NO_BIDS",
        finalPriceMinor: null,
        winningBidder: null,
        endedAt: 220_000,
      },
      0,
    );
    expect(end.view).toMatchObject({ status: "ENDED", outcome: "NO_BIDS", minNextBidMinor: null });
  });
});
