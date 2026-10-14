/**
 * Admin side of settlement (docs/settlement.md). Mounted under adminRoutes, so every route is
 * admin-only (guard + authz test) and counted by the admin write limit through audit_log.
 */
import type { AdminSettlementList } from "@bike/contracts";
import { CollectBody, ExtendBody, ReasonBody, RecordPaymentBody } from "@bike/contracts";
import { canExtend, pickRunnerUp, settlementTerms } from "@bike/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "../lib/problem";
import {
  adminViews,
  advance,
  depositView,
  getRow,
  newId,
  OWING_STATUSES,
  sweep,
  type SettlementRow,
} from "../settlement/service";
import type { AppEnv } from "../types";
import { audit, json } from "./admin-bikes";
import { auctionStub } from "./auctions";

export const adminSettlementRoutes = new Hono<AppEnv>();

/** Above this, a payment an admin records needs a second admin to verify it. */
const DUAL_CONTROL_MINOR = 5_000_000; // ₹50,000
const HOUR_MS = 3_600_000;

const ListQuery = z.object({
  status: z
    .enum(["open", "awaiting_verification", "overdue_soon", "paid", "closed", "all"])
    .default("open"),
});

async function row(c: Context<AppEnv>): Promise<SettlementRow> {
  const r = await getRow(c.env.DB, c.req.param("id") ?? "");
  if (!r) throw new AppError("NOT_FOUND", "Settlement not found");
  return r;
}

async function detail(c: Context<AppEnv>, id: string) {
  const r = await getRow(c.env.DB, id);
  const [item] = await adminViews(c.env.DB, r ? [r] : []);
  return item;
}

adminSettlementRoutes.get("/settlements", async (c) => {
  const q = ListQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError("VALIDATION_FAILED", q.error.issues[0]?.message);
  const now = Date.now();
  await sweep(c.env, now);
  const where = {
    open: `s.status IN ('OFFERED','AWAITING_INITIAL','AWAITING_BALANCE')`,
    awaiting_verification: `EXISTS (SELECT 1 FROM settlement_payments p WHERE p.settlement_id = s.id AND p.status = 'REPORTED')`,
    overdue_soon: `s.status IN ('AWAITING_INITIAL','AWAITING_BALANCE') AND
      (CASE s.status WHEN 'AWAITING_INITIAL' THEN s.initial_deadline ELSE s.balance_deadline END) + s.extension_ms < ${now + 24 * HOUR_MS}`,
    paid: `s.status = 'PAID'`,
    closed: `s.status IN ('COLLECTED','DEFAULTED','CANCELLED','DECLINED','EXPIRED')`,
    all: `1 = 1`,
  }[q.data.status];
  const [rows, counts] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT s.* FROM settlements s WHERE ${where}
       ORDER BY CASE WHEN s.status IN ('AWAITING_INITIAL','AWAITING_BALANCE') THEN
         (CASE s.status WHEN 'AWAITING_INITIAL' THEN s.initial_deadline ELSE s.balance_deadline END) + s.extension_ms
         ELSE 9e15 END, s.updated_at DESC LIMIT 100`,
    ),
    c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM settlements GROUP BY status`),
  ]);
  const body: AdminSettlementList = {
    items: await adminViews(c.env.DB, (rows?.results ?? []) as SettlementRow[]),
    counts: Object.fromEntries(
      ((counts?.results ?? []) as { status: string; n: number }[]).map((r) => [r.status, r.n]),
    ),
  };
  return c.json(body, 200, { "cache-control": "no-store" });
});

adminSettlementRoutes.get("/settlements/:id", async (c) => {
  await sweep(c.env);
  const r = await row(c);
  const [item] = await adminViews(c.env.DB, [r]);
  const timeline = await c.env.DB.prepare(
    `SELECT a.action, a.metadata_json AS metadata, a.created_at AS at, u.name AS actor
     FROM audit_log a LEFT JOIN "user" u ON u.id = a.actor_user_id
     WHERE a.resource_type = 'settlement' AND a.resource_id = ? ORDER BY a.created_at`,
  )
    .bind(r.id)
    .all();
  return c.json({ item, timeline: timeline.results });
});

