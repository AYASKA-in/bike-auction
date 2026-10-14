/**
 * Buyer side of settlement (docs/settlement.md): My purchases, reporting a payment, runner-up
 * offers, participation deposits. Every route is the signed-in buyer's own data only.
 */
import type { MyDeposit, MyPurchases } from "@bike/contracts";
import { ReportDepositBody, ReportPaymentBody, type Settlement } from "@bike/contracts";
import { amountDueNow, SETTLEMENT_RULES } from "@bike/domain";
import { Hono, type Context } from "hono";
import { AppError } from "../lib/problem";
import { requireUser } from "../middleware/session";
import {
  acceptOffer,
  depositView,
  eligibility,
  getRow,
  newId,
  OWING_STATUSES,
  sweep,
  termsOf,
  verifiedSum,
  views,
  type SettlementRow,
} from "../settlement/service";
import type { AppEnv } from "../types";
import { audit, json } from "./admin-bikes";

export const settlementRoutes = new Hono<AppEnv>();
settlementRoutes.use("/me/purchases/*", requireUser);
settlementRoutes.use("/me/purchases", requireUser);
settlementRoutes.use("/me/deposit/*", requireUser);
settlementRoutes.use("/me/deposit", requireUser);
settlementRoutes.use("/me/eligibility", requireUser);

const MAX_PENDING_REPORTS = 5;

function payTo(env: Env): MyPurchases["payTo"] {
  const e = env as { PAYMENT_UPI_ID?: string; PAYMENT_BANK_DETAILS?: string };
  const upiId = e.PAYMENT_UPI_ID?.trim() || null;
  const bankDetails = e.PAYMENT_BANK_DETAILS?.trim() || null;
  return upiId || bankDetails ? { upiId, bankDetails } : null;
}

async function ownRow(c: Context<AppEnv>): Promise<SettlementRow> {
  const row = await getRow(c.env.DB, c.req.param("id") ?? "");
  if (!row || row.buyer_user_id !== c.get("user")!.id)
    throw new AppError("NOT_FOUND", "Purchase not found");
  return row;
}

settlementRoutes.get("/me/purchases", async (c) => {
  const user = c.get("user")!;
  await sweep(c.env, Date.now(), user.id);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM settlements WHERE buyer_user_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(user.id)
    .all<SettlementRow>();
  const body: MyPurchases = { items: await views(c.env.DB, rows.results), payTo: payTo(c.env) };
  return c.json(body, 200, { "cache-control": "no-store" });
});

settlementRoutes.get("/me/purchases/:id", async (c) => {
  await sweep(c.env, Date.now(), c.get("user")!.id);
  const row = await ownRow(c);
  const [item] = await views(c.env.DB, [row]);
  return c.json({ item, payTo: payTo(c.env) }, 200, { "cache-control": "no-store" });
});

/** Report a UPI / bank transfer you made (by its UTR). An admin verifies it against the account. */
settlementRoutes.post("/me/purchases/:id/payments", async (c) => {
  const user = c.get("user")!;
  const body = await json(c, ReportPaymentBody);
  const now = Date.now();
  await sweep(c.env, now, user.id);
  const row = await ownRow(c);
  if (!OWING_STATUSES.includes(row.status as (typeof OWING_STATUSES)[number])) {
    throw new AppError(
      "CONFLICT",
      row.status === "DEFAULTED"
        ? "The payment deadline has passed and this sale was cancelled."
        : "Nothing is due on this purchase.",
    );
  }
  const verified = await verifiedSum(c.env.DB, row.id);
  const due = amountDueNow(termsOf(row), verified, row.extension_ms);
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total FROM settlement_payments
     WHERE settlement_id = ? AND status = 'REPORTED'`,
  )
    .bind(row.id)
    .first<{ n: number; total: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_REPORTS)
    throw new AppError("CONFLICT", "Several payments are already waiting to be verified.");
  const remaining = row.payable_minor - verified - (pending?.total ?? 0);
  if (body.amountMinor > remaining)
    throw new AppError(
      "VALIDATION_FAILED",
      remaining > 0
        ? `That's more than the ₹${(remaining / 100).toLocaleString("en-IN")} still to pay.`
        : "Your payments already cover the full amount; they're waiting to be verified.",
    );
  const id = newId("pay");
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO settlement_payments (id, settlement_id, amount_minor, method, reference, status, reported_by, reported_at)
     VALUES (?, ?, ?, ?, ?, 'REPORTED', ?, ?)`,
  )
    .bind(id, row.id, body.amountMinor, body.method, body.reference.toUpperCase(), user.id, now)
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "This transaction reference has already been reported.");
  await audit(c, "PAYMENT_REPORTED", "settlement", row.id, {
    paymentId: id,
    amountMinor: body.amountMinor,
    onTime: due.deadline === null || now <= due.deadline,
  });
  const [item] = await views(c.env.DB, [(await getRow(c.env.DB, row.id))!]);
  return c.json({ item }, 201);
});

settlementRoutes.post("/me/purchases/:id/accept", async (c) => {
  const user = c.get("user")!;
  const now = Date.now();
  await sweep(c.env, now, user.id);
  const row = await ownRow(c);
  const elig = await eligibility(c.env, user.id);
  if (!elig.canBid && !/participation deposit/.test(elig.blockedReason ?? ""))
    throw new AppError("FORBIDDEN", elig.blockedReason ?? "Your account can't buy right now.");
  if (!(await acceptOffer(c.env.DB, row, now)))
    throw new AppError("CONFLICT", "This offer is no longer open.");
  await audit(c, "OFFER_ACCEPTED", "settlement", row.id, { priceMinor: row.price_minor });
  const [item] = await views(c.env.DB, [(await getRow(c.env.DB, row.id))!]);
  return c.json({ item });
});

settlementRoutes.post("/me/purchases/:id/decline", async (c) => {
  const now = Date.now();
  const row = await ownRow(c);
  const res = await c.env.DB.prepare(
    `UPDATE settlements SET status = 'DECLINED', closed_reason = 'You declined the offer.', updated_at = ?
     WHERE id = ? AND status = 'OFFERED'`,
  )
    .bind(now, row.id)
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "This offer is no longer open.");
  await audit(c, "OFFER_DECLINED", "settlement", row.id);
  return c.json({ ok: true });
});

/* -------------------------------- deposits -------------------------------- */

async function myDeposit(c: Context<AppEnv>): Promise<MyDeposit> {
  const user = c.get("user")!;
  const [elig, rows] = await Promise.all([
    eligibility(c.env, user.id),
    c.env.DB.prepare(`SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
      .bind(user.id)
      .all<Parameters<typeof depositView>[0]>(),
  ]);
  return {
    required: elig.required,
    heldMinor: elig.heldMinor,
    buyingLimitMinor: elig.buyingLimitMinor,
    tiersMinor: [...SETTLEMENT_RULES.depositTiersMinor],
    multiple: SETTLEMENT_RULES.depositMultiple,
    deposits: rows.results.map(depositView),
    canBid: elig.canBid,
    blockedReason: elig.blockedReason,
  };
}

