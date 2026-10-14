import type { PublicAuctionView } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { checkMaxBid, maxAcceptableMax, maxBidErrorMessage, maxStatus } from "./proxy-bid";

const view = (over: Partial<PublicAuctionView> = {}): PublicAuctionView => ({
  auctionId: "auc-1",
  status: "LIVE",
  outcome: null,
  startsAt: 0,
  closesAt: 1,
  startPriceMinor: 5_000_000,
  currentPriceMinor: 5_000_000,
  minNextBidMinor: 5_050_000,
  bidCount: 1,
  hasReserve: false,
  reserveMet: true,
  leadingBidder: "Bidder K7Q2",
  extensionCount: 0,
  seq: 4,
  viewer: { isLeading: false, isWinner: false, myMaxMinor: null },
  ...over,
});

describe("checkMaxBid", () => {
  it("requires whole rupees ≥ the minimum next bid", () => {
    expect(checkMaxBid("", view())).toMatchObject({ ok: false });
    expect(checkMaxBid("505.5", view())).toMatchObject({ ok: false });
    expect(checkMaxBid("50000", view())).toMatchObject({
      ok: false,
      message: expect.stringContaining("₹50,500"),
    });
    expect(checkMaxBid("50500", view())).toEqual({
      ok: true,
      maxMinor: 5_050_000,
      needsConfirm: false,
    });
  });

  it("mirrors the server's 3× fat-finger guard and asks to confirm large maxima", () => {
    expect(maxAcceptableMax(view())).toBe(15_000_000);
    expect(maxAcceptableMax(view({ currentPriceMinor: null, minNextBidMinor: 5_000_000 }))).toBe(
      15_000_000,
    );
    expect(checkMaxBid("150000", view())).toMatchObject({ ok: true, needsConfirm: true });
    expect(checkMaxBid("150001", view())).toMatchObject({
      ok: false,
      message: expect.stringContaining("₹1,50,000"),
    });
  });
});

describe("maxStatus", () => {
  it("is personal: none / leading / active / passed", () => {
    expect(maxStatus(view())).toBe("none");
    expect(maxStatus(view({ viewer: null }))).toBe("none");
    expect(
      maxStatus(view({ viewer: { isLeading: true, isWinner: false, myMaxMinor: 9_000_000 } })),
    ).toBe("leading");
    expect(
      maxStatus(view({ viewer: { isLeading: false, isWinner: false, myMaxMinor: 6_000_000 } })),
    ).toBe("active");
    expect(
      maxStatus(view({ viewer: { isLeading: false, isWinner: false, myMaxMinor: 5_000_000 } })),
    ).toBe("passed");
  });
});

describe("maxBidErrorMessage", () => {
  it("maps codes and offers a safe retry only for uncertain failures", () => {
    expect(maxBidErrorMessage(new ApiError(409, "BID_TOO_LOW"))).toMatch(/minimum/);
    expect(maxBidErrorMessage(new ApiError(0, "NETWORK"))).toMatch(/Retry/);
    expect(maxBidErrorMessage(new ApiError(503, "SERVICE_UNAVAILABLE"))).toMatch(/Retry/);
    expect(maxBidErrorMessage(new Error("boom"))).toMatch(/may not have been saved/);
  });
});