adminSettlementRoutes.post("/settlements/:id/payments/:pid/:decision{verify|reject}", async (c) => {
  const admin = c.get("user")!;
  const decision = c.req.param("decision");
  const reason = decision === "reject" ? (await json(c, ReasonBody)).reason : null;
  const r = await row(c);
  const p = await c.env.DB.prepare(
    `SELECT * FROM settlement_payments WHERE id = ? AND settlement_id = ?`,
  )
    .bind(c.req.param("pid"), r.id)
    .first<{ reported_by: string; amount_minor: number; status: string }>();
  if (!p) throw new AppError("NOT_FOUND", "Payment not found");
  if (decision === "verify" && p.reported_by === admin.id)
    throw new AppError("FORBIDDEN", "A second administrator must verify a payment you recorded.");
  if (
    decision === "verify" &&
    !OWING_STATUSES.includes(r.status as (typeof OWING_STATUSES)[number])
  )
    throw new AppError(
      "CONFLICT",
      `This settlement is ${r.status.toLowerCase().replace("_", " ")}.`,
    );
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `UPDATE settlement_payments SET status = ?, decided_by = ?, decided_at = ?, reject_reason = ?
     WHERE id = ? AND status = 'REPORTED'`,
  )
    .bind(
      decision === "verify" ? "VERIFIED" : "REJECTED",
      admin.id,
      now,
      reason,
      c.req.param("pid"),
    )
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "This payment was already decided.");
  await audit(
    c,
    decision === "verify" ? "PAYMENT_VERIFIED" : "PAYMENT_REJECTED",
    "settlement",
    r.id,
    {
      paymentId: c.req.param("pid"),
      amountMinor: p.amount_minor,
      ...(reason ? { reason } : {}),
    },
  );
  await advance(c.env.DB, r.id, now);
  await sweep(c.env, now); // a rejection after the deadline defaults at once
  return c.json({ item: await detail(c, r.id) });
});

/** Cash at the yard, a cheque, a transfer the buyer didn't report. */
adminSettlementRoutes.post("/settlements/:id/payments", async (c) => {
  const admin = c.get("user")!;
  const body = await json(c, RecordPaymentBody);
  const r = await row(c);
  if (!OWING_STATUSES.includes(r.status as (typeof OWING_STATUSES)[number]))
    throw new AppError("CONFLICT", "Nothing is due on this settlement.");
  const now = Date.now();
  const dual = body.amountMinor > DUAL_CONTROL_MINOR;
  const id = newId("pay");
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO settlement_payments (id, settlement_id, amount_minor, method, reference, status,
       reported_by, reported_at, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      r.id,
      body.amountMinor,
      body.method,
      body.reference.toUpperCase(),
      dual ? "REPORTED" : "VERIFIED",
      admin.id,
      now,
      dual ? null : admin.id,
      dual ? null : now,
    )
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "This transaction reference is already recorded.");
  await audit(c, "PAYMENT_RECORDED", "settlement", r.id, {
    paymentId: id,
    amountMinor: body.amountMinor,
    method: body.method,
    needsSecondAdmin: dual,
  });
  if (!dual) await advance(c.env.DB, r.id, now);
  return c.json({ item: await detail(c, r.id) }, 201);
});

adminSettlementRoutes.post("/settlements/:id/extend", async (c) => {
  const body = await json(c, ExtendBody);
  const r = await row(c);
  if (!OWING_STATUSES.includes(r.status as (typeof OWING_STATUSES)[number]))
    throw new AppError("CONFLICT", "Only an open payment stage can be extended.");
  if (!canExtend(r.extension_ms, body.hours * HOUR_MS))
    throw new AppError("CONFLICT", "This settlement has already been extended once.");
  const res = await c.env.DB.prepare(
    `UPDATE settlements SET extension_ms = ?, extension_reason = ?, updated_at = ? WHERE id = ? AND extension_ms = 0 AND status = ?`,
  )
    .bind(body.hours * HOUR_MS, body.reason, Date.now(), r.id, r.status)
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "The settlement changed; reload.");
  await audit(c, "SETTLEMENT_EXTENDED", "settlement", r.id, {
    hours: body.hours,
    reason: body.reason,
  });
  return c.json({ item: await detail(c, r.id) });
});

adminSettlementRoutes.post("/settlements/:id/collect", async (c) => {
  const body = await json(c, CollectBody);
  const r = await row(c);
  if (r.status !== "PAID")
    throw new AppError("CONFLICT", "Only a fully paid sale can be collected.");
  if (body.gatePass.toUpperCase() !== r.gate_pass)
    throw new AppError("VALIDATION_FAILED", "That gate-pass code doesn't match this sale.");
  await c.env.DB.prepare(
    `UPDATE settlements SET status = 'COLLECTED', updated_at = ? WHERE id = ? AND status = 'PAID'`,
  )
    .bind(Date.now(), r.id)
    .run();
  await audit(c, "SETTLEMENT_COLLECTED", "settlement", r.id);
  return c.json({ item: await detail(c, r.id) });
});

