import { PublicAuctionEvent, PublicAuctionView } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import {
  cancel,
  compareProxies,
  DEFAULT_RULES,
  makeMaxIdempotencyRecord,
  minNextBidFor,
  maxBidFingerprint,
  bidFingerprint,
  proxyOf,
  resolveIdempotency,
  schedule,
  setMaxBid,
  tick,
  toPublicEvent,
  toPublicView,
  type AuctionEvent,
  type AuctionState,
  type MaxBidDecision,
} from "../src";
import { bid, CLOSE, draft, expectOk, live, MIN, START, T0 } from "./helpers";

let n = 0;
function setMax(state: AuctionState, userId: string, maxMinor: unknown, now = START + 1) {
  n += 1;
  return setMaxBid(state, { bidId: `max-${n}`, userId, maxMinor, now });
}
function okMax(r: MaxBidDecision) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}
type BidEvent = Extract<AuctionEvent, { type: "bid.accepted" }>;
const bids = (events: readonly AuctionEvent[]) =>
  events.filter((e): e is BidEvent => e.type === "bid.accepted");
const steps = (events: readonly AuctionEvent[]) =>
  bids(events).map((e) => [e.userId, e.amountMinor, e.kind]);

describe("setMaxBid: resolution (BLUEPRINT §4.7)", () => {
  it("a first maximum opens at the start price as a PROXY bid; the max stays hidden", () => {
    const r = okMax(setMax(live(), "A", 6_000_000));
    expect(steps(r.events)).toEqual([["A", 5_000_000, "PROXY"]]);
    expect(r.outcome).toEqual({
      maxMinor: 6_000_000,
      isLeading: true,
      currentPriceMinor: 5_000_000,
      minNextBidMinor: 5_050_000,
      seq: r.state.seq,
    });
    expect(proxyOf(r.state, "A")).toMatchObject({ maxMinor: 6_000_000, setSeq: r.state.seq });
    expect(JSON.stringify(r.events)).not.toContain("6000000");
  });

  it("a higher second maximum wins at second + increment, after the loser's step", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = okMax(setMax(a, "B", 7_000_000));
    expect(steps(r.events)).toEqual([
      ["A", 6_000_000, "PROXY"],
      ["B", 6_050_000, "PROXY"],
    ]);
    expect(r.state).toMatchObject({ leaderUserId: "B", currentPriceMinor: 6_050_000 });
    expect(r.outcome.isLeading).toBe(true);
  });

  it("a lower second maximum is beaten immediately: owner learns isLeading=false", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = okMax(setMax(a, "B", 5_500_000));
    expect(steps(r.events)).toEqual([
      ["B", 5_500_000, "PROXY"],
      ["A", 5_550_000, "PROXY"],
    ]);
    expect(r.outcome).toMatchObject({ isLeading: false, currentPriceMinor: 5_550_000 });
  });

  it("equal maxima: the earlier one wins at that amount, the later one records no step", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = okMax(setMax(a, "B", 6_000_000));
    expect(steps(r.events)).toEqual([["A", 6_000_000, "PROXY"]]);
    expect(r.state.leaderUserId).toBe("A");
    expect(r.outcome.isLeading).toBe(false);
    expect(r.state.currentPriceMinor).toBe(6_000_000);
  });

  it("the winner never pays more than its own maximum (cap below second + increment)", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = okMax(setMax(a, "B", 6_020_000));
    expect(steps(r.events)).toEqual([
      ["A", 6_000_000, "PROXY"],
      ["B", 6_020_000, "PROXY"],
    ]);
  });

  it("automatic step ids are deterministic and derived from the command's id", () => {
    const a = okMax(
      setMaxBid(live(), { bidId: "cmd1", userId: "A", maxMinor: 6_000_000, now: START + 1 }),
    );
    expect(bids(a.events).map((e) => e.bidId)).toEqual(["cmd1-p1"]);
    const b = okMax(
      setMaxBid(a.state, { bidId: "cmd2", userId: "B", maxMinor: 7_000_000, now: START + 2 }),
    );
    expect(bids(b.events).map((e) => e.bidId)).toEqual(["cmd2-p1", "cmd2-p2"]);
  });
});

