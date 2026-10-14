import type { PublicAuctionView, PublicBid, WsServerMessage } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { applyMessage, initialFor, initialLive, reduceLive, type LiveState } from "./live-auction";

const V = 1 as const;
const view = (over: Partial<PublicAuctionView> = {}): PublicAuctionView => ({
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
  viewer: { isLeading: false, isWinner: false },
  ...over,
});
const snapMsg = (v: PublicAuctionView, serverTime = 1_000): WsServerMessage => ({
  protocolVersion: V,
  type: "auction.snapshot",
  serverTime,
  view: v,
});
const bidEv = (seq: number, amount: number, bidder = "Bidder AAAA"): WsServerMessage => ({
  protocolVersion: V,
  type: "bid.accepted",
  seq,
  bidId: `b${seq}`,
  bidder,
  amountMinor: amount,
  at: seq * 1000,
  closesAt: 100_000,
  minNextBidMinor: amount + 25_000,
  reserveMet: false,
});
const row = (seq: number, isYou = false): PublicBid => ({
  seq,
  bidId: `b${seq}`,
  bidder: "Bidder AAAA",
  amountMinor: seq * 100,
  at: seq,
  isYou,
});
const msgs = (s: LiveState, ...ms: WsServerMessage[]) =>
  ms.reduce((acc, m) => applyMessage(acc, m, 0), s);

const live = applyMessage(initialFor("auc-1"), snapMsg(view()), 900);

describe("ordering: duplicates, gaps, out-of-order, snapshots", () => {
  it("snapshot sets state, clock offset and marks history for loading", () => {
    expect(live).toMatchObject({
      status: "live",
      lastSeq: 5,
      serverOffsetMs: 100,
      historyDirty: true,
    });
  });
  it("applies the next seq and updates price, count, leader, min next bid", () => {
    const s = applyMessage(live, bidEv(6, 200, "Bidder BBBB"), 0);
    expect(s.lastSeq).toBe(6);
    expect(s.view).toMatchObject({
      currentPriceMinor: 200,
      bidCount: 1,
      leadingBidder: "Bidder BBBB",
      minNextBidMinor: 25_200,
    });
  });
  it("ignores duplicates and older events (returns the same object: no re-render)", () => {
    const s = applyMessage(live, bidEv(6, 200), 0);
    expect(applyMessage(s, bidEv(6, 200), 0)).toBe(s);
    expect(applyMessage(s, bidEv(3, 50), 0)).toBe(s);
  });
  it("out-of-order delivery (7 before 6) is a gap: stale until a snapshot, nothing guessed", () => {
    const s = applyMessage(live, bidEv(7, 300), 0);
    expect(s.status).toBe("stale");
    expect(s.view?.currentPriceMinor).toBeNull();
    expect(applyMessage(s, bidEv(6, 200), 0)).toBe(s); // nothing applied while stale
    const healed = applyMessage(
      s,
      snapMsg(view({ seq: 7, currentPriceMinor: 300, bidCount: 2 })),
      0,
    );
    expect(healed).toMatchObject({ status: "live", lastSeq: 7, view: { currentPriceMinor: 300 } });
    expect(applyMessage(healed, bidEv(8, 400), 0).view?.bidCount).toBe(3);
  });
  it("events before any snapshot are ignored", () => {
    expect(applyMessage(initialLive, bidEv(1, 100), 0)).toBe(initialLive);
  });
  it("a snapshot for a different auction is ignored (no cross-auction bleed)", () => {
    expect(applyMessage(live, snapMsg(view({ auctionId: "auc-2", seq: 99 })), 0)).toBe(live);
    expect(
      reduceLive(live, { kind: "seed", view: view({ auctionId: "auc-2", seq: 99 }), at: 0 }),
    ).toBe(live);
  });
});

describe("stale HTTP responses never override newer socket state", () => {
  const s = msgs(live, bidEv(6, 200), bidEv(7, 300));
  it("an older HTTP view is ignored", () => {
    expect(
      reduceLive(s, { kind: "seed", view: view({ seq: 6, currentPriceMinor: 200 }), at: 0 }),
    ).toBe(s);
  });
  it("an HTTP view at the same seq applies (it carries this viewer's personal fields)", () => {
    const next = reduceLive(s, {
      kind: "seed",
      view: view({
        seq: 7,
        currentPriceMinor: 300,
        bidCount: 2,
        viewer: { isLeading: true, isWinner: false },
      }),
      at: 0,
    });
    expect(next.view?.viewer?.isLeading).toBe(true);
  });
  it("a newer HTTP view applies and requests a history reload; connection status is untouched", () => {
    const next = reduceLive(
      { ...s, historyDirty: false, status: "reconnecting" },
      { kind: "seed", view: view({ seq: 9, currentPriceMinor: 500, bidCount: 4 }), at: 0 },
    );
    expect(next).toMatchObject({ lastSeq: 9, historyDirty: true, status: "reconnecting" });
  });
});

