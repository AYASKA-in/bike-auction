/**
 * Day-3 regression tests for defects found while reviewing AuctionDO against the domain engine.
 * Written BEFORE the fixes (they failed first; see docs/progress.md).
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AuctionDO } from "../src/auction/auction-do";
import { auctionStub, createLiveAuction } from "./helpers";

const BASE = "http://example.com";
const SECRET_USER = "user-raw-id-should-never-leak";

describe("privacy: public snapshots never expose raw user ids", () => {
  it("GET /api/v1/auctions/:id/snapshot omits the leader's user id", async () => {
    const { id, stub } = await createLiveAuction({ startPriceMinor: 5_000_000 });
    await stub.placeBid({ bidId: "b1", userId: SECRET_USER, amountMinor: 5_000_000 });
    const res = await exports.default.fetch(`${BASE}/api/v1/auctions/${id}/snapshot`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_USER);
    expect(text).not.toContain("leaderUserId");
  });

  it("the WebSocket auction.snapshot omits the leader's user id", async () => {
    const { id, stub } = await createLiveAuction({ startPriceMinor: 5_000_000 });
    await stub.placeBid({ bidId: "b1", userId: SECRET_USER, amountMinor: 5_000_000 });
    const res = await exports.default.fetch(`${BASE}/api/v1/auctions/${id}/stream`, {
      headers: { upgrade: "websocket", origin: BASE },
    });
    const ws = res.webSocket!;
    const messages: string[] = [];
    ws.addEventListener("message", (e) => {
      messages.push(e.data as string);
    });
    ws.accept();
    const end = Date.now() + 2000;
    while (messages.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const snapshot = messages.find((m) => m.includes('"auction.snapshot"'));
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toContain(SECRET_USER);
    expect(snapshot).not.toContain("leaderUserId");
    ws.close();
  });
});

describe("durability: a pending outbox always has a scheduled retry", () => {
  it("restores the outbox timer on restart if a crash lost it after commit", async () => {
    const { id, stub } = await createLiveAuction({ startPriceMinor: 5_000_000 });
    // Simulate the crash window: bid committed + outbox row written, but the timer write lost
    // and projection not yet done.
    await runInDurableObject(stub, (_i: AuctionDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (event_id, seq, type, created_at) VALUES ('lost-1', 999, 'bid.accepted', 0)`,
      );
      state.storage.sql.exec(`DELETE FROM timers WHERE kind = 'outbox'`);
    });
    await evictDurableObject(stub);
    const fresh = auctionStub(id);
    expect(await fresh.pendingOutbox()).toBeGreaterThan(0);
    const { timers } = await fresh.timers();
    expect(timers.map((t) => t.kind)).toContain("outbox");
  });
});
