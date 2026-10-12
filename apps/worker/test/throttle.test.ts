import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { auctionStub, bid, createAuction } from "./helpers";

describe("persistent per-user bid throttle (Day-5 fix)", () => {
  it("limits 10 new commands per 10 s per user, and the limit survives a restart", async () => {
    const { stub, id } = await createAuction({ startPriceMinor: 1_000_000 });
    const kinds: string[] = [];
    for (let i = 0; i < 10; i++) kinds.push((await bid(stub, "spammer", 1)).kind); // rejected (too low) but counted
    expect(kinds.every((k) => k === "evaluated")).toBe(true);
    expect((await bid(stub, "spammer", 1)).kind).toBe("rate_limited");
    await evictDurableObject(stub);
    expect((await bid(auctionStub(id), "spammer", 1)).kind).toBe("rate_limited"); // not reset by the restart
    expect((await bid(auctionStub(id), "someone-else", 1_000_000)).kind).toBe("evaluated"); // per user
  });

  it("replays of stored results are never throttled", async () => {
    const { stub } = await createAuction({ startPriceMinor: 1_000_000 });
    const key = `k-${crypto.randomUUID()}`;
    await bid(stub, "u1", 1_000_000, key);
    for (let i = 0; i < 9; i++) await bid(stub, "u1", 1);
    expect((await bid(stub, "u1", 1_000_000, key)).kind).toBe("evaluated"); // replay still answered
  });
});