/** Dispute / admin cancellation: no forfeiture, everything paid is refunded, the deposit is freed. */
adminSettlementRoutes.post("/settlements/:id/cancel", async (c) => {
  const { reason } = await json(c, ReasonBody);
  const r = await row(c);
  if (!["OFFERED", "AWAITING_INITIAL", "AWAITING_BALANCE", "PAID"].includes(r.status))
    throw new AppError("CONFLICT", "This settlement is already closed.");
  const now = Date.now();
  const verified = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount_minor), 0) AS v FROM settlement_payments WHERE settlement_id = ? AND status = 'VERIFIED'`,
  )
    .bind(r.id)
    .first<{ v: number }>();
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE settlements SET status = 'CANCELLED', closed_reason = ?, refund_due_minor = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    ).bind(`Cancelled by the platform: ${reason}`, verified?.v ?? 0, now, r.id, r.status),
    c.env.DB.prepare(
      `UPDATE deposits SET status = 'HELD', settlement_id = NULL, updated_at = ?1
       WHERE settlement_id = ?2 AND status = 'APPLIED'
         AND (SELECT updated_at FROM settlements WHERE id = ?2 AND status = 'CANCELLED') = ?1`,
    ).bind(now, r.id),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "The settlement changed; reload.");
  await audit(c, "SETTLEMENT_CANCELLED", "settlement", r.id, { reason });
  return c.json({ item: await detail(c, r.id) });
});

/** Second-chance offer to the next-highest distinct bidder at their own highest bid. */
adminSettlementRoutes.post("/settlements/:id/offer-runner-up", async (c) => {
  const r = await row(c);
  if (!["DEFAULTED", "DECLINED", "EXPIRED"].includes(r.status) || r.next_step)
    throw new AppError(
      "CONFLICT",
      "A runner-up can be offered only after a default, decline or expiry.",
    );
  const [bidders, previous, suspended] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT user_id AS userId, highest_amount_minor AS highestMinor FROM user_bids_rm WHERE auction_id = ?`,
    ).bind(r.auction_id),
    c.env.DB.prepare(`SELECT buyer_user_id AS u FROM settlements WHERE auction_id = ?`).bind(
      r.auction_id,
    ),
    c.env.DB.prepare(`SELECT user_id AS u FROM bidder_flags WHERE suspended = 1`),
  ]);
  const excluded = new Set(
    [...(previous?.results ?? []), ...(suspended?.results ?? [])].map(
      (x) => (x as { u: string }).u,
    ),
  );
  const details = await auctionStub(c.env, r.auction_id).getAdminDetails();
  const reserve = details?.state.reserveMinor ?? null;
  const pick = pickRunnerUp(
    (bidders?.results ?? []) as { userId: string; highestMinor: number }[],
    excluded,
    reserve,
  );
  if (!pick)
    throw new AppError(
      "CONFLICT",
      "No eligible runner-up (none left, or below the reserve). Relist instead.",
    );
  const now = Date.now();
  const nextAttempt =
    ((
      await c.env.DB.prepare(`SELECT MAX(attempt) AS a FROM settlements WHERE auction_id = ?`)
        .bind(r.auction_id)
        .first<{ a: number }>()
    )?.a ?? r.attempt) + 1;
  const id = `stl_${r.auction_id.replace(/^auc_/, "")}_${nextAttempt}`;
  // A preview of the terms (no deposit, clock not started); recomputed when the offer is accepted.
  const t = settlementTerms({ priceMinor: pick.highestMinor, depositHeldMinor: 0, startAt: now });
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE settlements SET next_step = 'RUNNER_UP_OFFERED', updated_at = ? WHERE id = ? AND next_step IS NULL`,
    ).bind(now, r.id),
    c.env.DB.prepare(
      `INSERT INTO settlements (id, auction_id, attempt, buyer_user_id, bike_id, title, status, price_minor,
         fee_minor, gst_minor, total_minor, initial_due_minor, payable_minor,
         start_at, offer_expires_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, 'OFFERED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT updated_at FROM settlements WHERE id = ? AND next_step = 'RUNNER_UP_OFFERED') = ?`,
    ).bind(
      id,
      r.auction_id,
      nextAttempt,
      pick.userId,
      r.bike_id,
      r.title,
      pick.highestMinor,
      t.feeMinor,
      t.gstMinor,
      t.totalMinor,
      t.initialDueMinor,
      t.payableMinor,
      now,
      now + 24 * HOUR_MS,
      now,
      now,
      r.id,
      now,
    ),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "The settlement changed; reload.");
  await audit(c, "RUNNER_UP_OFFERED", "settlement", r.id, {
    offerId: id,
    priceMinor: pick.highestMinor,
  });
  return c.json({ item: await detail(c, r.id), offer: await detail(c, id) }, 201);
});

