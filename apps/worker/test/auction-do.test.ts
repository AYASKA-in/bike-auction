import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AuctionDO } from "../src/auction/auction-do";
import { auctionStub, bid, createAuction, eventLog, key, sleep, waitFor } from "./helpers";

const accepted = (r: Awaited<ReturnType<typeof bid>>) => r.kind === "evaluated" && r.result.ok;
const code = (r: Awaited<ReturnType<typeof bid>>) =>
  r.kind === "evaluated" && !r.result.ok ? r.result.code : r.kind;

describe("AuctionDO on the domain engine: correctness", () => {
  it("enforces the start price and the increment ladder", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000 });
    expect(code(await bid(stub, "u1", 4_999_900))).toBe("BID_TOO_LOW");
    expect(await bid(stub, "u1", 5_000_000)).toMatchObject({
      kind: "evaluated",
      result: { ok: true, minNextBidMinor: 5_050_000 },
    });
    expect(await bid(stub, "u2", 5_049_900)).toMatchObject({
      result: { ok: false, code: "BID_TOO_LOW", minNextBidMinor: 5_050_000 },
    });
    expect(accepted(await bid(stub, "u2", 5_050_000))).toBe(true);
    expect(code(await bid(stub, "u2", 5_200_000))).toBe("ALREADY_LEADING");
  });

  it("50 simultaneous identical bids: exactly one accepted, one seq increment", async () => {
    const { stub } = await createAuction({ startPriceMinor: 10_000_000 });
    const before = (await stub.getAdminDetails())!.state.seq;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bid(stub, `user-${i}`, 10_000_000)),
    );
    expect(results.filter(accepted)).toHaveLength(1);
    expect(results.filter((r) => code(r) === "BID_TOO_LOW")).toHaveLength(49);
    const { state } = (await stub.getAdminDetails())!;
    expect(state).toMatchObject({ currentPriceMinor: 10_000_000, bidCount: 1, seq: before + 1 });
  });

  it("200 concurrent random bids: strictly increasing gap-free ledger that matches state", async () => {
    const { stub } = await createAuction({ startPriceMinor: 1_000_000 });
    const amounts = Array.from(
      { length: 200 },
      () => 1_000_000 + Math.floor(Math.random() * 400) * 25_000,
    );
    const results = await Promise.all(amounts.map((a, i) => bid(stub, `u${i}`, a)));
    const ledger = await runInDurableObject(stub, (_i: AuctionDO, s) =>
      s.storage.sql
        .exec<{ seq: number; amount_minor: number; user_id: string }>(
          `SELECT seq, amount_minor, user_id FROM bids ORDER BY seq`,
        )
        .toArray(),
    );
    expect(ledger.length).toBe(results.filter(accepted).length);
    for (let i = 1; i < ledger.length; i++)
      expect(ledger[i]!.amount_minor).toBeGreaterThan(ledger[i - 1]!.amount_minor);
    const { state } = (await stub.getAdminDetails())!;
    expect(state.currentPriceMinor).toBe(ledger.at(-1)!.amount_minor);
    expect(state.leaderUserId).toBe(ledger.at(-1)!.user_id);
    expect(state.bidCount).toBe(ledger.length);
    const log = await eventLog(stub);
    log.forEach((e, i) => expect(e.seq).toBe(i + 1)); // no gaps, no duplicates
    expect(log.at(-1)!.seq).toBe(state.seq);
  });

  it("two auctions bid on simultaneously stay independent", async () => {
    const a = await createAuction({ startPriceMinor: 1_000_000 });
    const b = await createAuction({ startPriceMinor: 7_000_000 });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2
          ? bid(a.stub, `ua${i}`, 1_000_000 + i * 50_000)
          : bid(b.stub, `ub${i}`, 7_000_000 + i * 100_000),
      ),
    );
    const sa = (await a.stub.getAdminDetails())!.state;
    const sb = (await b.stub.getAdminDetails())!.state;
    expect(sa.leaderUserId?.startsWith("ua")).toBe(true);
    expect(sb.leaderUserId?.startsWith("ub")).toBe(true);
    expect(sa.currentPriceMinor).toBeLessThan(7_000_000);
    expect(sb.currentPriceMinor).toBeGreaterThanOrEqual(7_000_000);
  });

  it("rejected bids change nothing", async () => {
    const { stub } = await createAuction();
    await bid(stub, "u1", 5_000_000);
    const before = (await stub.getAdminDetails())!.state;
    for (const [u, a] of [
      ["u2", 1],
      ["u1", 9_000_000],
      ["u3", 999_999_999],
    ] as const)
      await bid(stub, u, a);
    expect((await stub.getAdminDetails())!.state).toEqual(before);
  });

  it("state, ledger and idempotency survive eviction (reloaded from SQLite)", async () => {
    const { stub, id } = await createAuction({ startPriceMinor: 2_000_000 });
    const k = key();
    await bid(stub, "u1", 2_000_000, k);
    await bid(stub, "u2", 2_050_000);
    const before = (await stub.getAdminDetails())!.state;
    await evictDurableObject(stub);
    const fresh = auctionStub(id);
    expect((await fresh.getAdminDetails())!.state).toEqual(before);
    expect(await bid(fresh, "u1", 2_000_000, k)).toMatchObject({
      kind: "evaluated",
      replayed: true,
      result: { ok: true },
    });
    expect(accepted(await bid(fresh, "u3", 2_100_000))).toBe(true);
  });
});

