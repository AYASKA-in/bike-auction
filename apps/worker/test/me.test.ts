import { env, exports } from "cloudflare:workers";
import { MyBidsPage, Watchlist, WatchlistIds, type MyBidsTab } from "@bike/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, mockTurnstile, signIn, signUp } from "./auth-helpers";
import { call, createAuctionFor, inspectedBike, iso } from "./catalogue-helpers";
import { auctionStub, sleep } from "./helpers";

let admin = "";
let alice = "";
let bob = "";
let carol = "";
const emails: Record<string, string> = {};

beforeAll(async () => {
  const spy = mockTurnstile();
  try {
    const a = await signUp();
    const b = await signUp();
    const c = await signUp();
    alice = a.cookie;
    bob = b.cookie;
    carol = c.cookie;
    Object.assign(emails, { alice: a.email, bob: b.email, carol: c.email });
    const ad = await signUp();
    await env.DB.prepare(`UPDATE "user" SET role = 'ADMIN' WHERE email = ?`).bind(ad.email).run();
    admin = (await signIn(ad.email, ad.password)).cookie;
  } finally {
    spy.mockRestore();
  }
});

const userId = async (email: string) =>
  (await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
    .bind(email)
    .first<{ id: string }>())!.id;

/** A scheduled (by default already live) auction on a fresh inspected bike. */
async function auction(over: Record<string, unknown> = {}): Promise<string> {
  const bike = await inspectedBike(admin, { make: "Jawa", model: "42" });
  const res = await createAuctionFor(admin, bike, { schedule: true, ...over });
  const body = (await res.json()) as { state?: { auctionId: string } };
  if (!body.state) throw new Error(`auction fixture: ${res.status} ${JSON.stringify(body)}`);
  return body.state.auctionId;
}

