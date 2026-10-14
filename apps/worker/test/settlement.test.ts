import { env, exports } from "cloudflare:workers";
import type { Settlement } from "@bike/contracts";
import { AdminSettlement, MyDeposit, MyPurchases } from "@bike/contracts";
import { settlementTerms } from "@bike/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, mockTurnstile, signIn, signUp } from "./auth-helpers";
import { call, createAuctionFor, inspectedBike, iso } from "./catalogue-helpers";
import { auctionStub, sleep } from "./helpers";

/**
 * Post-auction settlement (docs/settlement.md): 25% within 24 h, balance by day 15, default
 * forfeits the deposit, runner-up offer, deposits and the buying limit, admin controls.
 */

let admin = "";
let admin2 = "";
const users: Record<string, { cookie: string; email: string; id: string }> = {};

beforeAll(async () => {
  const spy = mockTurnstile();
  try {
    for (const name of ["winner", "runner", "third", "depositor", "idle", "legacy"]) {
      const u = await signUp();
      const id = (await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
        .bind(u.email)
        .first<{ id: string }>())!.id;
      users[name] = { cookie: u.cookie, email: u.email, id };
    }
    for (const i of [1, 2]) {
      const a = await signUp();
      await env.DB.prepare(`UPDATE "user" SET role = 'ADMIN' WHERE email = ?`).bind(a.email).run();
      const cookie = (await signIn(a.email, a.password)).cookie;
      if (i === 1) admin = cookie;
      else admin2 = cookie;
    }
  } finally {
    spy.mockRestore();
  }
}, 30_000);

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

async function liveAuction(over: Record<string, unknown> = {}) {
  const bike = await inspectedBike(admin, { make: "Bajaj", model: "Pulsar 150" });
  const res = await createAuctionFor(admin, bike, {
    schedule: true,
    reserveMinor: null,
    antiSniping: false,
    ...over,
  });
  const body = (await res.json()) as { state?: { auctionId: string } };
  if (!body.state) throw new Error(`fixture: ${res.status} ${JSON.stringify(body)}`);
  return body.state.auctionId;
}

/** A live auction that closes in ~2.5 s, with the given bids, closed and projected. */
async function soldAuction(bids: [string, number][], over: Record<string, unknown> = {}) {
  const id = await liveAuction({ startsAt: iso(-61_000), closesAt: iso(2_500), ...over });
  for (const [who, amount] of bids) await bidOk(id, users[who]!.cookie, amount);
  await sleep(2_800);
  await auctionStub(id).getView(null); // resolves the due close
  await auctionStub(id).retryProjection();
  return id;
}

async function purchases(who: string) {
  const res = await call("GET", "/me/purchases", { cookie: users[who]!.cookie });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return MyPurchases.parse(await res.json());
}
const purchaseFor = async (who: string, auctionId: string) =>
  (await purchases(who)).items.find((s) => s.auctionId === auctionId);

async function report(who: string, id: string, amountMinor: number, reference: string) {
  return call("POST", `/me/purchases/${id}/payments`, {
    cookie: users[who]!.cookie,
    body: { amountMinor, method: "UPI", reference },
  });
}
async function decide(
  cookie: string,
  s: Settlement,
  decision: "verify" | "reject",
  reason?: string,
) {
  const pending = s.payments.find((p) => p.status === "REPORTED")!;
  return call("POST", `/admin/settlements/${s.id}/payments/${pending.id}/${decision}`, {
    cookie,
    ...(reason ? { body: { reason } } : {}),
  });
}
async function adminGet(id: string) {
  const res = await call("GET", `/admin/settlements/${id}`, { cookie: admin });
  expect(res.status).toBe(200);
  return AdminSettlement.parse(((await res.json()) as { item: unknown }).item);
}
/** Moves the current deadline into the past (time travel without waiting 24 h). */
const expire = (id: string, agoMs = 60_000) =>
  env.DB.prepare(
    `UPDATE settlements SET initial_deadline = ?1, balance_deadline = ?1 + 1 WHERE id = ?2`,
  )
    .bind(Date.now() - agoMs, id)
    .run();

