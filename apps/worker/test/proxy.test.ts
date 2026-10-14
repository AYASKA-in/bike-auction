import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  BidHistoryPage,
  ProblemDetails,
  PublicAuctionView,
  SetMaxBidResult,
  WsServerMessage,
} from "@bike/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionDO } from "../src/auction/auction-do";
import { BASE, mockTurnstile, signIn, signUp } from "./auth-helpers";
import { auctionStub, bid, createAuction, eventLog, key, sleep, waitFor } from "./helpers";
import { connect, until } from "./ws-helpers";

type Stub = ReturnType<typeof auctionStub>;
const setMax = (stub: Stub, userId: string, maxMinor: number, idempotencyKey = key()) =>
  stub.setMaxBid({ userId, maxMinor, idempotencyKey, requestId: "req_test" });

async function ledger(stub: Stub) {
  return runInDurableObject(stub, (_i: AuctionDO, s) =>
    s.storage.sql
      .exec<{ seq: number; user_id: string; amount_minor: number; kind: string }>(
        `SELECT seq, user_id, amount_minor, kind FROM bids ORDER BY seq`,
      )
      .toArray()
      .map((r) => [r.user_id, r.amount_minor, r.kind]),
  );
}
const state = async (stub: Stub) => (await stub.getAdminDetails())!.state;

