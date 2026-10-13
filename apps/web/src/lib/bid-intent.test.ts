import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { BidIntent, bidErrorMessage, checkBid, isUncertain } from "./bid-intent";
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

describe("durationFull", () => {
  it("shows days, hours, minutes and seconds and never goes negative", () => {
    expect(durationFull(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000)).toBe("2d 03h 04m 05s");
    expect(durationFull((3 * 3600 + 4 * 60 + 5) * 1000)).toBe("3h 04m 05s");
    expect(durationFull(65_000)).toBe("1m 05s");
    expect(durationFull(9_999)).toBe("9s");
    expect(durationFull(-5_000)).toBe("0s");
  });
});