settlementRoutes.get("/me/eligibility", async (c) => {
  const e = await eligibility(c.env, c.get("user")!.id);
  return c.json(e, 200, { "cache-control": "no-store" });
});

settlementRoutes.get("/me/deposit", async (c) =>
  c.json(await myDeposit(c), 200, { "cache-control": "no-store" }),
);

/** Report a deposit transfer; an admin verifies it, then it counts as HELD. */
settlementRoutes.post("/me/deposit", async (c) => {
  const user = c.get("user")!;
  if (user.role === "ADMIN") throw new AppError("FORBIDDEN", "Administrators cannot bid");
  const body = await json(c, ReportDepositBody);
  if (!SETTLEMENT_RULES.depositTiersMinor.includes(body.amountMinor))
    throw new AppError("VALIDATION_FAILED", "Choose one of the deposit amounts offered.");
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM deposits WHERE user_id = ? AND status = 'PENDING'`,
  )
    .bind(user.id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= 3)
    throw new AppError("CONFLICT", "Several deposits are already waiting to be verified.");
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO deposits (id, user_id, amount_minor, method, reference, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
  )
    .bind(
      newId("dep"),
      user.id,
      body.amountMinor,
      body.method,
      body.reference.toUpperCase(),
      now,
      now,
    )
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "This transaction reference has already been reported.");
  await audit(c, "DEPOSIT_REPORTED", "user", user.id, { amountMinor: body.amountMinor });
  return c.json(await myDeposit(c), 201);
});

/**
 * Ask for HELD deposits back. Refused while the buyer owes a settlement or has bid on an auction
 * that is still running (they may be leading or hold a maximum backed by this deposit).
 */
settlementRoutes.post("/me/deposit/refund", async (c) => {
  const user = c.get("user")!;
  const now = Date.now();
  const [owing, live] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT 1 FROM settlements WHERE buyer_user_id = ? AND status IN ('OFFERED','AWAITING_INITIAL','AWAITING_BALANCE') LIMIT 1`,
    ).bind(user.id),
    c.env.DB.prepare(
      `SELECT 1 FROM user_bids_rm u JOIN auctions_rm r ON r.id = u.auction_id
       WHERE u.user_id = ? AND r.status IN ('SCHEDULED','LIVE') LIMIT 1`,
    ).bind(user.id),
  ]);
  if ((owing?.results?.length ?? 0) > 0)
    throw new AppError(
      "CONFLICT",
      "Finish your open purchase before asking for your deposit back.",
    );
  if ((live?.results?.length ?? 0) > 0)
    throw new AppError(
      "CONFLICT",
      "You have bids on an auction that's still running. Ask again once it has closed.",
    );
  const res = await c.env.DB.prepare(
    `UPDATE deposits SET status = 'REFUND_REQUESTED', updated_at = ? WHERE user_id = ? AND status = 'HELD'`,
  )
    .bind(now, user.id)
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "You have no deposit to refund.");
  await audit(c, "DEPOSIT_REFUND_REQUESTED", "user", user.id);
  return c.json(await myDeposit(c));
});

export type { Settlement };