/** Marks the sale as going back to auction; the admin creates the new auction for the bike. */
adminSettlementRoutes.post("/settlements/:id/relist", async (c) => {
  const r = await row(c);
  if (!["DEFAULTED", "DECLINED", "EXPIRED", "CANCELLED"].includes(r.status) || r.next_step)
    throw new AppError("CONFLICT", "Only a closed, unsold settlement can be relisted.");
  await c.env.DB.prepare(
    `UPDATE settlements SET next_step = 'RELISTED', updated_at = ? WHERE id = ? AND next_step IS NULL`,
  )
    .bind(Date.now(), r.id)
    .run();
  await audit(c, "SETTLEMENT_RELISTED", "settlement", r.id, { bikeId: r.bike_id });
  return c.json({ item: await detail(c, r.id), bikeId: r.bike_id });
});

adminSettlementRoutes.post("/settlements/:id/refunded", async (c) => {
  const r = await row(c);
  if (r.refund_due_minor <= 0 || r.refunded_at) throw new AppError("CONFLICT", "No refund is due.");
  await c.env.DB.prepare(
    `UPDATE settlements SET refunded_at = ?, updated_at = ? WHERE id = ? AND refunded_at IS NULL`,
  )
    .bind(Date.now(), Date.now(), r.id)
    .run();
  await audit(c, "SETTLEMENT_REFUNDED", "settlement", r.id, { amountMinor: r.refund_due_minor });
  return c.json({ item: await detail(c, r.id) });
});

/* -------------------------------- deposits -------------------------------- */

const DepositQuery = z.object({
  status: z.enum(["PENDING", "HELD", "REFUND_REQUESTED", "FORFEITED", "all"]).default("PENDING"),
});

adminSettlementRoutes.get("/deposits", async (c) => {
  const q = DepositQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError("VALIDATION_FAILED", q.error.issues[0]?.message);
  const rows = await c.env.DB.prepare(
    `SELECT d.*, u.name AS user_name, u.email AS user_email FROM deposits d LEFT JOIN "user" u ON u.id = d.user_id
     ${q.data.status === "all" ? "" : "WHERE d.status = ?"} ORDER BY d.updated_at DESC LIMIT 200`,
  )
    .bind(...(q.data.status === "all" ? [] : [q.data.status]))
    .all<
      Parameters<typeof depositView>[0] & {
        user_id: string;
        user_name: string | null;
        user_email: string | null;
      }
    >();
  return c.json({
    items: rows.results.map((d) => ({
      ...depositView(d),
      user: { id: d.user_id, name: d.user_name ?? "Deleted account", email: d.user_email ?? "" },
    })),
  });
});

const DEPOSIT_TRANSITIONS = {
  verify: { from: "PENDING", to: "HELD", action: "DEPOSIT_VERIFIED" },
  reject: { from: "PENDING", to: "REJECTED", action: "DEPOSIT_REJECTED" },
  refunded: { from: "REFUND_REQUESTED", to: "REFUNDED", action: "DEPOSIT_REFUNDED" },
} as const;

adminSettlementRoutes.post("/deposits/:id/:decision{verify|reject|refunded}", async (c) => {
  const t = DEPOSIT_TRANSITIONS[c.req.param("decision") as keyof typeof DEPOSIT_TRANSITIONS];
  const note = t.to === "REJECTED" ? (await json(c, ReasonBody)).reason : null;
  const res = await c.env.DB.prepare(
    `UPDATE deposits SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ? AND status = ?`,
  )
    .bind(t.to, note, Date.now(), c.req.param("id"), t.from)
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new AppError("CONFLICT", "This deposit was already handled.");
  await audit(c, t.action, "deposit", c.req.param("id"), note ? { reason: note } : {});
  return c.json({ ok: true });
});

/** Lift a default's bidding pause after review. */
adminSettlementRoutes.post("/bidders/:userId/reinstate", async (c) => {
  const { reason } = await json(c, ReasonBody);
  const res = await c.env.DB.prepare(
    `UPDATE bidder_flags SET suspended = 0, reason = ?, updated_at = ? WHERE user_id = ? AND suspended = 1`,
  )
    .bind(`Reinstated: ${reason}`, Date.now(), c.req.param("userId"))
    .run();
  if ((res.meta.changes ?? 0) === 0) throw new AppError("CONFLICT", "This bidder isn't suspended.");
  await audit(c, "BIDDER_REINSTATED", "user", c.req.param("userId"), { reason });
  return c.json({ ok: true });
});
