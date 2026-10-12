import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AuctionDO } from "../src/auction/auction-do";
import { auctionStub, createLiveAuction, waitFor } from "./helpers";

const bid = (userId: string, amountMinor: number) => ({
  bidId: crypto.randomUUID(),
  userId,
  amountMinor,
});

describe("AuctionDO: correctness", () => {
  it("accepts the start price, then enforces the increment ladder", async () => {
    const { stub } = await createLiveAuction({ startPriceMinor: 5_000_000 }); // ₹50,000
    expect(await stub.placeBid(bid("u1", 4_999_900))).toMatchObject({
      ok: false,
      code: "BID_TOO_LOW",
      minNextBidMinor: 5_000_000,
    });
    expect(await stub.placeBid(bid("u1", 5_000_000))).toMatchObject({ ok: true, seq: 2 });
    // ₹50,000 is in the ₹500 band → next minimum ₹50,500
    expect(await stub.placeBid(bid("u2", 5_049_900))).toMatchObject({
      ok: false,
      minNextBidMinor: 5_050_000,
    });
    expect(await stub.placeBid(bid("u2", 5_050_000))).toMatchObject({ ok: true, seq: 3 });
  });

  it("rejects non-integer, zero and negative amounts", async () => {
    const { stub } = await createLiveAuction();
    for (const amount of [0, -100, 10.5, Number.NaN]) {
      expect(await stub.placeBid(bid("u1", amount))).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
      });
    }
  });

  it("50 simultaneous identical bids: exactly one is accepted", async () => {
    const { stub } = await createLiveAuction({ startPriceMinor: 10_000_000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => stub.placeBid(bid(`user-${i}`, 10_000_000))),
    );
    const accepted = results.filter((r) => r.ok);
    expect(accepted).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "BID_TOO_LOW")).toHaveLength(49);
    const snap = await stub.getSnapshot();
    expect(snap).toMatchObject({ currentPriceMinor: 10_000_000, bidCount: 1, seq: 2 });
  });

  it("200 concurrent random bids: ledger is strictly increasing and state matches the ledger", async () => {
    const { stub } = await createLiveAuction({ startPriceMinor: 1_000_000 });
    const amounts = Array.from(
      { length: 200 },
      () => 1_000_000 + Math.floor(Math.random() * 400) * 25_000,
    );
    const results = await Promise.all(amounts.map((a, i) => stub.placeBid(bid(`u${i % 7}`, a))));

    const ledger = await runInDurableObject(stub, (_i: AuctionDO, state) =>
      state.storage.sql
        .exec<{ seq: number; amount_minor: number; user_id: string }>(
          `SELECT seq, amount_minor, user_id FROM bids ORDER BY seq`,
        )
        .toArray(),
    );
    expect(ledger.length).toBe(results.filter((r) => r.ok).length);
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]!.seq).toBe(ledger[i - 1]!.seq + 1); // gap-free sequence
      expect(ledger[i]!.amount_minor).toBeGreaterThan(ledger[i - 1]!.amount_minor); // invariant I
    }
    const snap = await stub.getSnapshot();
    const top = ledger.at(-1)!;
    expect(snap?.currentPriceMinor).toBe(top.amount_minor); // invariant D
    expect(snap?.leaderUserId).toBe(top.user_id);
    expect(snap?.bidCount).toBe(ledger.length);
  });

  it("state and ledger survive eviction of the object (reloaded from SQLite)", async () => {
    const { stub, id } = await createLiveAuction({ startPriceMinor: 2_000_000 });
    await stub.placeBid(bid("u1", 2_000_000));
    await stub.placeBid(bid("u2", 2_050_000));
    const before = await stub.getSnapshot();

    await evictDurableObject(stub);

    const fresh = auctionStub(id);
    const after = await fresh.getSnapshot();
    expect({ ...after, serverTime: 0 }).toEqual({ ...before, serverTime: 0 });
    expect(await fresh.placeBid(bid("u3", 2_100_000))).toMatchObject({
      ok: true,
      seq: (before?.seq ?? 0) + 1,
    });
  });

  it("rejects a bid at closesAt even if the close alarm has not fired (lazy close)", async () => {
    const { stub } = await createLiveAuction({ closesInMs: 50 });
    await new Promise((r) => setTimeout(r, 80));
    expect(await stub.placeBid(bid("u1", 9_999_999))).toMatchObject({
      ok: false,
      code: "AUCTION_ENDED",
    });
    expect((await stub.getSnapshot())?.status).toBe("ENDED");
  });
});

