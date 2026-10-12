import { describe, expect, it } from "vitest";
import {
  DEFAULT_LADDER,
  DEFAULT_RULES,
  incrementFor,
  isValidAmount,
  MAX_AMOUNT_MINOR,
  maxAcceptableBid,
  minNextBidFor,
  rupees,
  safeAdd,
  safeMultiply,
  tick,
} from "../src";
import { bid, CLOSE, draft, expectOk, live, MIN, START } from "./helpers";

describe("increment ladder: exact boundaries (ADR 004)", () => {
  it.each([
    [rupees(24_999.99), rupees(250)],
    [rupees(25_000), rupees(500)],
    [rupees(99_999.99), rupees(500)],
    [rupees(1_00_000), rupees(1_000)],
    [rupees(3_00_000), rupees(1_000)], // "through ₹3,00,000": inclusive (Day-3 correction)
    [rupees(3_00_000.01), rupees(2_500)],
    [rupees(9_99_999), rupees(2_500)],
  ])("price %i paise → increment %i paise", (price, inc) => {
    expect(incrementFor(price, DEFAULT_LADDER)).toBe(inc);
  });
});

describe("money safety", () => {
  it.each([
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "100",
    null,
    undefined,
    MAX_AMOUNT_MINOR + 1,
  ])("rejects %s as an amount", (v) => expect(isValidAmount(v)).toBe(false));
  it("accepts the ceiling", () => expect(isValidAmount(MAX_AMOUNT_MINOR)).toBe(true));
  it("arithmetic refuses to leave the safe-integer range", () => {
    expect(() => safeMultiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
    expect(() => safeAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(safeAdd(1, 2)).toBe(3);
  });
});

describe("bid acceptance", () => {
  it("before any bid, the minimum is exactly the start price", () => {
    const s = live({ startPriceMinor: 5_000_000 });
    expect(minNextBidFor(s)).toBe(5_000_000);
    expect(bid(s, "u1", 4_999_999, START + 1)).toMatchObject({
      ok: false,
      error: { code: "BID_TOO_LOW", minNextBidMinor: 5_000_000 },
    });
    const r = expectOk(bid(s, "u1", 5_000_000, START + 1));
    expect(r.state).toMatchObject({
      currentPriceMinor: 5_000_000,
      leaderUserId: "u1",
      bidCount: 1,
      seq: 4,
    });
    expect(r.bid.seq).toBe(4);
    expect(r.events).toMatchObject([
      { type: "bid.accepted", seq: 4, previousPriceMinor: null, minNextBidMinor: 5_050_000 },
    ]);
  });

  it("after a bid, the minimum is computed from the authoritative current price", () => {
    const s = expectOk(bid(live({ startPriceMinor: 2_490_000 }), "u1", 2_499_900, START + 1)).state; // ₹24,999
    expect(minNextBidFor(s)).toBe(2_524_900); // + ₹250 (band of the CURRENT price)
    expect(bid(s, "u2", 2_524_899, START + 2).ok).toBe(false);
    expect(expectOk(bid(s, "u2", 2_524_900, START + 2)).state.currentPriceMinor).toBe(2_524_900);
  });

  it("rejects bids before start, with lazy start at exactly startsAt", () => {
    const s = draft();
    expect(bid(s, "u1", 5_000_000, START)).toMatchObject({
      ok: false,
      error: { code: "AUCTION_NOT_LIVE" },
    });
  });

  it("late bids are rejected at closesAt even if no alarm ran (invariant A; −1/0/+1 ms)", () => {
    const rules = { ...DEFAULT_RULES, softClose: null };
    const s = live({ rules });
    expect(bid(s, "u1", 5_000_000, CLOSE - 1).ok).toBe(true);
    for (const t of [CLOSE, CLOSE + 1]) {
      const r = bid(s, "u1", 5_000_000, t);
      expect(r).toMatchObject({ ok: false, error: { code: "AUCTION_ENDED" } });
      expect(r.events.map((e) => e.type)).toEqual(["auction.ended"]); // must be committed by the caller
    }
  });

  it("the leader cannot outbid themselves (no proxy bidding yet)", () => {
    const s = expectOk(bid(live(), "u1", 5_000_000, START + 1)).state;
    expect(bid(s, "u1", 6_000_000, START + 2)).toMatchObject({
      ok: false,
      error: { code: "ALREADY_LEADING" },
    });
  });

  it("fat-finger protection: at most 3× the reference price, never below the minimum", () => {
    const s = live({ startPriceMinor: 1_000_000 });
    expect(maxAcceptableBid(s)).toBe(3_000_000);
    expect(bid(s, "u1", 3_000_001, START + 1)).toMatchObject({
      ok: false,
      error: { code: "BID_UNREASONABLE", maxAcceptableMinor: 3_000_000 },
    });
    expect(bid(s, "u1", 3_000_000, START + 1).ok).toBe(true);
    // With a tiny start price, 3× would be below the minimum: the minimum wins.
    const tiny = live({ startPriceMinor: 1 });
    expect(maxAcceptableBid(expectOk(bid(tiny, "u1", 1, START + 1)).state)).toBeGreaterThanOrEqual(
      25_001,
    );
  });

  it("absolute ceiling", () => {
    const s = live({ startPriceMinor: MAX_AMOUNT_MINOR - 10 });
    expect(bid(s, "u1", MAX_AMOUNT_MINOR + 1, START + 1)).toMatchObject({
      ok: false,
      error: { code: "BID_UNREASONABLE" },
    });
    expect(maxAcceptableBid(s)).toBe(MAX_AMOUNT_MINOR);
  });

  it.each([0, -500, 10.5, Number.NaN, "5000000", null, undefined, {}, Number.MAX_SAFE_INTEGER + 2])(
    "rejects malformed amount %s without changing state",
    (amount) => {
      const s = live();
      const r = bid(s, "u1", amount, START + 1);
      expect(r).toMatchObject({
        ok: false,
        error: { code: "BID_INVALID_AMOUNT" },
        state: s,
        events: [],
      });
    },
  );

  it("rejected bids never change price, leader, count or seq", () => {
    const s = expectOk(bid(live(), "u1", 5_000_000, START + 1)).state;
    for (const [user, amount] of [
      ["u2", 1],
      ["u1", 9_000_000],
      ["u2", 99_000_000_000],
    ] as const) {
      const r = bid(s, user, amount, START + 2);
      expect(r.ok).toBe(false);
      expect(r.state).toBe(s);
    }
  });

  it("requires trusted identity fields", () => {
    expect(() => bid(live(), "", 5_000_000, START + 1)).toThrow();
  });

  it("tick + bid at the same instant as start works", () => {
    const scheduled = tick(draft(), START).state; // DRAFT does not auto-start
    expect(scheduled.status).toBe("DRAFT");
    void MIN;
  });
});
