import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  BidIntent,
  bidErrorMessage,
  checkBid,
  isUncertain,
  minFromError,
  nextBidInput,
  quickBidChips,
} from "./bid-intent";
import { durationFull } from "./format";

describe("checkBid", () => {
  it("validates whole rupees and the minimum", () => {
    expect(checkBid("", 5_000_000)).toMatchObject({ ok: false });
    expect(checkBid("12.5", 5_000_000)).toMatchObject({ ok: false });
    expect(checkBid("-5", 5_000_000)).toMatchObject({ ok: false });
    expect(checkBid("49999", 5_000_000)).toMatchObject({
      ok: false,
      message: expect.stringContaining("₹50,000"),
    });
    expect(checkBid("50000", 5_000_000)).toEqual({
      ok: true,
      amountMinor: 5_000_000,
      needsConfirm: false,
    });
  });
  it("asks for confirmation on unusually large bids", () => {
    expect(checkBid("75000", 5_000_000)).toMatchObject({ ok: true, needsConfirm: true });
    expect(checkBid("74999", 5_000_000)).toMatchObject({ ok: true, needsConfirm: false });
  });
});

describe("BidIntent: idempotency keys", () => {
  let n = 0;
  const intent = () => new BidIntent(() => `key-${++n}`);
  it("retrying the same amount after an uncertain failure reuses the key", () => {
    const i = intent();
    const k = i.keyFor(100);
    i.settle(new ApiError(0, "NETWORK"));
    expect(i.pendingRetryAmount).toBe(100);
    expect(i.keyFor(100)).toBe(k);
    i.settle(new ApiError(503, "SERVICE_UNAVAILABLE"));
    expect(i.keyFor(100)).toBe(k);
  });
  it("a definitive answer or a different amount starts a new intent", () => {
    const i = intent();
    const k1 = i.keyFor(100);
    i.settle(null); // accepted
    const k2 = i.keyFor(100);
    expect(k2).not.toBe(k1);
    i.settle(new ApiError(409, "BID_TOO_LOW"));
    expect(i.pendingRetryAmount).toBeNull();
    const k3 = i.keyFor(100);
    expect(k3).not.toBe(k2);
    expect(i.keyFor(200)).not.toBe(k3); // amount changed: new intent
  });
  it("classifies outcomes and explains them", () => {
    expect(isUncertain(new ApiError(0, "NETWORK"))).toBe(true);
    expect(isUncertain(new ApiError(500, "INTERNAL"))).toBe(true);
    expect(isUncertain(new TypeError("timeout"))).toBe(true);
    expect(isUncertain(new ApiError(409, "BID_TOO_LOW"))).toBe(false);
    expect(bidErrorMessage(new ApiError(401, "AUTH_REQUIRED"))).toMatch(/session has expired/);
    expect(bidErrorMessage(new ApiError(0, "NETWORK"))).toMatch(/can't place it twice/);
    expect(bidErrorMessage(new ApiError(429, "RATE_LIMITED"))).toMatch(/very fast/);
  });
});

describe("quickBidChips: +1 / +2 / +5 ladder increments", () => {
  const amounts = (min: number) => quickBidChips(min).map((c) => c.amountMinor / 100);
  it("+1 is the minimum; further chips step by the increment at each price", () => {
    expect(quickBidChips(5_000_000)).toEqual([
      { steps: 1, amountMinor: 5_000_000 },
      { steps: 2, amountMinor: 5_050_000 },
      { steps: 5, amountMinor: 5_200_000 },
    ]);
    expect(amounts(1_000_000)).toEqual([10_000, 10_250, 11_000]); // ₹250 band
  });
  it("crosses the ₹25,000 boundary with the larger increment from the boundary on", () => {
    // 24,500 → 24,750 → 25,000 (₹250 steps) → 25,500 → 26,000 (₹500 steps)
    expect(amounts(2_450_000)).toEqual([24_500, 24_750, 26_000]);
  });
  it("crosses ₹1,00,000 and the inclusive ₹3,00,000 bound correctly", () => {
    // 99,000 → 99,500 → 1,00,000 → 1,01,000 → 1,02,000
    expect(amounts(9_900_000)).toEqual([99_000, 99_500, 102_000]);
    // 2,99,000 → 3,00,000 (₹1,000) → 3,01,000 (still ₹1,000 AT ₹3,00,000) → 3,03,500 → 3,06,000
    expect(amounts(29_900_000)).toEqual([299_000, 300_000, 306_000]);
    expect(amounts(40_000_000)).toEqual([400_000, 402_500, 410_000]); // ₹2,500 band
  });
  it("accepts a custom ladder and steps", () => {
    const ladder = [
      { upToMinor: 1_000, incrementMinor: 100 },
      { upToMinor: null, incrementMinor: 1_000 },
    ];
    expect(quickBidChips(800, ladder, [1, 2, 3, 4])).toEqual([
      { steps: 1, amountMinor: 800 },
      { steps: 2, amountMinor: 900 },
      { steps: 3, amountMinor: 1_000 },
      { steps: 4, amountMinor: 2_000 },
    ]);
  });
});

describe("rejections: copy and the refreshed minimum", () => {
  const tooLow = (ext?: Record<string, unknown>) =>
    new ApiError(409, "BID_TOO_LOW", "server text", "req_1", undefined, ext);
  it("BID_TOO_LOW names the new minimum from the problem extensions (§11.5)", () => {
    const e = tooLow({ minNextBidMinor: 8_200_000 });
    expect(minFromError(e)).toBe(8_200_000);
    expect(bidErrorMessage(e)).toBe("Someone just bid. Minimum is now ₹82,000.");
  });
  it("falls back when the extension is missing or malformed", () => {
    for (const ext of [
      undefined,
      {},
      { minNextBidMinor: "82000" },
      { minNextBidMinor: -1 },
      { minNextBidMinor: 1.5 },
    ]) {
      expect(minFromError(tooLow(ext))).toBeNull();
      expect(bidErrorMessage(tooLow(ext))).toBe("Someone just bid. The minimum has gone up.");
    }
  });
  it("only BID_TOO_LOW carries a minimum; other codes map to fixed copy, never raw text", () => {
    expect(
      minFromError(
        new ApiError(409, "ALREADY_LEADING", undefined, undefined, undefined, {
          minNextBidMinor: 5,
        }),
      ),
    ).toBeNull();
    expect(minFromError(new Error("x"))).toBeNull();
    expect(bidErrorMessage(new ApiError(409, "AUCTION_ENDED"))).toBe("This auction has ended.");
    expect(bidErrorMessage(new ApiError(429, "RATE_LIMITED"))).toBe(
      "You're bidding very fast. Try again in a few seconds.",
    );
    expect(bidErrorMessage(new ApiError(400, "VALIDATION_FAILED", "raw zod message"))).toBe(
      "Your bid wasn't placed.",
    );
    expect(
      bidErrorMessage(
        new ApiError(422, "BID_UNREASONABLE", undefined, undefined, undefined, {
          maxAcceptableMinor: 15_000_000,
        }),
      ),
    ).toMatch(/most you can bid right now is ₹1,50,000\.$/);
  });
});

describe("nextBidInput: when the minimum rises", () => {
  it("keeps a typed amount that is still valid, otherwise prefills the minimum", () => {
    expect(nextBidInput("60000", 5_050_000)).toBe("60000");
    expect(nextBidInput("50500", 5_050_000)).toBe("50500");
    expect(nextBidInput("50000", 5_050_000)).toBe("50500");
    expect(nextBidInput("", 5_050_000)).toBe("50500");
    expect(nextBidInput("abc", 5_050_000)).toBe("50500");
  });
});

describe("durationFull", () => {
  it("shows days, hours, minutes and seconds and never goes negative", () => {
    expect(durationFull(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000)).toBe("2d 03h 04m 05s");
    expect(durationFull((3 * 3600 + 4 * 60 + 5) * 1000)).toBe("3h 04m 05s");
    expect(durationFull(65_000)).toBe("1m 05s");
    expect(durationFull(9_999)).toBe("9s");
    expect(durationFull(-5_000)).toBe("0s");
  });
});