describe("manual bids against a maximum", () => {
  it("a manual bid below the leader's maximum is recorded, then countered in the same command", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = expectOk(bid(a, "X", 5_050_000, START + 2));
    expect(steps(r.events)).toEqual([
      ["X", 5_050_000, "MANUAL"],
      ["A", 5_100_000, "PROXY"],
    ]);
    expect(r.bid.seq).toBe(bids(r.events)[0]!.seq); // the response describes the manual bid
    expect(r.state.leaderUserId).toBe("A");
  });

  it("a counter-bid is capped at the maximum (less than one increment above the manual bid)", () => {
    const a = okMax(setMax(live(), "A", 5_080_000)).state;
    const r = expectOk(bid(a, "X", 5_050_000, START + 2));
    expect(steps(r.events).at(-1)).toEqual(["A", 5_080_000, "PROXY"]);
  });

  it("a manual bid EQUAL to an earlier maximum loses the tie: proxy takes the amount, bid rejected", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = bid(a, "X", 6_000_000, START + 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "BID_TOO_LOW", minNextBidMinor: 6_050_000 });
    // The automatic step is committed even though the command was rejected.
    expect(steps(r.events)).toEqual([["A", 6_000_000, "PROXY"]]);
    expect(r.state).toMatchObject({ leaderUserId: "A", currentPriceMinor: 6_000_000 });
  });

  it("a manual bid above the maximum wins outright; the maximum is exhausted silently", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = expectOk(bid(a, "X", 6_050_000, START + 2));
    expect(steps(r.events)).toEqual([["X", 6_050_000, "MANUAL"]]);
    expect(r.state.leaderUserId).toBe("X");
    expect(
      toPublicView(r.state, { leaderPseudonym: "Bidder X", viewerUserId: "A" }).viewer,
    ).toEqual({ isLeading: false, isWinner: false, myMaxMinor: 6_000_000 });
  });

  it("the leader still cannot outbid themselves manually (ALREADY_LEADING)", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = bid(a, "A", 5_500_000, START + 2);
    expect(!r.ok && r.error.code).toBe("ALREADY_LEADING");
  });
});

describe("raising, lowering and re-sending a maximum", () => {
  it("the leader may raise their maximum: no public bid, no price change", () => {
    const b = okMax(setMax(okMax(setMax(live(), "A", 5_500_000)).state, "B", 6_000_000)).state;
    expect(b.leaderUserId).toBe("B");
    const r = okMax(setMax(b, "B", 8_000_000, START + 5));
    expect(r.events).toEqual([]);
    expect(r.state.currentPriceMinor).toBe(b.currentPriceMinor);
    expect(r.state.seq).toBe(b.seq);
    expect(proxyOf(r.state, "B")!.maxMinor).toBe(8_000_000);
    expect(r.outcome).toMatchObject({ isLeading: true, maxMinor: 8_000_000 });
  });

  it("a leader who bid manually may add a maximum without bidding", () => {
    const s = expectOk(bid(live(), "A", 5_000_000, START + 1)).state;
    const r = okMax(setMax(s, "A", 9_000_000, START + 2));
    expect(r.events).toEqual([]);
    expect(r.outcome.isLeading).toBe(true);
    // The maximum then defends the manual lead.
    const x = expectOk(bid(r.state, "X", 5_050_000, START + 3));
    expect(steps(x.events).at(-1)).toEqual(["A", 5_100_000, "PROXY"]);
  });

  it("lowering is allowed only down to the minimum next bid (never below current exposure)", () => {
    const s = okMax(setMax(live(), "A", 9_000_000)).state; // price 50,000; min next 50,500
    const low = setMax(s, "A", 5_000_000, START + 2);
    expect(!low.ok && low.error).toMatchObject({ code: "BID_TOO_LOW", minNextBidMinor: 5_050_000 });
    const r = okMax(setMax(s, "A", 5_050_000, START + 2));
    expect(r.events).toEqual([]);
    expect(proxyOf(r.state, "A")!.maxMinor).toBe(5_050_000);
  });

  it("re-sending the same maximum is a no-op that keeps tie priority", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const again = okMax(setMax(a, "A", 6_000_000, START + 9));
    expect(again.events).toEqual([]);
    expect(proxyOf(again.state, "A")).toEqual(proxyOf(a, "A"));
  });

  it("a later raise takes a later priority (ties are by when that amount was committed)", () => {
    const s = okMax(setMax(live(), "A", 6_000_000)).state;
    const raised = okMax(setMax(s, "A", 7_000_000, START + 5)).state;
    expect(proxyOf(raised, "A")!.setSeq).toBe(raised.seq);
    const r = okMax(setMax(raised, "B", 7_000_000, START + 6));
    expect(r.state.leaderUserId).toBe("A"); // A's 7,000,000 was committed first
    expect(r.state.currentPriceMinor).toBe(7_000_000);
  });
});