describe("idempotency (durable, in DO SQLite)", () => {
  it("same key + same payload → original result, no second bid, no new events", async () => {
    const { stub } = await createAuction();
    const k = key();
    const first = await bid(stub, "u1", 5_000_000, k);
    const seqAfterFirst = (await stub.getAdminDetails())!.state.seq;
    const retries = await Promise.all(
      Array.from({ length: 5 }, () => bid(stub, "u1", 5_000_000, k)),
    );
    for (const r of retries) expect(r).toEqual({ ...first, replayed: true });
    const { state } = (await stub.getAdminDetails())!;
    expect(state).toMatchObject({ bidCount: 1, seq: seqAfterFirst });
  });

  it("same key + different payload → conflict, no effect", async () => {
    const { stub } = await createAuction();
    const k = key();
    await bid(stub, "u1", 5_000_000, k);
    expect(await bid(stub, "u1", 6_000_000, k)).toEqual({ kind: "conflict" });
    expect((await stub.getAdminDetails())!.state.currentPriceMinor).toBe(5_000_000);
  });

  it("rejections are replayed too (the retry sees the original answer)", async () => {
    const { stub } = await createAuction();
    const k = key();
    const first = await bid(stub, "u1", 1, k);
    expect(code(first)).toBe("BID_TOO_LOW");
    expect(await bid(stub, "u1", 1, k)).toEqual({ ...first, replayed: true });
  });

  it("keys are scoped per user", async () => {
    const { stub } = await createAuction();
    const k = key();
    expect(accepted(await bid(stub, "u1", 5_000_000, k))).toBe(true);
    expect(accepted(await bid(stub, "u2", 5_050_000, k))).toBe(true);
  });

  it("records are kept ≥ 24 h and garbage-collected by the idem-gc timer afterwards", async () => {
    const { stub } = await createAuction();
    await bid(stub, "u1", 5_000_000);
    const { timers } = await stub.opsWithAlarm();
    const gc = timers.find((t) => t.kind === "idem-gc");
    expect(gc!.dueAt - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000 - 5000);
    // Age the record artificially and run the GC handler through the alarm path.
    await runInDurableObject(stub, (_i: AuctionDO, s) => {
      s.storage.sql.exec(`UPDATE idempotency SET created_at = created_at - 86400001`);
      s.storage.sql.exec(`UPDATE timers SET due_at = 0 WHERE kind = 'idem-gc'`);
    });
    await runDurableObjectAlarm(stub);
    const left = await runInDurableObject(
      stub,
      (_i: AuctionDO, s) =>
        s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM idempotency`).one().n,
    );
    expect(left).toBe(0);
  });
});

describe("lifecycle through the DO", () => {
  it("auto-starts a scheduled auction at startsAt (alarm) and rejects bids before", async () => {
    const { stub } = await createAuction({ startsInMs: 300, closesInMs: 120_000 });
    expect(code(await bid(stub, "u1", 5_000_000))).toBe("AUCTION_NOT_LIVE");
    expect((await stub.getView(null))!.status).toBe("SCHEDULED");
    await sleep(350);
    await runDurableObjectAlarm(stub);
    await waitFor(async () => (await stub.getAdminDetails())!.state.status === "LIVE");
  });

  it("note: the AUCTION_NOT_LIVE rejection above was stored for its key (same-intent semantics)", async () => {
    const { stub } = await createAuction({ startsInMs: 200, closesInMs: 120_000 });
    const k = key();
    expect(code(await bid(stub, "u1", 5_000_000, k))).toBe("AUCTION_NOT_LIVE");
    await sleep(250);
    expect(code(await bid(stub, "u1", 5_000_000, k))).toBe("AUCTION_NOT_LIVE"); // replay
    expect(accepted(await bid(stub, "u1", 5_000_000))).toBe(true); // a new attempt uses a new key
  });

  it("closes at closesAt via the alarm, records the winner, emits exactly one ended event", async () => {
    // Anti-sniping off: these bids are within 2 minutes of close and would otherwise extend it.
    const { stub } = await createAuction({ closesInMs: 400, antiSniping: false });
    await bid(stub, "u1", 5_000_000);
    await bid(stub, "u2", 5_050_000);
    await sleep(450);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub); // at-least-once delivery: a duplicate run must be harmless
    await stub.getView(null); // and a lazy read
    const { state } = (await stub.getAdminDetails())!;
    expect(state).toMatchObject({ status: "ENDED", outcome: "SOLD", winnerUserId: "u2" });
    expect((await eventLog(stub)).filter((e) => e.type === "auction.ended")).toHaveLength(1);
  });

  it("late bids are rejected even if the close alarm has not run (lazy close)", async () => {
    const { stub } = await createAuction({ closesInMs: 150 });
    await sleep(200);
    expect(code(await bid(stub, "u1", 5_000_000))).toBe("AUCTION_ENDED");
    expect((await stub.getAdminDetails())!.state.status).toBe("ENDED");
  });

  it.each([
    ["NO_BIDS", null, []],
    // Distinctive reserve digits so the leak check cannot match a legitimate public price.
    ["RESERVE_NOT_MET", 7_777_777, [5_000_000]],
    ["SOLD", 7_777_777, [5_000_000, 8_000_000]],
  ] as const)("reserve outcome %s", async (outcome, reserve, bids) => {
    const { stub } = await createAuction({
      reserveMinor: reserve,
      closesInMs: 400,
      antiSniping: false,
    });
    for (const [i, a] of bids.entries()) await bid(stub, `u${i}`, a);
    await sleep(450);
    const view = (await stub.getView(null))!;
    expect(view).toMatchObject({ status: "ENDED", outcome, hasReserve: reserve !== null });
    expect(JSON.stringify(view)).not.toContain("7777777");
    expect((await stub.getAdminDetails())!.state.winnerUserId).toBe(
      outcome === "SOLD" ? "u1" : null,
    );
  });

  it("anti-sniping can be disabled per auction (no extension)", async () => {
    const { stub } = await createAuction({ closesInMs: 1_500, antiSniping: false });
    const before = (await stub.getAdminDetails())!.state;
    await bid(stub, "u1", 5_000_000);
    const after = (await stub.getAdminDetails())!.state;
    expect(after.closesAt).toBe(before.closesAt);
    expect(after.hardCloseAt).toBe(before.closesAt);
  });

  it("anti-sniping: a bid inside the last 2 minutes extends the close and the lifecycle alarm", async () => {
    const { stub } = await createAuction({ closesInMs: 1_500 });
    const before = (await stub.getAdminDetails())!.state.closesAt;
    const t = Date.now();
    expect(accepted(await bid(stub, "u1", 5_000_000))).toBe(true);
    const { state, ops } = (await stub.getAdminDetails())!;
    expect(state.closesAt).toBeGreaterThan(before);
    expect(state.closesAt - t).toBeGreaterThanOrEqual(119_000);
    expect(state.closesAt).toBeLessThanOrEqual(state.hardCloseAt);
    expect(state.extensionCount).toBe(1);
    expect(ops.timers.find((x) => x.kind === "lifecycle")!.dueAt).toBe(state.closesAt);
    const types = (await eventLog(stub)).map((e) => e.type);
    expect(types.slice(-2)).toEqual(["bid.accepted", "auction.extended"]);
  });

  it("admin cancel: cancelled auctions reject bids; ended auctions cannot be cancelled", async () => {
    const { stub } = await createAuction();
    await bid(stub, "u1", 5_000_000);
    expect(await stub.cancel("Odometer mismatch")).toMatchObject({
      ok: true,
      details: { state: { status: "CANCELLED" } },
    });
    expect(code(await bid(stub, "u2", 9_000_000))).toBe("AUCTION_CANCELLED");
    expect(await stub.cancel("again please")).toMatchObject({
      ok: false,
      error: { code: "AUCTION_CANCELLED" },
    });
    const ended = await createAuction({ closesInMs: 100 });
    await sleep(150);
    expect(await ended.stub.cancel("too late now")).toMatchObject({
      ok: false,
      error: { code: "AUCTION_ENDED" },
    });
  });

  it("admin edits are allowed only before the auction is live", async () => {
    const scheduled = await createAuction({ startsInMs: 60_000, closesInMs: 3_600_000 });
    expect(await scheduled.stub.update({ reserveMinor: 9_000_000 })).toMatchObject({
      ok: true,
      details: { state: { reserveMinor: 9_000_000 } },
    });
    const live = await createAuction();
    expect(await live.stub.update({ reserveMinor: 9_000_000 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRANSITION" },
    });
  });
});

describe("D1 synchronisation (outbox)", () => {
  it("projects auction summary, bids and per-user rows; replays are no-ops", async () => {
    const { stub, id } = await createAuction();
    await bid(stub, "u1", 5_000_000);
    await bid(stub, "u2", 5_050_000);
    await waitFor(async () => (await stub.ops()).pendingOutbox === 0);
    const seq = (await stub.ops()).seq;
    expect(
      await env.DB.prepare(
        `SELECT status, current_price_minor, bid_count, projection_seq, has_reserve FROM auctions_rm WHERE id = ?`,
      )
        .bind(id)
        .first(),
    ).toEqual({
      status: "LIVE",
      current_price_minor: 5_050_000,
      bid_count: 2,
      projection_seq: seq,
      has_reserve: 0,
    });
    const bids = await env.DB.prepare(
      `SELECT seq, bidder, amount_minor FROM auction_bids_rm WHERE auction_id = ? ORDER BY seq`,
    )
      .bind(id)
      .all();
    expect(bids.results.map((b) => b.amount_minor)).toEqual([5_000_000, 5_050_000]);
    expect(JSON.stringify(bids.results)).not.toMatch(/"u1"|"u2"/);
    // Force a full replay of every event: nothing changes.
    await runInDurableObject(stub, (_i: AuctionDO, s) =>
      s.storage.sql.exec(`UPDATE events SET projected_at = NULL`),
    );
    expect(await stub.retryProjection()).toBe(0);
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM auction_bids_rm WHERE auction_id = ?`)
        .bind(id)
        .first())!.n,
    ).toBe(2);
  });

  it("bidding keeps working while D1 is down; failures are tracked; it converges after recovery", async () => {
    const { stub, id } = await createAuction();
    await waitFor(async () => (await stub.ops()).pendingOutbox === 0);
    await env.DB.exec(`ALTER TABLE auctions_rm RENAME TO auctions_rm_offline`);
    try {
      expect(accepted(await bid(stub, "u1", 5_000_000))).toBe(true);
      expect(accepted(await bid(stub, "u2", 5_050_000))).toBe(true);
      await stub.retryProjection();
      const ops = await stub.ops();
      expect(ops.pendingOutbox).toBeGreaterThan(0);
      expect(ops.sync.consecutiveFailures).toBeGreaterThan(0);
      expect(ops.sync.lastError).toBeTruthy();
      expect(ops.timers.find((t) => t.kind === "outbox")!.dueAt).toBeGreaterThan(Date.now()); // backoff
      // Atomic batch: the bid rows were not half-written while the summary failed.
      expect(
        (await env.DB.prepare(`SELECT COUNT(*) AS n FROM auction_bids_rm WHERE auction_id = ?`)
          .bind(id)
          .first())!.n,
      ).toBe(0);
    } finally {
      await env.DB.exec(`ALTER TABLE auctions_rm_offline RENAME TO auctions_rm`);
    }
    // Automatic retry through the alarm once the backoff elapses.
    const due = (await stub.ops()).timers.find((t) => t.kind === "outbox")!.dueAt;
    await sleep(Math.max(0, due - Date.now()) + 50);
    await runDurableObjectAlarm(stub);
    await waitFor(async () => (await stub.ops()).pendingOutbox === 0);
    const ops = await stub.ops();
    expect(ops.sync.consecutiveFailures).toBe(0);
    expect(ops.projectedSeq).toBe(ops.seq);
    expect(
      (await env.DB.prepare(`SELECT current_price_minor FROM auctions_rm WHERE id = ?`)
        .bind(id)
        .first())!.current_price_minor,
    ).toBe(5_050_000);
  }, 30_000); // waits out real exponential backoff

  it("an older projection can never overwrite a newer one", async () => {
    const { stub, id } = await createAuction();
    await bid(stub, "u1", 5_000_000);
    await waitFor(async () => (await stub.ops()).pendingOutbox === 0);
    await env.DB.prepare(
      `UPDATE auctions_rm SET projection_seq = 999999, current_price_minor = 1 WHERE id = ?`,
    )
      .bind(id)
      .run();
    await bid(stub, "u2", 5_050_000);
    await waitFor(async () => (await stub.ops()).pendingOutbox === 0);
    expect(
      (await env.DB.prepare(`SELECT current_price_minor FROM auctions_rm WHERE id = ?`)
        .bind(id)
        .first())!.current_price_minor,
    ).toBe(1);
  });
});