describe("leading / outbid", () => {
  it("own bid: 201 after the event → leading", () => {
    const s = applyMessage(live, bidEv(6, 200), 0);
    expect(s.view?.viewer?.isLeading).toBe(false); // a broadcast alone never says "you"
    const mine = reduceLive(s, { kind: "ownBid", seq: 6, bidId: "b6", amountMinor: 200, at: 0 });
    expect(mine.view?.viewer?.isLeading).toBe(true);
    expect(mine.bids.find((b) => b.seq === 6)?.isYou).toBe(true);
  });
  it("own bid: 201 before the event → leading when the event arrives", () => {
    const s = reduceLive(live, { kind: "ownBid", seq: 6, bidId: "b6", amountMinor: 200, at: 0 });
    expect(applyMessage(s, bidEv(6, 200), 0).view?.viewer?.isLeading).toBe(true);
  });
  it("leading at ₹50,000, another buyer bids ₹50,500 → outbid immediately (even without you.outbid)", () => {
    let s = reduceLive(live, {
      kind: "ownBid",
      seq: 6,
      bidId: "b6",
      amountMinor: 5_000_000,
      at: 0,
    });
    s = applyMessage(s, bidEv(6, 5_000_000), 0);
    expect(s.view?.viewer?.isLeading).toBe(true);
    s = applyMessage(s, bidEv(7, 5_050_000, "Bidder ZZZZ"), 0);
    expect(s.view?.viewer?.isLeading).toBe(false);
    expect(s.outbid).toEqual({ currentPriceMinor: 5_050_000, minNextBidMinor: 5_075_000 });
  });
  it("you.outbid clears leading; a newer own bid clears outbid", () => {
    let s = msgs(live, bidEv(6, 200));
    s = reduceLive(s, { kind: "ownBid", seq: 6, bidId: "b6", amountMinor: 200, at: 0 });
    s = msgs(s, bidEv(7, 300), {
      protocolVersion: V,
      type: "you.outbid",
      seq: 7,
      currentPriceMinor: 300,
      minNextBidMinor: 400,
    });
    expect(s.outbid).toEqual({ currentPriceMinor: 300, minNextBidMinor: 400 });
    s = reduceLive(s, { kind: "ownBid", seq: 8, bidId: "b8", amountMinor: 400, at: 0 });
    s = applyMessage(s, bidEv(8, 400), 0);
    expect(s.outbid).toBeNull();
    expect(s.view?.viewer?.isLeading).toBe(true);
  });
  it("own 201 arriving after someone else's later bid → not leading, outbid", () => {
    let s = msgs(live, bidEv(6, 200), bidEv(7, 300, "Bidder ZZZZ"));
    s = reduceLive(s, { kind: "ownBid", seq: 6, bidId: "b6", amountMinor: 200, at: 0 });
    expect(s.view?.viewer?.isLeading).toBe(false);
    expect(s.outbid).not.toBeNull();
  });
  it("reconnect snapshot showing we lost the lead → outbid, even if events were missed", () => {
    const leading = applyMessage(
      initialFor("auc-1"),
      snapMsg(
        view({ seq: 6, currentPriceMinor: 200, viewer: { isLeading: true, isWinner: false } }),
      ),
      0,
    );
    const later = applyMessage(
      { ...leading, status: "reconnecting" },
      snapMsg(view({ seq: 9, currentPriceMinor: 500, minNextBidMinor: 600, bidCount: 4 })),
      0,
    );
    expect(later.outbid).toEqual({ currentPriceMinor: 500, minNextBidMinor: 600 });
  });
  it("a stale you.outbid (older than the current state) is ignored", () => {
    const s = msgs(live, bidEv(6, 200), bidEv(7, 300));
    const late = applyMessage(
      s,
      {
        protocolVersion: V,
        type: "you.outbid",
        seq: 6,
        currentPriceMinor: 200,
        minNextBidMinor: 300,
      },
      0,
    );
    expect(late).toBe(s);
  });
});

describe("bid history", () => {
  it("live events prepend; history pages merge without duplicates, newest first", () => {
    let s = msgs(live, bidEv(6, 600), bidEv(7, 700));
    s = reduceLive(s, {
      kind: "history",
      items: [row(7), row(6), row(5, true), row(4)],
      nextBeforeSeq: 4,
      older: false,
    });
    expect(s.bids.map((b) => b.seq)).toEqual([7, 6, 5, 4]);
    expect(s.ownSeqs).toContain(5);
    expect(s.historyDirty).toBe(false);
    expect(s.olderCursor).toBe(4);
    s = reduceLive(s, {
      kind: "history",
      items: [row(3), row(2)],
      nextBeforeSeq: null,
      older: true,
    });
    expect(s.bids.map((b) => b.seq)).toEqual([7, 6, 5, 4, 3, 2]);
    expect(s.olderCursor).toBeNull();
    // Reconnect: snapshot + reload of the latest page duplicates nothing.
    s = applyMessage(s, snapMsg(view({ seq: 8, currentPriceMinor: 800, bidCount: 7 })), 0);
    s = reduceLive(s, {
      kind: "history",
      items: [row(8), row(7), row(6)],
      nextBeforeSeq: 6,
      older: false,
    });
    expect(s.bids.map((b) => b.seq)).toEqual([8, 7, 6, 5, 4, 3, 2]);
    expect(s.olderCursor).toBeNull(); // the older cursor already reached the end
  });
});