function placeBid(id: string, cookie: string, amountMinor: number) {
  return exports.default.fetch(`${BASE}/api/v1/auctions/${id}/bids`, {
    method: "POST",
    headers: {
      origin: BASE,
      cookie,
      "content-type": "application/json",
      "idempotency-key": `k-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ amountMinor }),
  });
}
async function bidOk(id: string, cookie: string, amountMinor: number) {
  const res = await placeBid(id, cookie, amountMinor);
  expect(res.status, await res.clone().text()).toBe(201);
}
const project = (...ids: string[]) =>
  Promise.all(ids.map((id) => auctionStub(id).retryProjection()));

async function tab(cookie: string, t: MyBidsTab, qs = "") {
  const res = await call("GET", `/me/bids?tab=${t}${qs}`, { cookie });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return MyBidsPage.parse(await res.json());
}
const ids = async (cookie: string, t: MyBidsTab) =>
  (await tab(cookie, t)).items.map((i) => i.auctionId).sort();
const watchIds = async (cookie: string) =>
  WatchlistIds.parse(await (await call("GET", "/me/watchlist/ids", { cookie })).json()).ids;

describe("authorization: /me/bids and /me/watchlist", () => {
  const ENDPOINTS = [
    ["GET", "/me/bids"],
    ["GET", "/me/watchlist"],
    ["GET", "/me/watchlist/ids"],
    ["PUT", "/me/watchlist/auc_missing_1"],
    ["DELETE", "/me/watchlist/auc_missing_1"],
  ] as const;

  it.each(ENDPOINTS)("%s %s → anonymous 401", async (method, path) => {
    expect((await call(method, path)).status).toBe(401);
  });

  it.each(ENDPOINTS)("%s %s → admin 403", async (method, path) => {
    expect((await call(method, path, { cookie: admin })).status).toBe(403);
  });

  it.each(ENDPOINTS)("%s %s → buyer passes authorization", async (method, path) => {
    const res = await call(method, path, { cookie: alice });
    expect([401, 403]).not.toContain(res.status);
  });

  it("GET /me stays available to administrators", async () => {
    expect((await call("GET", "/me", { cookie: admin })).status).toBe(200);
  });

  it("watchlist writes pass the global CSRF origin guard", async () => {
    const id = await auction();
    for (const method of ["PUT", "DELETE"]) {
      const res = await exports.default.fetch(`${BASE}/api/v1/me/watchlist/${id}`, {
        method,
        headers: { cookie: alice, origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
    }
    expect(await watchIds(alice)).not.toContain(id);
  });

  it("validates the query", async () => {
    expect((await call("GET", "/me/bids?tab=winning", { cookie: alice })).status).toBe(422);
    expect((await call("GET", "/me/bids?limit=49", { cookie: alice })).status).toBe(422);
    expect((await call("GET", "/me/bids?cursor=garbage", { cookie: alice })).status).toBe(422);
  });
});

describe("GET /me/bids: live tabs from real bids", () => {
  let x = "";
  let y = "";
  beforeAll(async () => {
    x = await auction();
    y = await auction();
    await bidOk(x, alice, 5_000_000);
    await bidOk(x, bob, 5_050_000);
    await bidOk(y, alice, 5_000_000);
    await project(x, y);
  });

  it("leading = live and your bid is the latest; outbid = live and someone bid after you", async () => {
    expect(await ids(alice, "leading")).toEqual([y]);
    expect(await ids(alice, "outbid")).toEqual([x]);
    expect(await ids(bob, "leading")).toEqual([x]);
    expect(await ids(bob, "outbid")).toEqual([]);
    const card = (await tab(alice, "outbid")).items[0]!;
    expect(card).toMatchObject({
      auctionId: x,
      status: "LIVE",
      outcome: null,
      myHighestMinor: 5_000_000,
      currentPriceMinor: 5_050_000,
      bidCount: 2,
      isLeading: false,
      title: expect.stringContaining("Jawa"),
    });
    expect((await tab(alice, "leading")).items[0]!.isLeading).toBe(true);
  });

  it("re-bidding moves the auction back to leading (and the rival to outbid)", async () => {
    await bidOk(x, alice, 5_100_000);
    await project(x);
    expect(await ids(alice, "leading")).toEqual([x, y].sort());
    expect(await ids(alice, "outbid")).toEqual([]);
    expect(await ids(bob, "outbid")).toEqual([x]);
    const card = (await tab(alice, "leading")).items.find((i) => i.auctionId === x)!;
    expect(card).toMatchObject({ myHighestMinor: 5_100_000, currentPriceMinor: 5_100_000 });
  });

  it("paginates with a keyset cursor bound to its tab", async () => {
    const p1 = await tab(alice, "leading", "&limit=1");
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await tab(alice, "leading", `&limit=1&cursor=${p1.nextCursor}`);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.auctionId))).toEqual(new Set([x, y]));
    expect(
      (await call("GET", `/me/bids?tab=outbid&cursor=${p1.nextCursor}`, { cookie: alice })).status,
    ).toBe(422);
  });

  it("is isolated per user and never leaks ids, pseudonyms or reserve amounts", async () => {
    expect(await ids(carol, "leading")).toEqual([]);
    expect(await ids(bob, "leading")).not.toContain(y);
    const [aId, bId] = [await userId(emails.alice!), await userId(emails.bob!)];
    for (const t of ["leading", "outbid", "won", "lost"] as const) {
      for (const cookie of [alice, bob]) {
        const raw = await (await call("GET", `/me/bids?tab=${t}`, { cookie })).text();
        expect(raw).not.toContain(aId);
        expect(raw).not.toContain(bId);
        expect(raw).not.toContain("7777777"); // fixture reserve
        expect(raw).not.toContain("Bidder ");
      }
    }
  });
});

describe("GET /me/bids: finished auctions", () => {
  let sold = "";
  let unmet = "";
  let cancelled = "";
  beforeAll(async () => {
    const short = { startsAt: iso(-61_000), closesAt: iso(3_000), antiSniping: false };
    sold = await auction({ ...short, reserveMinor: null });
    unmet = await auction({ ...short, reserveMinor: 9_000_000 });
    cancelled = await auction({ reserveMinor: null });
    await bidOk(sold, alice, 5_000_000);
    await bidOk(sold, bob, 5_050_000);
    await bidOk(unmet, alice, 5_000_000);
    await bidOk(cancelled, carol, 5_000_000);
    const res = await call("POST", `/admin/auctions/${cancelled}/cancel`, {
      cookie: admin,
      body: { reason: "Documents withdrawn" },
    });
    expect(res.status).toBe(200);
    await sleep(3_500);
    for (const id of [sold, unmet]) await auctionStub(id).getView(null); // resolves the due close
    await project(sold, unmet, cancelled);
  }, 20_000);

  it("won = ended, sold and you were the leader; lost = every other finished auction", async () => {
    expect(await ids(bob, "won")).toEqual([sold]);
    expect(await ids(bob, "lost")).toEqual([]);
    expect(await ids(alice, "won")).toEqual([]);
    expect(await ids(alice, "lost")).toEqual([sold, unmet].sort());
    expect(await ids(carol, "lost")).toEqual([cancelled]); // led, but cancelled = not won
    expect(await ids(carol, "won")).toEqual([]);
    for (const cookie of [alice, bob, carol]) {
      expect(await ids(cookie, "leading")).not.toEqual(expect.arrayContaining([sold]));
    }
    const won = (await tab(bob, "won")).items[0]!;
    expect(won).toMatchObject({
      status: "ENDED",
      outcome: "SOLD",
      myHighestMinor: 5_050_000,
      currentPriceMinor: 5_050_000,
      isLeading: false,
    });
    const lost = (await tab(alice, "lost")).items.find((i) => i.auctionId === unmet)!;
    expect(lost).toMatchObject({ status: "ENDED", outcome: "RESERVE_NOT_MET" });
    expect((await tab(carol, "lost")).items[0]).toMatchObject({ status: "CANCELLED" });
  });
});

describe("watchlist", () => {
  it("PUT and DELETE are idempotent (204) and the list returns buyer-safe cards", async () => {
    const id = await auction();
    expect((await call("PUT", `/me/watchlist/${id}`, { cookie: alice })).status).toBe(204);
    expect((await call("PUT", `/me/watchlist/${id}`, { cookie: alice })).status).toBe(204);
    expect((await watchIds(alice)).filter((w) => w === id)).toHaveLength(1);
    const res = await call("GET", "/me/watchlist", { cookie: alice });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    const list = Watchlist.parse(JSON.parse(raw));
    expect(list.items.find((i) => i.auctionId === id)).toMatchObject({
      status: "LIVE",
      make: "Jawa",
      hasReserve: true,
      watchedAt: expect.any(Number),
    });
    expect(raw).not.toContain("7777777");
    expect(raw).not.toContain(await userId(emails.alice!));
    expect((await call("DELETE", `/me/watchlist/${id}`, { cookie: alice })).status).toBe(204);
    expect((await call("DELETE", `/me/watchlist/${id}`, { cookie: alice })).status).toBe(204);
    expect(await watchIds(alice)).not.toContain(id);
  });

  it("drafts, unknown and malformed ids cannot be watched (404)", async () => {
    const draft = await auction({ schedule: false });
    expect((await call("PUT", `/me/watchlist/${draft}`, { cookie: alice })).status).toBe(404);
    expect((await call("PUT", "/me/watchlist/auc_nope_123", { cookie: alice })).status).toBe(404);
    expect((await call("PUT", "/me/watchlist/%27%20OR%201", { cookie: alice })).status).toBe(404);
    expect(await watchIds(alice)).not.toContain(draft);
  });

  it("is isolated per user", async () => {
    const id = await auction();
    expect((await call("PUT", `/me/watchlist/${id}`, { cookie: alice })).status).toBe(204);
    expect(await watchIds(alice)).toContain(id);
    expect(await watchIds(bob)).not.toContain(id);
    const bobList = Watchlist.parse(
      await (await call("GET", "/me/watchlist", { cookie: bob })).json(),
    );
    expect(bobList.items.map((i) => i.auctionId)).not.toContain(id);
    // Bob removing it is a no-op for Alice.
    expect((await call("DELETE", `/me/watchlist/${id}`, { cookie: bob })).status).toBe(204);
    expect(await watchIds(alice)).toContain(id);
  });

  it("caps at 100 auctions per user (409), re-adding a watched one stays idempotent", async () => {
    const first = await auction();
    const extra = await auction();
    expect((await call("PUT", `/me/watchlist/${first}`, { cookie: carol })).status).toBe(204);
    // Fill to the cap directly (closed listings on one bike satisfy the foreign keys).
    const bike = await inspectedBike(admin);
    const carolId = await userId(emails.carol!);
    const now = Date.now();
    const stmts = Array.from({ length: 99 }, (_, i) => [
      env.DB.prepare(
        `INSERT INTO auction_listings (auction_id, bike_id, title, terms, active, created_by, created_at)
         VALUES (?, ?, 'Filler', '', 0, 'test', ?)`,
      ).bind(`auc_fill_${i}_${now}`, bike, now),
      env.DB.prepare(
        `INSERT INTO watchlist (user_id, auction_id, created_at) VALUES (?, ?, ?)`,
      ).bind(carolId, `auc_fill_${i}_${now}`, now - 1000 - i),
    ]).flat();
    await env.DB.batch(stmts);
    expect((await call("PUT", `/me/watchlist/${first}`, { cookie: carol })).status).toBe(204);
    const full = await call("PUT", `/me/watchlist/${extra}`, { cookie: carol });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { code: string }).code).toBe("CONFLICT");
    expect((await call("DELETE", `/me/watchlist/${first}`, { cookie: carol })).status).toBe(204);
    expect((await call("PUT", `/me/watchlist/${extra}`, { cookie: carol })).status).toBe(204);
    expect((await watchIds(carol)).length).toBe(100);
  });
});
