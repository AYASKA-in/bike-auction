import { env, exports } from "cloudflare:workers";
import { ProblemDetails, PublicAuctionView } from "@bike/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE, cookieFrom, mockTurnstile, signIn, signUp } from "./auth-helpers";
import { createAuction } from "./helpers";
import { connect, until } from "./ws-helpers";

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
  opts: { cookie?: string; key?: string | null; body?: unknown } = {},
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
const placeBid = (id: string, cookie: string, amountMinor: unknown, key?: string | null) =>
  api("POST", `/auctions/${id}/bids`, {
    cookie,
    body: { amountMinor },
    ...(key === undefined ? {} : { key }),
  });
const problem = async (res: Response) => ProblemDetails.parse(await res.json());

describe("POST /auctions/:id/bids", () => {
  it("accepts a valid bid (201) and the auction view reflects it", async () => {
    const { id } = await createAuction({ startPriceMinor: 5_000_000 });
    const res = await placeBid(id, alice, 5_000_000);
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBe("false");
    expect(await res.json()).toMatchObject({
      seq: expect.any(Number),
      amountMinor: 5_000_000,
      minNextBidMinor: 5_050_000,
    });
    const view = PublicAuctionView.parse(
      await (await api("GET", `/auctions/${id}`, { cookie: alice })).json(),
    );
    expect(view).toMatchObject({ currentPriceMinor: 5_000_000, viewer: { isLeading: true } });
    const bobView = PublicAuctionView.parse(
      await (await api("GET", `/auctions/${id}`, { cookie: bob })).json(),
    );
    expect(bobView.viewer).toEqual({ isLeading: false, isWinner: false });
  });

  it("authentication and authorization", async () => {
    const { id } = await createAuction();
    expect((await problem(await placeBid(id, "", 5_000_000))).code).toBe("AUTH_REQUIRED");
    const adminRes = await placeBid(id, admin, 5_000_000);
    expect(adminRes.status).toBe(403); // administrators cannot bid
    expect((await placeBid("auc-missing-123", alice, 5_000_000)).status).toBe(404);
  });

  it("validates input and requires an Idempotency-Key", async () => {
    const { id } = await createAuction();
    expect((await problem(await placeBid(id, alice, 5_000_000, null))).code).toBe(
      "VALIDATION_FAILED",
    );
    expect((await problem(await placeBid(id, alice, 5_000_000, "short"))).code).toBe(
      "VALIDATION_FAILED",
    );
    for (const bad of [-1, 0, 10.5, "5000000", null]) {
      expect((await problem(await placeBid(id, alice, bad))).code).toBe("BID_INVALID_AMOUNT");
    }
    const extra = await api("POST", `/auctions/${id}/bids`, {
      cookie: alice,
      body: { amountMinor: 5_000_000, userId: "someone-else" },
    });
    expect(extra.status).toBe(422); // strict body: identity can never come from the client
  });

  it("enforces the minimum with a machine-readable problem", async () => {
    const { id } = await createAuction({ startPriceMinor: 5_000_000 });
    const res = await placeBid(id, alice, 4_000_000);
    expect(res.status).toBe(409);
    expect(await problem(res)).toMatchObject({ code: "BID_TOO_LOW", minNextBidMinor: 5_000_000 });
  });

  it("network failure after the bid is saved: retrying the same key returns the original result", async () => {
    const { id, stub } = await createAuction();
    const key = `k-${crypto.randomUUID()}`;
    const first = await placeBid(id, alice, 5_000_000, key);
    const firstBody = await first.json(); // pretend this response was lost in transit
    const retry = await placeBid(id, alice, 5_000_000, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await retry.json()).toEqual(firstBody);
    expect((await stub.getAdminDetails())!.state.bidCount).toBe(1);
    const changed = await placeBid(id, alice, 6_000_000, key);
    expect(changed.status).toBe(422);
    expect((await problem(changed)).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("notifies only the outbid user, over their authenticated socket", async () => {
    const { id } = await createAuction();
    const aliceWs = await connect(id, { cookie: alice });
    const bobWs = await connect(id, { cookie: bob });
    await until(() => aliceWs.messages.length >= 2 && bobWs.messages.length >= 2);
    await placeBid(id, alice, 5_000_000);
    await placeBid(id, bob, 5_050_000);
    await until(() => aliceWs.messages.some((m) => m.type === "you.outbid"));
    expect(aliceWs.messages.find((m) => m.type === "you.outbid")).toMatchObject({
      currentPriceMinor: 5_050_000,
      minNextBidMinor: 5_100_000,
    });
    await until(() => bobWs.messages.filter((m) => m.type === "bid.accepted").length === 2);
    expect(bobWs.messages.some((m) => m.type === "you.outbid")).toBe(false);
    aliceWs.ws?.close();
    bobWs.ws?.close();
  });
});

describe("GET /auctions/:id/bids (cursor pagination)", () => {
  it("returns pseudonymous history newest-first with a seq cursor", async () => {
    const { id } = await createAuction({ startPriceMinor: 1_000_000 });
    const cookies = [alice, bob];
    for (let i = 0; i < 5; i++) await placeBid(id, cookies[i % 2]!, 1_000_000 + i * 25_000);
    const p1 = (await (
      await api("GET", `/auctions/${id}/bids?limit=2`, { cookie: alice })
    ).json()) as {
      items: { seq: number; bidder: string; amountMinor: number; isYou: boolean }[];
      nextBeforeSeq: number;
    };
    expect(p1.items.map((b) => b.amountMinor)).toEqual([1_100_000, 1_075_000]);
    expect(p1.items[0]!.isYou).toBe(true);
    const p2 = (await (
      await api("GET", `/auctions/${id}/bids?limit=2&beforeSeq=${p1.nextBeforeSeq}`)
    ).json()) as typeof p1;
    expect(p2.items.map((b) => b.amountMinor)).toEqual([1_050_000, 1_025_000]);
    expect(p2.items.every((b) => b.isYou === false)).toBe(true); // anonymous viewer
    const bidders = new Set([...p1.items, ...p2.items].map((b) => b.bidder));
    expect(bidders.size).toBe(2);
    expect(JSON.stringify([p1, p2])).not.toMatch(/userId|user_id/);
    expect((await api("GET", `/auctions/${id}/bids?limit=500`)).status).toBe(422);
  });
});

describe("admin auction API", () => {
  it("creates, edits, schedules and cancels with audit log entries; buyers cannot", async () => {
    const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const closesAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const created = await api("POST", "/admin/auctions", {
      cookie: admin,
      body: {
        startPriceMinor: 4_500_000,
        reserveMinor: 6_000_000,
        startsAt,
        closesAt,
        schedule: false,
      },
    });
    expect(created.status).toBe(201);
    const { state } = (await created.json()) as {
      state: { auctionId: string; status: string; reserveMinor: number };
    };
    expect(state).toMatchObject({ status: "DRAFT", reserveMinor: 6_000_000 });
    const id = state.auctionId;
    expect(
      (
        await api("PATCH", `/admin/auctions/${id}`, {
          cookie: admin,
          body: { reserveMinor: 6_500_000 },
        })
      ).status,
    ).toBe(200);
    expect((await api("POST", `/admin/auctions/${id}/schedule`, { cookie: admin })).status).toBe(
      200,
    );
    const buyerView = (await (
      await api("GET", `/auctions/${id}`, { cookie: alice })
    ).json()) as Record<string, unknown>;
    expect(buyerView).toMatchObject({ status: "SCHEDULED", hasReserve: true });
    expect(JSON.stringify(buyerView)).not.toContain("6500000");
    expect(
      (
        await api("POST", `/admin/auctions/${id}/cancel`, {
          cookie: alice,
          body: { reason: "nope nope" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("POST", `/admin/auctions/${id}/cancel`, { cookie: admin, body: { reason: "x" } }))
        .status,
    ).toBe(422);
    expect(
      (
        await api("POST", `/admin/auctions/${id}/cancel`, {
          cookie: admin,
          body: { reason: "Duplicate listing" },
        })
      ).status,
    ).toBe(200);
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_log WHERE resource_id = ? ORDER BY created_at`,
    )
      .bind(id)
      .all();
    expect(audit.results.map((r) => r.action)).toEqual([
      "AUCTION_CREATED",
      "AUCTION_UPDATED",
      "AUCTION_SCHEDULED",
      "AUCTION_CANCELLED",
    ]);
    const details = (await (
      await api("GET", `/admin/auctions/${id}`, { cookie: admin })
    ).json()) as { state: { status: string }; ops: { seq: number } };
    expect(details.state.status).toBe("CANCELLED");
  });

  it("validates admin input", async () => {
    const res = await api("POST", "/admin/auctions", {
      cookie: admin,
      body: { startPriceMinor: 0, startsAt: "nope", closesAt: "nope" },
    });
    expect(res.status).toBe(422);
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const tooShort = await api("POST", "/admin/auctions", {
      cookie: admin,
      body: { startPriceMinor: 100, startsAt: iso(0), closesAt: iso(1000) },
    });
    expect((await problem(tooShort)).code).toBe("VALIDATION_FAILED");
  });
});

void cookieFrom;