describe("AuctionDO: projection to D1 (outbox)", () => {
  it("projects committed state into D1 asynchronously and idempotently", async () => {
    const { stub, id } = await createLiveAuction();
    await stub.placeBid(bid("u1", 5_000_000));
    await waitFor(async () => (await stub.pendingOutbox()) === 0);
    const row = await env.DB.prepare(`SELECT * FROM auctions_rm WHERE id = ?`).bind(id).first();
    expect(row).toMatchObject({
      status: "LIVE",
      current_price_minor: 5_000_000,
      bid_count: 1,
      projection_seq: 2,
    });

    // Replaying the projection is a no-op.
    await stub.retryProjection();
    expect(
      await env.DB.prepare(`SELECT projection_seq FROM auctions_rm WHERE id = ?`).bind(id).first(),
    ).toEqual({
      projection_seq: 2,
    });
  });

  it("keeps accepting bids while D1 is failing, then converges", async () => {
    const { stub, id } = await createLiveAuction();
    await waitFor(async () => (await stub.pendingOutbox()) === 0);
    // Simulate D1 failure for this projection: the read-model table disappears.
    await env.DB.exec(`ALTER TABLE auctions_rm RENAME TO auctions_rm_offline`);
    try {
      expect(await stub.placeBid(bid("u1", 5_000_000))).toMatchObject({ ok: true });
      expect(await stub.placeBid(bid("u2", 5_050_000))).toMatchObject({ ok: true });
      await stub.retryProjection();
      expect(await stub.pendingOutbox()).toBeGreaterThan(0);
      const { timers } = await stub.timers();
      expect(timers.find((t) => t.kind === "outbox")?.dueAt).toBeGreaterThan(Date.now()); // backoff
    } finally {
      await env.DB.exec(`ALTER TABLE auctions_rm_offline RENAME TO auctions_rm`);
    }
    await stub.retryProjection();
    expect(await stub.pendingOutbox()).toBe(0);
    const row = await env.DB.prepare(
      `SELECT current_price_minor, projection_seq FROM auctions_rm WHERE id = ?`,
    )
      .bind(id)
      .first();
    expect(row).toEqual({
      current_price_minor: 5_050_000,
      projection_seq: (await stub.getSnapshot())?.seq,
    });
  });
});

describe("AuctionDO: alarm multiplexer", () => {
  it("multiplexes close + outbox deadlines onto the single alarm (earliest wins)", async () => {
    const { stub } = await createLiveAuction({ closesInMs: 10 * 60 * 1000 });
    await waitFor(async () => (await stub.pendingOutbox()) === 0);
    const { alarm, timers } = await stub.timers();
    expect(timers.map((t) => t.kind)).toEqual(["close"]);
    expect(alarm).toBe(timers[0]!.dueAt);
  });

  it("closes the auction when the alarm fires and then schedules projection", async () => {
    const { stub, id } = await createLiveAuction({ closesInMs: 30 });
    await new Promise((r) => setTimeout(r, 50));
    // Miniflare fires alarms in real time, so it may already have run; if not, run it now.
    await runDurableObjectAlarm(stub);
    // getSnapshot() is read-only (it never closes lazily), so ENDED proves the alarm path ran.
    await waitFor(async () => (await stub.getSnapshot())?.status === "ENDED");
    await stub.retryProjection();
    expect(
      await env.DB.prepare(`SELECT status FROM auctions_rm WHERE id = ?`).bind(id).first(),
    ).toEqual({
      status: "ENDED",
    });
    expect((await stub.timers()).alarm).toBeNull();
  });

  it("SPIKE: a naive second setAlarm() silently overwrites the first", async () => {
    const probe = env.SPIKE_PROBE.get(env.SPIKE_PROBE.newUniqueId());
    const t = Date.now() + 60_000;
    expect(await probe.naiveTwoAlarms(t, t + 30_000)).toBe(t + 30_000);
  });
});

describe("SPIKE: why the critical section must not await", () => {
  it("awaiting between check and write lets concurrent bids interleave (lost update)", async () => {
    const probe = env.SPIKE_PROBE.get(env.SPIKE_PROBE.newUniqueId());
    const results = await Promise.all(Array.from({ length: 10 }, () => probe.bidUnsafe(200)));
    // All 10 read price=100 before any wrote: every one "wins" → 10 winners for one price.
    expect(results.filter(Boolean).length).toBeGreaterThan(1);
  });

  it("synchronous check-and-write admits exactly one", async () => {
    const probe = env.SPIKE_PROBE.get(env.SPIKE_PROBE.newUniqueId());
    const results = await Promise.all(Array.from({ length: 10 }, () => probe.bidSafe(200)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await probe.stats()).toEqual({ price: 200, accepted: 1 });
  });
});
