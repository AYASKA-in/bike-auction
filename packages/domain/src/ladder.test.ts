import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_LADDER, incrementFor, minNextBid, validateLadder } from "./ladder";
import { formatINR, isValidAmount, rupees } from "./money";

describe("increment ladder", () => {
  it("default ladder is valid", () => {
    expect(() => validateLadder(DEFAULT_LADDER)).not.toThrow();
  });

  it.each([
    [rupees(24_999), rupees(250)],
    [rupees(25_000), rupees(500)],
    [rupees(99_999), rupees(500)],
    [rupees(1_00_000), rupees(1_000)],
    [rupees(2_99_999), rupees(1_000)],
    [rupees(3_00_000), rupees(2_500)],
  ])("band boundary: price %i → increment %i", (price, inc) => {
    expect(incrementFor(price)).toBe(inc);
  });

  it("starting price is acceptable before the first bid", () => {
    expect(minNextBid({ startPriceMinor: rupees(50_000), currentPriceMinor: null })).toBe(
      rupees(50_000),
    );
  });

  it("rejects malformed ladders", () => {
    expect(() => validateLadder([])).toThrow();
    expect(() => validateLadder([{ upToMinor: 100, incrementMinor: 1 }])).toThrow();
    expect(() =>
      validateLadder([
        { upToMinor: 200, incrementMinor: 1 },
        { upToMinor: 100, incrementMinor: 1 },
        { upToMinor: null, incrementMinor: 1 },
      ]),
    ).toThrow();
  });

  // Property: the next minimum is always strictly greater than the current price,
  // and the minimum is monotonic non-decreasing in the current price.
  it("property: minNextBid > current and monotonic", () => {
    const price = fc.integer({ min: 1, max: 1_000_000_000 });
    fc.assert(
      fc.property(price, price, (a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const mLo = minNextBid({ startPriceMinor: 1, currentPriceMinor: lo });
        const mHi = minNextBid({ startPriceMinor: 1, currentPriceMinor: hi });
        expect(mLo).toBeGreaterThan(lo);
        expect(mHi).toBeGreaterThanOrEqual(mLo);
      }),
    );
  });
});

describe("money", () => {
  it("formats with Indian digit grouping", () => {
    expect(formatINR(rupees(2_81_500))).toBe("₹2,81,500");
  });
  it("validates integer paise only", () => {
    expect(isValidAmount(100)).toBe(true);
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(-5)).toBe(false);
    expect(isValidAmount(10.5)).toBe(false);
    expect(isValidAmount(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isValidAmount("100")).toBe(false);
  });
});