describe("sales from before the settlement rules", () => {
  it("are never opened, defaulted or counted against the bidder", async () => {
    const before = await env.DB.prepare(
      `SELECT value FROM settlement_config WHERE key = 'opens_from'`,
    ).first<{ value: number }>();
    expect(before?.value).toBeGreaterThan(0);
    // Pretend the rules started after this auction closes.
    await env.DB.prepare(`UPDATE settlement_config SET value = ? WHERE key = 'opens_from'`)
      .bind(Date.now() + 60 * 60_000)
      .run();
    try {
      const id = await soldAuction([["legacy", 5_000_000]]);
      expect(await purchaseFor("legacy", id)).toBeUndefined();
      const elig = await call("GET", "/me/eligibility", { cookie: users.legacy!.cookie });
      expect(((await elig.json()) as { canBid: boolean }).canBid).toBe(true);
    } finally {
      await env.DB.prepare(`UPDATE settlement_config SET value = ? WHERE key = 'opens_from'`)
        .bind(before!.value)
        .run();
    }
  }, 20_000);
});

describe("opening a settlement when an auction is sold", () => {
  let auctionId = "";
  beforeAll(async () => {
    auctionId = await soldAuction([
      ["runner", 5_000_000],
      ["winner", 5_050_000],
    ]);
  }, 20_000);

  it("the winner gets one settlement with the 25% / day-15 terms; the loser gets none", async () => {
    const s = (await purchaseFor("winner", auctionId))!;
    const closesAt = (await env.DB.prepare(`SELECT closes_at FROM auctions_rm WHERE id = ?`)
      .bind(auctionId)
      .first<{ closes_at: number }>())!.closes_at;
    const t = settlementTerms({ priceMinor: 5_050_000, depositHeldMinor: 0, startAt: closesAt });
    expect(s).toMatchObject({
      attempt: 1,
      status: "AWAITING_INITIAL",
      priceMinor: 5_050_000,
      feeMinor: t.feeMinor,
      gstMinor: t.gstMinor,
      initialDueMinor: t.initialDueMinor,
      payableMinor: t.payableMinor,
      dueNowMinor: t.initialDueMinor,
      dueBy: t.initialDeadline,
      balanceDeadline: t.balanceDeadline,
      gatePass: null,
    });
    expect(await purchaseFor("runner", auctionId)).toBeUndefined();
    // Idempotent: more sweeps never open a second one.
    await purchases("winner");
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE auction_id = ?`)
      .bind(auctionId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("another buyer can't see or pay it", async () => {
    const s = (await purchaseFor("winner", auctionId))!;
    expect(
      (await call("GET", `/me/purchases/${s.id}`, { cookie: users.runner!.cookie })).status,
    ).toBe(404);
    expect((await report("runner", s.id, 100_000, "UTR000000001")).status).toBe(404);
    expect((await call("GET", "/me/purchases")).status).toBe(401);
  });

  it("while a payment is owed, the winner can't bid elsewhere", async () => {
    const other = await liveAuction();
    const res = await placeBid(other, users.winner!.cookie, 5_000_000);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/Complete the payment/);
  });

  it("full happy path: report → verify → balance (recorded) → paid → gate pass → collected", async () => {
    let s = (await purchaseFor("winner", auctionId))!;
    // Over-payment and duplicate references are refused.
    expect((await report("winner", s.id, s.payableMinor + 1, "UTR111111111")).status).toBe(422);
    expect((await report("winner", s.id, s.initialDueMinor, "UTR111111111")).status).toBe(201);
    expect((await report("winner", s.id, 100, "utr111111111")).status).toBe(409);
    s = (await purchaseFor("winner", auctionId))!;
    expect(s).toMatchObject({
      status: "AWAITING_INITIAL",
      reportedMinor: s.initialDueMinor,
      paidMinor: 0,
    });

    expect((await decide(admin, s, "verify")).status).toBe(200);
    s = (await purchaseFor("winner", auctionId))!;
    expect(s).toMatchObject({ status: "AWAITING_BALANCE", paidMinor: s.initialDueMinor });
    expect(s.dueNowMinor).toBe(s.payableMinor - s.initialDueMinor);

    // ≤ ₹50,000 recorded by an admin counts at once.
    const rec = await call("POST", `/admin/settlements/${s.id}/payments`, {
      cookie: admin,
      body: { amountMinor: s.dueNowMinor, method: "CASH", reference: "YARD-RCPT-0001" },
    });
    expect(rec.status).toBe(201);
    s = (await purchaseFor("winner", auctionId))!;
    expect(s.status).toBe("PAID");
    expect(s.gatePass).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(s.dueNowMinor).toBe(0);

    const wrong = await call("POST", `/admin/settlements/${s.id}/collect`, {
      cookie: admin,
      body: { gatePass: "WRONG123" },
    });
    expect(wrong.status).toBe(422);
    const ok = await call("POST", `/admin/settlements/${s.id}/collect`, {
      cookie: admin,
      body: { gatePass: s.gatePass!.toLowerCase() },
    });
    expect(ok.status).toBe(200);
    expect((await purchaseFor("winner", auctionId))!.status).toBe("COLLECTED");
    // Paid in full: bidding is open again.
    const other = await liveAuction();
    expect((await placeBid(other, users.winner!.cookie, 5_000_000)).status).toBe(201);
  });
});

describe("defaults, the runner-up and relisting", () => {
  let auctionId = "";
  beforeAll(async () => {
    auctionId = await soldAuction(
      [
        ["third", 5_000_000],
        ["runner", 5_100_000],
        ["idle", 5_200_000],
      ],
      { reserveMinor: 5_050_000 },
    );
  }, 20_000);

  it("a payment reported before the deadline holds off the default until an admin decides", async () => {
    let s = (await purchaseFor("idle", auctionId))!;
    expect((await report("idle", s.id, 1_000, "UTR222222222")).status).toBe(201);
    await sleep(30);
    await expire(s.id, 5); // the deadline passes just after the report
    s = (await purchaseFor("idle", auctionId))!;
    expect(s.status).toBe("AWAITING_INITIAL"); // pending report made in time
    // Rejected after the deadline → defaults immediately.
    expect((await decide(admin, s, "reject", "No such credit on the account")).status).toBe(200);
    s = (await purchaseFor("idle", auctionId))!;
    expect(s).toMatchObject({ status: "DEFAULTED", refundDueMinor: 0 });
    expect(s.closedReason).toMatch(/25%/);
  });

  it("a default pauses bidding until an admin reinstates the account", async () => {
    const other = await liveAuction();
    const res = await placeBid(other, users.idle!.cookie, 5_000_000);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/paused/);
    const r = await call("POST", `/admin/bidders/${users.idle!.id}/reinstate`, {
      cookie: admin,
      body: { reason: "Bank confirmed a failed transfer" },
    });
    expect(r.status).toBe(200);
    expect((await placeBid(other, users.idle!.cookie, 5_000_000)).status).toBe(201);
  });

  it("offers the runner-up their own highest bid; the reserve still applies", async () => {
    const defaulted = (await purchaseFor("idle", auctionId))!;
    const res = await call("POST", `/admin/settlements/${defaulted.id}/offer-runner-up`, {
      cookie: admin,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const offer = (await purchaseFor("runner", auctionId))!;
    expect(offer).toMatchObject({ status: "OFFERED", attempt: 2, priceMinor: 5_100_000 });
    expect(offer.offerExpiresAt).toBeGreaterThan(Date.now());
    // Only once per defaulted settlement.
    expect(
      (await call("POST", `/admin/settlements/${defaulted.id}/offer-runner-up`, { cookie: admin }))
        .status,
    ).toBe(409);

    const accept = await call("POST", `/me/purchases/${offer.id}/accept`, {
      cookie: users.runner!.cookie,
    });
    expect(accept.status).toBe(200);
    const s = (await purchaseFor("runner", auctionId))!;
    expect(s.status).toBe("AWAITING_INITIAL");
    expect(s.dueBy! - Date.now()).toBeGreaterThan(23 * 3_600_000); // the clock starts at acceptance

    // The runner-up defaults too: the next bidder (₹50,000) is below the reserve → no offer.
    await expire(s.id);
    expect((await purchaseFor("runner", auctionId))!.status).toBe("DEFAULTED");
    const none = await call("POST", `/admin/settlements/${s.id}/offer-runner-up`, {
      cookie: admin,
    });
    expect(none.status).toBe(409);
    const relist = await call("POST", `/admin/settlements/${s.id}/relist`, { cookie: admin });
    expect(relist.status).toBe(200);
    expect(((await relist.json()) as { item: Settlement }).item.nextStep).toBe("RELISTED");
  });
});

describe("deposits and the buying limit", () => {
  const me = () => users.depositor!;

  async function deposit(): Promise<MyDeposit> {
    return MyDeposit.parse(
      await (await call("GET", "/me/deposit", { cookie: me().cookie })).json(),
    );
  }

  it("deposits are optional by default (no limit) and must be a listed tier", async () => {
    const d = await deposit();
    expect(d).toMatchObject({
      required: false,
      heldMinor: 0,
      buyingLimitMinor: null,
      canBid: true,
    });
    const bad = await call("POST", "/me/deposit", {
      cookie: me().cookie,
      body: { amountMinor: 123_400, method: "UPI", reference: "UTR333333333" },
    });
    expect(bad.status).toBe(422);
  });

  it("report → admin verify → HELD sets a 10× buying limit enforced on bids and maxima", async () => {
    const r = await call("POST", "/me/deposit", {
      cookie: me().cookie,
      body: { amountMinor: 500_000, method: "BANK_TRANSFER", reference: "UTR444444444" },
    });
    expect(r.status).toBe(201);
    let d = await deposit();
    expect(d.deposits[0]).toMatchObject({ status: "PENDING", amountMinor: 500_000 });
    expect(d.heldMinor).toBe(0);

    const list = await call("GET", "/admin/deposits?status=PENDING", { cookie: admin });
    const pending = (
      (await list.json()) as { items: { id: string; user: { id: string } }[] }
    ).items.find((x) => x.user.id === me().id)!;
    expect(
      (await call("POST", `/admin/deposits/${pending.id}/verify`, { cookie: admin })).status,
    ).toBe(200);
    d = await deposit();
    expect(d).toMatchObject({ heldMinor: 500_000, buyingLimitMinor: 5_000_000 });

    const a = await liveAuction({ startPriceMinor: 4_000_000 });
    const tooHigh = await placeBid(a, me().cookie, 5_100_000);
    expect(tooHigh.status).toBe(403);
    expect(((await tooHigh.json()) as { detail: string }).detail).toMatch(
      /buying limit is ₹50,000/,
    );
    const max = await exports.default.fetch(`${BASE}/api/v1/auctions/${a}/max-bid`, {
      method: "PUT",
      headers: {
        origin: BASE,
        cookie: me().cookie,
        "content-type": "application/json",
        "idempotency-key": `k-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ maxMinor: 6_000_000 }),
    });
    expect(max.status).toBe(403);
    expect((await placeBid(a, me().cookie, 4_000_000)).status).toBe(201);

    // A refund is refused while they have bids on a running auction.
    const refund = await call("POST", "/me/deposit/refund", { cookie: me().cookie });
    expect(refund.status).toBe(409);
    // And account deletion is refused while a deposit is held.
    const del = await call("DELETE", "/me", {
      cookie: me().cookie,
      body: { confirmEmail: me().email },
    });
    expect(del.status).toBe(409);
  });

  it("a held deposit counts towards the 25% when you win, and is forfeited on a default", async () => {
    const id = await soldAuction([["depositor", 4_500_000]], { startPriceMinor: 4_500_000 });
    const s = (await purchaseFor("depositor", id))!;
    expect(s.depositMinor).toBe(500_000);
    const t = settlementTerms({
      priceMinor: 4_500_000,
      depositHeldMinor: 500_000,
      startAt: s.startAt,
    });
    expect(s.initialDueMinor).toBe(t.initialDueMinor); // 25% − deposit
    expect(s.payableMinor).toBe(t.totalMinor - 500_000);
    expect((await deposit()).heldMinor).toBe(0); // applied, no longer free

    await expire(s.id);
    expect((await purchaseFor("depositor", id))!.status).toBe("DEFAULTED");
    const statuses = await env.DB.prepare(`SELECT status FROM deposits WHERE user_id = ?`)
      .bind(me().id)
      .all<{ status: string }>();
    expect(statuses.results.map((x) => x.status)).toEqual(["FORFEITED"]);
  }, 20_000);
});