describe("validation", () => {
  it("rejects invalid, too-low, over-ceiling and fat-finger maxima", () => {
    const s = live();
    for (const bad of [0, -1, 1.5, "6000000", null, Number.NaN]) {
      const r = setMax(s, "A", bad);
      expect(!r.ok && r.error.code).toBe("BID_INVALID_AMOUNT");
    }
    expect(setMax(s, "A", 4_999_999)).toMatchObject({
      ok: false,
      error: { code: "BID_TOO_LOW", minNextBidMinor: 5_000_000 },
    });
    // 3× the reference price (start 50,000 → 1,50,000) is the most a maximum may be.
    expect(okMax(setMax(s, "A", 15_000_000)).outcome.maxMinor).toBe(15_000_000);
    expect(setMax(s, "A", 15_000_001)).toMatchObject({
      ok: false,
      error: { code: "BID_UNREASONABLE", maxAcceptableMinor: 15_000_000 },
    });
    expect(setMax(s, "A", 1_000_000_001)).toMatchObject({
      ok: false,
      error: { code: "BID_UNREASONABLE" },
    });
    // A rejection changes nothing.
    const r = setMax(s, "A", 15_000_001);
    expect(r.state.proxies).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it("rejects maxima unless LIVE (and still commits lifecycle events)", () => {
    const sched = expectOk(schedule(draft(), T0)).state;
    expect(sched.status).toBe("SCHEDULED");
    expect(setMax(sched, "A", 6_000_000, START - 1)).toMatchObject({
      ok: false,
      error: { code: "AUCTION_NOT_LIVE" },
    });
    const late = setMax(live(), "A", 6_000_000, CLOSE);
    expect(!late.ok && late.error.code).toBe("AUCTION_ENDED");
    expect(late.events.map((e) => e.type)).toEqual(["auction.ended"]);
    const cancelled = expectOk(cancel(live(), { reason: "Withdrawn", now: START + 1 })).state;
    expect(setMax(cancelled, "A", 6_000_000)).toMatchObject({
      error: { code: "AUCTION_CANCELLED" },
    });
  });

  it("requires a server-supplied identity, bid id and time", () => {
    expect(() => setMaxBid(live(), { bidId: "b", userId: "", maxMinor: 1, now: START })).toThrow();
    expect(() => setMaxBid(live(), { bidId: "", userId: "A", maxMinor: 1, now: START })).toThrow();
    expect(() => setMaxBid(live(), { bidId: "b", userId: "A", maxMinor: 1, now: 1.5 })).toThrow();
  });
});

describe("reserve rule (eBay): a maximum covering the reserve lifts the price to it", () => {
  const RESERVE = 6_000_000;
  it("a single maximum ≥ reserve opens at the reserve", () => {
    const r = okMax(setMax(live({ reserveMinor: RESERVE }), "A", 7_000_000));
    expect(steps(r.events)).toEqual([["A", RESERVE, "PROXY"]]);
    expect(bids(r.events)[0]!.reserveMet).toBe(true);
  });

  it("a maximum below the reserve does not jump", () => {
    const r = okMax(setMax(live({ reserveMinor: RESERVE }), "A", 5_900_000));
    expect(r.state.currentPriceMinor).toBe(5_000_000);
    expect(bids(r.events)[0]!.reserveMet).toBe(false);
  });

  it("with competition below the reserve, the winner's price is the reserve", () => {
    const b = okMax(setMax(live({ reserveMinor: RESERVE }), "B", 5_500_000)).state;
    const r = okMax(setMax(b, "A", 7_000_000));
    expect(steps(r.events)).toEqual([
      ["B", 5_500_000, "PROXY"],
      ["A", RESERVE, "PROXY"],
    ]);
  });

  it("competition above the reserve prices normally", () => {
    const b = okMax(setMax(live({ reserveMinor: RESERVE }), "B", 6_500_000)).state;
    const r = okMax(setMax(b, "A", 7_000_000));
    expect(r.state.currentPriceMinor).toBe(6_550_000);
  });

  it("the leader raising past the reserve lifts the price to it (their own PROXY step)", () => {
    const a = okMax(setMax(live({ reserveMinor: RESERVE }), "A", 5_500_000)).state;
    const r = okMax(setMax(a, "A", 6_500_000, START + 2));
    expect(steps(r.events)).toEqual([["A", RESERVE, "PROXY"]]);
    expect(tick(r.state, CLOSE).state.outcome).toBe("SOLD");
  });

  it("a manual bid against a reserve-covering maximum is countered at the reserve", () => {
    const b = okMax(setMax(live({ reserveMinor: RESERVE }), "B", 5_200_000)).state; // 50,000
    const a = okMax(setMax(b, "A", 9_000_000)).state; // A leads at the reserve already
    expect(a.currentPriceMinor).toBe(RESERVE);
    const r = expectOk(bid(a, "X", 6_050_000, START + 3));
    expect(steps(r.events).at(-1)).toEqual(["A", 6_100_000, "PROXY"]);
  });
});

describe("soft close with automatic bids: one extension per command", () => {
  const near = CLOSE - MIN; // inside the 2-minute window

  it("a manual bid countered by a maximum inside the window extends exactly once, after both bids", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = expectOk(bid(a, "X", 5_050_000, near));
    expect(r.events.map((e) => e.type)).toEqual([
      "bid.accepted",
      "bid.accepted",
      "auction.extended",
    ]);
    expect(r.state.closesAt).toBe(near + 2 * MIN);
    expect(r.state.extensionCount).toBe(1);
  });

  it("setting a maximum inside the window extends when it causes a bid", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = okMax(setMax(a, "B", 7_000_000, near));
    expect(r.events.map((e) => e.type)).toEqual([
      "bid.accepted",
      "bid.accepted",
      "auction.extended",
    ]);
  });

  it("a leader's raise inside the window places no bid and does not extend", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = okMax(setMax(a, "A", 8_000_000, near));
    expect(r.events).toEqual([]);
    expect(r.state.closesAt).toBe(CLOSE);
  });

  it("the tie rejection still extends (an automatic bid was accepted)", () => {
    const a = okMax(setMax(live(), "A", 6_000_000)).state;
    const r = bid(a, "X", 6_000_000, near);
    expect(r.ok).toBe(false);
    expect(r.events.map((e) => e.type)).toEqual(["bid.accepted", "auction.extended"]);
  });

  it("repeated late manual bids against a maximum never push the close past the hard cap", () => {
    let s = okMax(setMax(live(), "A", 14_000_000)).state;
    const hardCap = CLOSE + 30 * MIN;
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const at = s.closesAt - 1_000; // always inside the soft-close window
      if (at >= hardCap) break;
      const min = minNextBidFor(s);
      if (min >= 14_000_000) break; // the maximum is exhausted
      const r = bid(s, "X", min, at);
      if (!r.ok) break;
      s = r.state;
      accepted++;
      expect(s.closesAt).toBeLessThanOrEqual(hardCap);
      expect(s.currentPriceMinor).toBeLessThanOrEqual(14_000_000); // never above A's maximum
    }
    expect(accepted).toBeGreaterThan(10); // the cap was actually exercised
    expect(s.closesAt).toBeLessThanOrEqual(hardCap);
    // After the hard cap nothing is accepted.
    const late = bid(s, "X", minNextBidFor(s), hardCap + 1);
    expect(late.ok).toBe(false);
  });

  it("with soft close disabled nothing extends", () => {
    const a = okMax(setMax(live({ rules: { ...DEFAULT_RULES, softClose: null } }), "A", 6_000_000));
    const r = expectOk(bid(a.state, "X", 5_050_000, near));
    expect(r.events.map((e) => e.type)).toEqual(["bid.accepted", "bid.accepted"]);
  });
});