describe("alarm multiplexer and recovery", () => {
  it("one alarm = earliest of lifecycle / outbox / idem-gc timers", async () => {
    const { stub } = await createAuction({ closesInMs: 10 * 60_000 });
    await bid(stub, "u1", 5_000_000);
    await waitFor(async () => (await stub.ops()).pendingOutbox === 0);
    const { alarm, timers } = await stub.opsWithAlarm();
    expect(timers.map((t) => t.kind).sort()).toEqual(["idem-gc", "lifecycle"]);
    expect(alarm).toBe(Math.min(...timers.map((t) => t.dueAt)));
  });

  it("restores lost timers after a restart (lifecycle, outbox, idem-gc)", async () => {
    const { stub, id } = await createAuction();
    await bid(stub, "u1", 5_000_000);
    await runInDurableObject(stub, (_i: AuctionDO, s) => {
      s.storage.sql.exec(
        `UPDATE events SET projected_at = NULL WHERE seq = (SELECT MAX(seq) FROM events)`,
      );
      s.storage.sql.exec(`DELETE FROM timers`);
    });
    await evictDurableObject(stub);
    const kinds = (await auctionStub(id).ops()).timers.map((t) => t.kind).sort();
    expect(kinds).toEqual(["idem-gc", "lifecycle", "outbox"]);
  });

  it("refuses to commit a non-contiguous event sequence (corruption guard)", async () => {
    const { stub } = await createAuction();
    await expect(
      runInDurableObject(stub, (instance: AuctionDO) => {
        const s = (instance as unknown as { load(): { seq: number } }).load();
        (instance as unknown as { commit(e: unknown[], n: unknown): void }).commit(
          [{ type: "auction.started", seq: s.seq + 5, at: 0, startedAt: 0 }],
          { ...s, seq: s.seq + 5 },
        );
      }),
    ).rejects.toThrow(/Non-contiguous/);
  });
});

describe("SPIKE (Day 1): why the critical section must not await", () => {
  it("awaiting between check and write lets concurrent bids interleave (lost update)", async () => {
    const probe = env.SPIKE_PROBE.get(env.SPIKE_PROBE.newUniqueId());
    const results = await Promise.all(Array.from({ length: 10 }, () => probe.bidUnsafe(200)));
    expect(results.filter(Boolean).length).toBeGreaterThan(1);
  });

  it("synchronous check-and-write admits exactly one", async () => {
    const probe = env.SPIKE_PROBE.get(env.SPIKE_PROBE.newUniqueId());
    const results = await Promise.all(Array.from({ length: 10 }, () => probe.bidSafe(200)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a naive second setAlarm() silently overwrites the first", async () => {
    const probe = env.SPIKE_PROBE.get(env.SPIKE_PROBE.newUniqueId());
    const t = Date.now() + 60_000;
    expect(await probe.naiveTwoAlarms(t, t + 30_000)).toBe(t + 30_000);
  });
});