describe("admin controls", () => {
  let auctionId = "";
  beforeAll(async () => {
    const spy = mockTurnstile();
    try {
      const u = await signUp();
      users.ctl = {
        cookie: u.cookie,
        email: u.email,
        id: (await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
          .bind(u.email)
          .first<{ id: string }>())!.id,
      };
    } finally {
      spy.mockRestore();
    }
    auctionId = await soldAuction([["ctl", 9_000_000]], { startPriceMinor: 9_000_000 });
  }, 20_000);

  it("extends once (≤ 72 h, with a reason), lists the queue and keeps a timeline", async () => {
    const s = (await purchaseFor("ctl", auctionId))!;
    const ext = await call("POST", `/admin/settlements/${s.id}/extend`, {
      cookie: admin,
      body: { hours: 12, reason: "Bank holiday on Monday" },
    });
    expect(ext.status).toBe(200);
    expect((await purchaseFor("ctl", auctionId))!.dueBy).toBe(s.dueBy! + 12 * 3_600_000);
    const again = await call("POST", `/admin/settlements/${s.id}/extend`, {
      cookie: admin,
      body: { hours: 1, reason: "One more time please" },
    });
    expect(again.status).toBe(409);

    const list = await call("GET", "/admin/settlements?status=open", { cookie: admin });
    const items = ((await list.json()) as { items: unknown[] }).items.map((x) =>
      AdminSettlement.parse(x),
    );
    expect(items.some((x) => x.id === s.id && x.buyer.email === users.ctl!.email)).toBe(true);
    const detail = await call("GET", `/admin/settlements/${s.id}`, { cookie: admin });
    const timeline = ((await detail.json()) as { timeline: { action: string }[] }).timeline;
    expect(timeline.map((t) => t.action)).toContain("SETTLEMENT_EXTENDED");
  });

  it("over ₹50,000 an admin-recorded payment needs a second admin", async () => {
    const s = (await purchaseFor("ctl", auctionId))!;
    // The 25% (₹22,500) is under the limit: it counts at once.
    const first = await call("POST", `/admin/settlements/${s.id}/payments`, {
      cookie: admin,
      body: { amountMinor: s.initialDueMinor, method: "CASH", reference: "YARD-RCPT-0002" },
    });
    expect(first.status).toBe(201);
    let a = await adminGet(s.id);
    expect(a).toMatchObject({ status: "AWAITING_BALANCE", paidMinor: s.initialDueMinor });
    // The balance (> ₹50,000) waits for a second admin.
    const rec = await call("POST", `/admin/settlements/${s.id}/payments`, {
      cookie: admin,
      body: { amountMinor: a.dueNowMinor, method: "CHEQUE", reference: "CHQ-556677" },
    });
    expect(rec.status).toBe(201);
    a = await adminGet(s.id);
    expect(a.paidMinor).toBe(s.initialDueMinor);
    expect(a.pendingReports).toBe(1);
    expect((await decide(admin, a, "verify")).status).toBe(403); // same admin
    expect((await decide(admin2, a, "verify")).status).toBe(200);
    a = await adminGet(s.id);
    expect(a.status).toBe("PAID");
  });

  it("cancelling a sale refunds what was paid with no forfeiture", async () => {
    const s = (await purchaseFor("ctl", auctionId))!;
    const res = await call("POST", `/admin/settlements/${s.id}/cancel`, {
      cookie: admin,
      body: { reason: "Inspection report disputed" },
    });
    expect(res.status).toBe(200);
    const after = (await purchaseFor("ctl", auctionId))!;
    expect(s.status).toBe("PAID");
    expect(after).toMatchObject({
      status: "CANCELLED",
      refundDueMinor: s.paidMinor,
      gatePass: null,
    });
    expect(
      (await call("POST", `/admin/settlements/${s.id}/refunded`, { cookie: admin })).status,
    ).toBe(200);
    expect((await purchaseFor("ctl", auctionId))!.refundedAt).not.toBeNull();
  });
});