describe("AuctionDO: proxy resolution", () => {
  it("two maxima resolve eBay-style; automatic steps are ledger rows with kind PROXY", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000 });
    expect(await setMax(stub, "A", 6_000_000)).toMatchObject({
      kind: "evaluated",
      replayed: false,
      result: { ok: true, maxMinor: 6_000_000, isLeading: true, currentPriceMinor: 5_000_000 },
    });
    expect(await setMax(stub, "B", 7_000_000)).toMatchObject({
      result: {
        ok: true,
        isLeading: true,
        currentPriceMinor: 6_050_000,
        minNextBidMinor: 6_100_000,
      },
    });
    expect(await ledger(stub)).toEqual([
      ["A", 5_000_000, "PROXY"],
      ["A", 6_000_000, "PROXY"],
      ["B", 6_050_000, "PROXY"],
    ]);
    expect(await state(stub)).toMatchObject({ leaderUserId: "B", currentPriceMinor: 6_050_000 });
    const log = await eventLog(stub);
    log.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it("manual bid vs maximum: recorded, then countered in the same atomic commit", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000 });
    await setMax(stub, "A", 6_000_000);
    const seqBefore = (await state(stub)).seq;
    const r = await bid(stub, "X", 5_050_000);
    expect(r).toMatchObject({
      kind: "evaluated",
      result: { ok: true, amountMinor: 5_050_000, seq: seqBefore + 1, minNextBidMinor: 5_150_000 },
    });
    expect((await state(stub)).seq).toBe(seqBefore + 2);
    expect((await ledger(stub)).slice(-2)).toEqual([
      ["X", 5_050_000, "MANUAL"],
      ["A", 5_100_000, "PROXY"],
    ]);
  });

  it("ties: equal maxima → earlier wins; a manual bid equal to a maximum is rejected", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000 });
    await setMax(stub, "A", 6_000_000);
    expect(await setMax(stub, "B", 6_000_000)).toMatchObject({
      result: { ok: true, isLeading: false, currentPriceMinor: 6_000_000 },
    });
    expect((await state(stub)).leaderUserId).toBe("A");
    const { stub: s2 } = await createAuction({ startPriceMinor: 5_000_000 });
    await setMax(s2, "A", 6_000_000);
    expect(await bid(s2, "X", 6_000_000)).toMatchObject({
      result: { ok: false, code: "BID_TOO_LOW", minNextBidMinor: 6_050_000 },
    });
    // The automatic step committed with the rejection.
    expect((await ledger(s2)).at(-1)).toEqual(["A", 6_000_000, "PROXY"]);
  });

  it("the leader raises their own maximum: no new bid, no seq change; manual self-outbid still refused", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000 });
    await setMax(stub, "A", 6_000_000);
    const before = await state(stub);
    expect(await setMax(stub, "A", 9_000_000)).toMatchObject({
      result: { ok: true, isLeading: true, maxMinor: 9_000_000, seq: before.seq },
    });
    expect((await state(stub)).seq).toBe(before.seq);
    expect(await stub.getView("A")).toMatchObject({ viewer: { myMaxMinor: 9_000_000 } });
    expect(await bid(stub, "A", 5_500_000)).toMatchObject({
      result: { ok: false, code: "ALREADY_LEADING" },
    });
    // Lowering below the minimum next bid is refused with the minimum.
    expect(await setMax(stub, "A", 5_000_000)).toMatchObject({
      result: { ok: false, code: "BID_TOO_LOW", minNextBidMinor: 5_050_000 },
    });
  });

  it("reserve: a maximum covering the reserve lifts the price to exactly the reserve", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000, reserveMinor: 6_000_000 });
    expect(await setMax(stub, "A", 7_000_000)).toMatchObject({
      result: { ok: true, currentPriceMinor: 6_000_000 },
    });
    expect(await stub.getView(null)).toMatchObject({
      reserveMet: true,
      currentPriceMinor: 6_000_000,
    });
  });

  it("fat-finger: a maximum above 3× the reference price is BID_UNREASONABLE", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000 });
    expect(await setMax(stub, "A", 15_000_001)).toMatchObject({
      result: { ok: false, code: "BID_UNREASONABLE", maxAcceptableMinor: 15_000_000 },
    });
    expect((await state(stub)).bidCount).toBe(0);
  });

  it("soft close: an automatic counter-bid inside the window extends once, after both bids", async () => {
    const { stub } = await createAuction({ closesInMs: 1_500 });
    await setMax(stub, "A", 6_000_000); // also inside the window: extends once
    const mid = await state(stub);
    expect(mid.extensionCount).toBe(1);
    await sleep(5); // so the second extension moves the close by a measurable amount
    await bid(stub, "X", 5_050_000);
    const types = (await eventLog(stub)).map((e) => e.type);
    expect(types.slice(-3)).toEqual(["bid.accepted", "bid.accepted", "auction.extended"]);
    const { state: s, ops } = (await stub.getAdminDetails())!;
    expect(s.closesAt).toBeGreaterThanOrEqual(mid.closesAt);
    expect(s.closesAt).toBeLessThanOrEqual(s.hardCloseAt);
    expect(ops.timers.find((t) => t.kind === "lifecycle")!.dueAt).toBe(s.closesAt);
  });

  it("idempotent replay, key conflicts across commands, and the shared persistent throttle", async () => {
    const { stub } = await createAuction({ startPriceMinor: 5_000_000 });
    const k = key();
    const first = await setMax(stub, "A", 6_000_000, k);
    const seq = (await state(stub)).seq;
    expect(await setMax(stub, "A", 6_000_000, k)).toEqual({ ...first, replayed: true });
    expect((await state(stub)).seq).toBe(seq); // no second effect
    expect(await setMax(stub, "A", 6_500_000, k)).toEqual({ kind: "conflict" });
    expect(await bid(stub, "A", 6_000_000, k)).toEqual({ kind: "conflict" }); // bid key ≠ max key
    // 10 new commands per 10 s per user, bids and maxima together.
    for (let i = 0; i < 8; i++) expect((await setMax(stub, "S", 1)).kind).toBe("evaluated");
    expect((await bid(stub, "S", 1)).kind).toBe("evaluated");
    expect((await bid(stub, "S", 1)).kind).toBe("evaluated");
    expect((await setMax(stub, "S", 7_000_000)).kind).toBe("rate_limited");
    expect((await setMax(stub, "A", 6_000_000, k)).kind).toBe("evaluated"); // replays never throttled
  });

  it("eviction/restart keeps maxima (only in proxy_bids, never in state_json or events)", async () => {
    const { stub, id } = await createAuction({ startPriceMinor: 5_000_000 });
    const MAX = 9_123_437;
    await setMax(stub, "A", MAX);
    await evictDurableObject(stub);
    const fresh = auctionStub(id);
    expect(await fresh.getView("A")).toMatchObject({ viewer: { myMaxMinor: MAX } });
    await bid(fresh, "X", 5_500_000);
    expect((await ledger(fresh)).at(-1)).toEqual(["A", 5_550_000, "PROXY"]);
    const stored = await runInDurableObject(fresh, (_i: AuctionDO, s) => ({
      state: s.storage.sql.exec<{ j: string }>(`SELECT state_json AS j FROM auction_state`).one().j,
      events: s.storage.sql
        .exec<{ p: string }>(`SELECT payload_json AS p FROM events`)
        .toArray()
        .map((r) => r.p)
        .join("\n"),
      proxies: s.storage.sql.exec(`SELECT user_id, max_minor FROM proxy_bids`).toArray(),
    }));
    expect(stored.state).not.toContain(String(MAX));
    expect(stored.state).not.toContain("proxies");
    expect(stored.events).not.toContain(String(MAX));
    expect(stored.proxies).toEqual([{ user_id: "A", max_minor: MAX }]);
    expect(JSON.stringify(await fresh.getAdminDetails())).not.toContain(String(MAX)); // not even admins
  });

  it("concurrent setMaxBid calls serialise: highest max leads, price follows the rule, gap-free ledger", async () => {
    const { stub } = await createAuction({ startPriceMinor: 1_000_000 });
    const maxes = Array.from({ length: 30 }, (_, i) => 1_000_000 + ((i * 7919) % 30) * 25_000);
    const results = await Promise.all(maxes.map((m, i) => setMax(stub, `u${i}`, m)));
    expect(results.every((r) => r.kind === "evaluated")).toBe(true);
    const ok = results.filter((r) => r.kind === "evaluated" && r.result.ok).length;
    expect(ok).toBeGreaterThan(0);
    const rows = await ledger(stub);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]![1]).toBeGreaterThan(rows[i - 1]![1] as number);
    (await eventLog(stub)).forEach((e, i) => expect(e.seq).toBe(i + 1));
    const proxies = await runInDurableObject(stub, (_i: AuctionDO, s) =>
      s.storage.sql
        .exec<{ user_id: string; max_minor: number; set_seq: number }>(
          `SELECT user_id, max_minor, set_seq FROM proxy_bids ORDER BY max_minor DESC, set_seq ASC`,
        )
        .toArray(),
    );
    const s = await state(stub);
    expect(s.leaderUserId).toBe(proxies[0]!.user_id); // highest max, earliest on ties
    expect(s.currentPriceMinor).toBeLessThanOrEqual(proxies[0]!.max_minor);
    const second = proxies[1]!.max_minor;
    const inc = second < 2_500_000 ? 25_000 : 50_000;
    expect(s.currentPriceMinor).toBe(Math.min(proxies[0]!.max_minor, second + inc));
  });
});

