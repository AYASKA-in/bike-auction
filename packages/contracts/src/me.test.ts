import { describe, expect, it } from "vitest";
import { MyBidCard, WatchlistIds } from "./me";

const card = {
  auctionId: "auc_1",
  title: "2021 Royal Enfield Classic 350",
  coverUrl: null,
  status: "LIVE",
  outcome: null,
  currentPriceMinor: 5_050_000,
  myHighestMinor: 5_000_000,
  bidCount: 2,
  closesAt: 1,
  startsAt: 0,
  isLeading: false,
};

describe("me contracts", () => {
  it("accepts a buyer-safe card and rejects leaked fields (strict)", () => {
    expect(MyBidCard.parse(card)).toEqual(card);
    for (const leak of [{ reserveMinor: 1 }, { winnerUserId: "u" }, { leadingBidder: "Bidder X" }])
      expect(MyBidCard.safeParse({ ...card, ...leak }).success).toBe(false);
  });

  it("watchlist ids are strict too", () => {
    expect(WatchlistIds.safeParse({ ids: ["a"], max: 100 }).success).toBe(true);
    expect(WatchlistIds.safeParse({ ids: ["a"], max: 100, userId: "u" }).success).toBe(false);
  });
});