describe("countdown extension and lifecycle", () => {
  it("anti-sniping extension moves closesAt for everyone", () => {
    const s = applyMessage(
      live,
      {
        protocolVersion: V,
        type: "auction.extended",
        seq: 6,
        previousClosesAt: 100_000,
        closesAt: 220_000,
      },
      0,
    );
    expect(s.view).toMatchObject({ closesAt: 220_000, extensionCount: 1 });
  });
  it("auction.started flips a scheduled auction to LIVE", () => {
    const s = applyMessage(initialFor("auc-1"), snapMsg(view({ status: "SCHEDULED" })), 0);
    expect(
      applyMessage(s, { protocolVersion: V, type: "auction.started", seq: 6, startedAt: 1 }, 0).view
        ?.status,
    ).toBe("LIVE");
  });
  it("ended SOLD: winner code shown, bidding disabled, our win flagged", () => {
    let s = reduceLive(live, { kind: "ownBid", seq: 6, bidId: "b6", amountMinor: 200, at: 0 });
    s = msgs(s, bidEv(6, 200, "Bidder MINE"), {
      protocolVersion: V,
      type: "auction.ended",
      seq: 7,
      outcome: "SOLD",
      finalPriceMinor: 200,
      winningBidder: "Bidder MINE",
      endedAt: 100_000,
    });
    expect(s.view).toMatchObject({
      status: "ENDED",
      outcome: "SOLD",
      leadingBidder: "Bidder MINE",
      minNextBidMinor: null,
      viewer: { isWinner: true },
    });
  });
  it("ended RESERVE_NOT_MET: no winner, no reserve amount anywhere", () => {
    const s = msgs(live, bidEv(6, 200), {
      protocolVersion: V,
      type: "auction.ended",
      seq: 7,
      outcome: "RESERVE_NOT_MET",
      finalPriceMinor: 200,
      winningBidder: null,
      endedAt: 100_000,
    });
    expect(s.view).toMatchObject({
      status: "ENDED",
      outcome: "RESERVE_NOT_MET",
      viewer: { isWinner: false },
    });
    expect(JSON.stringify(s)).not.toMatch(/reserveMinor/);
  });
  it("cancelled: bidding disabled, leading and outbid cleared", () => {
    const s = msgs(live, bidEv(6, 200), {
      protocolVersion: V,
      type: "auction.cancelled",
      seq: 7,
      reason: "Paperwork issue",
    });
    expect(s.view).toMatchObject({
      status: "CANCELLED",
      minNextBidMinor: null,
      viewer: { isLeading: false },
    });
    expect(s.outbid).toBeNull();
  });
});

describe("proxy (automatic) bids", () => {
  const leadingWithMax = (max: number | null) =>
    applyMessage(
      initialFor("auc-1"),
      snapMsg(
        view({
          seq: 6,
          currentPriceMinor: 200,
          leadingBidder: "Bidder MINE",
          viewer: { isLeading: true, isWinner: false, myMaxMinor: max },
        }),
      ),
      0,
    );
  it("learns our pseudonym from an authoritative view and treats our proxy bids as ours", () => {
    const s = leadingWithMax(1_000);
    expect(s.myBidder).toBe("Bidder MINE");
    // A rival bids below our max → our proxy answers in the same commit: no outbid flash.
    const rival = applyMessage(s, bidEv(7, 500, "Bidder RIVL"), 0);
    expect(rival.outbid).toBeNull();
    expect(rival.view?.viewer?.isLeading).toBe(true);
    const counter = applyMessage(rival, bidEv(8, 525, "Bidder MINE"), 0);
    expect(counter.view?.viewer?.isLeading).toBe(true);
    expect(counter.bids.find((b) => b.seq === 8)?.isYou).toBe(true);
  });
  it("a rival bid at or above our max outbids us", () => {
    const s = applyMessage(leadingWithMax(1_000), bidEv(7, 1_100, "Bidder RIVL"), 0);
    expect(s.view?.viewer?.isLeading).toBe(false);
    expect(s.outbid).toEqual({ currentPriceMinor: 1_100, minNextBidMinor: 26_100 });
  });
  it("without a max, a rival bid outbids us as before", () => {
    const s = applyMessage(leadingWithMax(null), bidEv(7, 300, "Bidder RIVL"), 0);
    expect(s.outbid).not.toBeNull();
  });
  it("learns the pseudonym from isYou history rows", () => {
    const s = reduceLive(live, {
      kind: "history",
      items: [{ ...row(4, true), bidder: "Bidder HIST" }],
      nextBeforeSeq: null,
      older: false,
    });
    expect(s.myBidder).toBe("Bidder HIST");
  });
});