// ───────────────────────────── HTTP API + privacy ─────────────────────────────

let spy: ReturnType<typeof mockTurnstile>;
beforeEach(() => {
  spy = mockTurnstile();
});
afterEach(() => spy.mockRestore());

let alice = "";
let bob = "";
let admin = "";
beforeAll(async () => {
  spy = mockTurnstile();
  alice = (await signUp()).cookie;
  bob = (await signUp()).cookie;
  const a = await signUp();
  await env.DB.prepare(`UPDATE "user" SET role = 'ADMIN' WHERE email = ?`).bind(a.email).run();
  admin = (await signIn(a.email, a.password)).cookie;
  spy.mockRestore();
});

function api(
  method: string,
  path: string,
  opts: { cookie?: string | undefined; key?: string | null; body?: unknown } = {},
) {
  const headers: Record<string, string> = { origin: BASE, "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.key !== null) headers["idempotency-key"] = opts.key ?? `k-${crypto.randomUUID()}`;
  return exports.default.fetch(`${BASE}/api/v1${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}
const putMax = (id: string, cookie: string, maxMinor: unknown, k?: string | null) =>
  api("PUT", `/auctions/${id}/max-bid`, {
    cookie,
    body: { maxMinor },
    ...(k === undefined ? {} : { key: k }),
  });
const problem = async (res: Response) => ProblemDetails.parse(await res.json());
const view = async (id: string, cookie?: string) =>
  PublicAuctionView.parse(await (await api("GET", `/auctions/${id}`, { cookie })).json());

describe("PUT /auctions/:id/max-bid", () => {
  it("sets a maximum (200, strict body) and replays with the same key", async () => {
    const { id } = await createAuction({ startPriceMinor: 5_000_000 });
    const k = key();
    const res = await putMax(id, alice, 6_000_000, k);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBe("false");
    const body = SetMaxBidResult.parse(await res.json());
    expect(body).toMatchObject({
      maxMinor: 6_000_000,
      isLeading: true,
      currentPriceMinor: 5_000_000,
      minNextBidMinor: 5_050_000,
    });
    const again = await putMax(id, alice, 6_000_000, k);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(body);
    expect((await problem(await putMax(id, alice, 7_000_000, k))).code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("authentication, authorization and validation", async () => {
    const { id } = await createAuction();
    expect((await problem(await putMax(id, "", 6_000_000))).code).toBe("AUTH_REQUIRED");
    expect((await putMax(id, admin, 6_000_000)).status).toBe(403);
    expect((await putMax("auc-missing-123", alice, 6_000_000)).status).toBe(404);
    expect((await problem(await putMax(id, alice, 6_000_000, null))).code).toBe(
      "VALIDATION_FAILED",
    );
    for (const bad of [-1, 0, 10.5, "6000000", null]) {
      expect((await problem(await putMax(id, alice, bad))).code).toBe("BID_INVALID_AMOUNT");
    }
    const extra = await api("PUT", `/auctions/${id}/max-bid`, {
      cookie: alice,
      body: { maxMinor: 6_000_000, userId: "someone-else" },
    });
    expect(extra.status).toBe(422);
    const low = await putMax(id, alice, 4_000_000);
    expect(low.status).toBe(409);
    expect(await problem(low)).toMatchObject({ code: "BID_TOO_LOW", minNextBidMinor: 5_000_000 });
    const huge = await putMax(id, alice, 15_000_001);
    expect(await problem(huge)).toMatchObject({
      code: "BID_UNREASONABLE",
      maxAcceptableMinor: 15_000_000,
    });
  });

  it("privacy: the max is visible only to its owner — views, history, WS, D1 and logs", async () => {
    const MAX = 9_123_437;
    const { id, stub } = await createAuction({ startPriceMinor: 5_000_000 });
    const logs: string[] = [];
    const capture = (...a: unknown[]) => void logs.push(a.map((x) => String(x)).join(" "));
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(capture),
    );
    const aliceWs = await connect(id, { cookie: alice });
    const bobWs = await connect(id, { cookie: bob });
    const anonWs = await connect(id);
    await until(() => [aliceWs, bobWs, anonWs].every((w) => w.messages.length >= 2));
    try {
      expect((await putMax(id, alice, MAX)).status).toBe(200);
      const bobBid = await api("POST", `/auctions/${id}/bids`, {
        cookie: bob,
        body: { amountMinor: 5_500_000 },
      });
      expect(bobBid.status).toBe(201);
      await until(() => bobWs.messages.filter((m) => m.type === "bid.accepted").length >= 3);
      await until(() => bobWs.messages.some((m) => m.type === "you.outbid"));
      await waitFor(async () => (await stub.ops()).pendingOutbox === 0);
    } finally {
      for (const s of spies) s.mockRestore();
    }

    // Owner sees their own max; others never do.
    expect((await view(id, alice)).viewer).toMatchObject({ isLeading: true, myMaxMinor: MAX });
    expect((await view(id, bob)).viewer).toEqual({
      isLeading: false,
      isWinner: false,
      myMaxMinor: null,
    });
    const anonJson = JSON.stringify(await view(id));
    const bobJson = JSON.stringify(await view(id, bob));
    const history = BidHistoryPage.parse(
      await (await api("GET", `/auctions/${id}/bids`, { cookie: bob })).json(),
    );
    expect(history.items.map((b) => [b.amountMinor, b.kind])).toEqual([
      [5_550_000, "PROXY"],
      [5_500_000, "MANUAL"],
      [5_000_000, "PROXY"],
    ]);
    const historyAlice = await (await api("GET", `/auctions/${id}/bids`, { cookie: alice })).text();
    for (const m of [...bobWs.messages, ...anonWs.messages, ...aliceWs.messages])
      expect(WsServerMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
    const othersWs = JSON.stringify([bobWs.messages, anonWs.messages]);
    const d1 = JSON.stringify([
      (await env.DB.prepare(`SELECT * FROM auctions_rm WHERE id = ?`).bind(id).all()).results,
      (await env.DB.prepare(`SELECT * FROM auction_bids_rm WHERE auction_id = ?`).bind(id).all())
        .results,
      (await env.DB.prepare(`SELECT * FROM user_bids_rm WHERE auction_id = ?`).bind(id).all())
        .results,
    ]);
    for (const out of [anonJson, bobJson, JSON.stringify(history), historyAlice, othersWs, d1])
      expect(out).not.toContain(String(MAX));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(String(MAX));

    // Alice's own sockets learn her max and that her proxy (not her client) is leading.
    const snaps = aliceWs.messages.filter((m) => m.type === "auction.snapshot");
    expect(snaps.at(-1)).toMatchObject({ view: { viewer: { isLeading: true, myMaxMinor: MAX } } });
    // Bob was countered by a maximum in the same commit → he is told; Alice never was outbid.
    expect(bobWs.messages.find((m) => m.type === "you.outbid")).toMatchObject({
      currentPriceMinor: 5_550_000,
    });
    expect(aliceWs.messages.some((m) => m.type === "you.outbid")).toBe(false);
    expect(bobWs.messages.filter((m) => m.type === "bid.accepted").map((m) => m.kind)).toEqual([
      "PROXY",
      "MANUAL",
      "PROXY",
    ]);
    for (const c of [aliceWs, bobWs, anonWs]) c.ws?.close();
  });

  it("a proxy overtaking the leader notifies exactly that leader", async () => {
    const { id } = await createAuction({ startPriceMinor: 5_000_000 });
    const aliceWs = await connect(id, { cookie: alice });
    const bobWs = await connect(id, { cookie: bob });
    await until(() => aliceWs.messages.length >= 2 && bobWs.messages.length >= 2);
    await api("POST", `/auctions/${id}/bids`, { cookie: alice, body: { amountMinor: 5_000_000 } });
    const res = await putMax(id, bob, 8_000_000);
    expect(SetMaxBidResult.parse(await res.json())).toMatchObject({
      isLeading: true,
      currentPriceMinor: 5_050_000,
    });
    await until(() => aliceWs.messages.some((m) => m.type === "you.outbid"));
    expect(aliceWs.messages.find((m) => m.type === "you.outbid")).toMatchObject({
      currentPriceMinor: 5_050_000,
      minNextBidMinor: 5_100_000,
    });
    await until(() => bobWs.messages.filter((m) => m.type === "auction.snapshot").length >= 2);
    expect(bobWs.messages.some((m) => m.type === "you.outbid")).toBe(false);
    for (const c of [aliceWs, bobWs]) c.ws?.close();
  });
});