describe("ladder band boundaries: winner pays second max + increment at the SECOND max", () => {
  // second max → increment(second) per ADR 004 (third band inclusive of ₹3,00,000).
  const cases: [second: number, expected: number][] = [
    [2_499_900, 2_524_900], // < ₹25,000 → ₹250
    [2_500_000, 2_550_000], // ₹25,000 → ₹500
    [9_999_900, 10_049_900], // < ₹1,00,000 → ₹500
    [10_000_000, 10_100_000], // ₹1,00,000 → ₹1,000
    [30_000_000, 30_100_000], // exactly ₹3,00,000 → ₹1,000 (inclusive)
    [30_000_001, 30_250_001], // above ₹3,00,000 → ₹2,500
  ];
  for (const [second, expected] of cases) {
    it(`second ${second} → ${expected}`, () => {
      const start = Math.round(second * 0.6);
      const a = okMax(setMax(live({ startPriceMinor: start }), "A", second)).state;
      const r = okMax(setMax(a, "B", second + 1_000_000));
      expect(steps(r.events)).toEqual([
        ["A", second, "PROXY"],
        ["B", expected, "PROXY"],
      ]);
    });
  }
});

describe("privacy: a maximum is visible only to its owner", () => {
  it("never appears in public events or other viewers' views", () => {
    const MAX_A = 9_123_437; // distinctive value, never reached
    const a = okMax(setMax(live(), "A", MAX_A));
    const b = okMax(setMax(a.state, "B", 5_500_000));
    const x = expectOk(bid(b.state, "X", 6_000_000, START + 3));
    const events = [...a.events, ...b.events, ...x.events];
    const pub = events.map((e) => toPublicEvent(e, (u) => `Bidder ${u}000`));
    for (const p of pub) if (p) PublicAuctionEvent.parse(p); // strict: no extra keys
    const views = ["B", "X", null].map((v) =>
      toPublicView(x.state, { leaderPseudonym: "Bidder A000", viewerUserId: v }),
    );
    for (const v of views) PublicAuctionView.parse(v);
    const json = JSON.stringify([pub, views]);
    expect(json).not.toContain(String(MAX_A));
    expect(json).not.toMatch(/maxMinor"\s*:\s*\d/); // only null maxima for non-owners
    const own = toPublicView(x.state, { leaderPseudonym: "Bidder A000", viewerUserId: "A" });
    expect(own.viewer).toEqual({ isLeading: true, isWinner: false, myMaxMinor: MAX_A });
    expect(views[2]!.viewer).toBeNull();
  });

  it("public bid events carry kind", () => {
    const a = okMax(setMax(live(), "A", 6_000_000));
    expect(toPublicEvent(a.events[0]!, () => "Bidder K7Q2")).toMatchObject({ kind: "PROXY" });
    // Events committed before kinds existed read as MANUAL.
    const legacy = { ...a.events[0]!, kind: undefined } as unknown as AuctionEvent;
    expect(toPublicEvent(legacy, () => "Bidder K7Q2")).toMatchObject({ kind: "MANUAL" });
  });
});

describe("idempotency of setMaxBid", () => {
  it("fingerprints are namespaced and replay returns the stored result", () => {
    expect(maxBidFingerprint({ auctionId: "a1", maxMinor: 600 })).toBe("max:v1:a1:600");
    expect(maxBidFingerprint({ auctionId: "a1", maxMinor: "600" })).toBe('max:v1:a1:"600"');
    expect(maxBidFingerprint({ auctionId: "a1", maxMinor: 600 })).not.toBe(
      bidFingerprint({ auctionId: "a1", amountMinor: 600 }),
    );
    const req = { userId: "A", key: "k".repeat(16), fingerprint: "max:v1:a1:600" };
    const d = okMax(setMax(live(), "A", 6_000_000));
    const rec = makeMaxIdempotencyRecord(req, d, START);
    expect(rec.result).toEqual({ ok: true, ...d.outcome });
    expect(resolveIdempotency(rec, req, START + 1)).toEqual({ kind: "replay", result: rec.result });
    expect(resolveIdempotency(rec, { ...req, fingerprint: "max:v1:a1:700" }, START + 1)).toEqual({
      kind: "conflict",
    });
    const rejected = makeMaxIdempotencyRecord(req, setMax(live(), "A", 1), START);
    expect(rejected.result).toEqual({ ok: false, code: "BID_TOO_LOW", minNextBidMinor: 5_000_000 });
  });
});

describe("compareProxies", () => {
  it("orders by max desc, then earlier setSeq, then user id", () => {
    const p = (userId: string, maxMinor: number, setSeq: number) => ({
      userId,
      maxMinor,
      setSeq,
      updatedAt: 0,
    });
    const sorted = [p("c", 5, 9), p("b", 7, 3), p("a", 7, 4), p("d", 5, 9)].sort(compareProxies);
    expect(sorted.map((x) => x.userId)).toEqual(["b", "a", "c", "d"]);
  });
});
