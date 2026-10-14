/**
 * Post-auction settlement (docs/settlement.md). D1 is the store: settlement traffic is a handful of
 * writes per sale, so every transition is a guarded `UPDATE … WHERE status = ?` (two admins or a
 * sweep racing a verification can never both apply). The rules themselves are the pure functions
 * in packages/domain (settlementTerms, settlementStage, pickRunnerUp…).
 *
 * Settlements are opened from the read model (auctions_rm ENDED + SOLD) by `sweep()`, which runs
 * from the 5-minute cron and lazily before any settlement read or write, so the winner sees theirs
 * at once. Deadlines are anchored on the auction's close time, not on when the row was created.
 */
import type { AdminSettlement, Deposit, Payment, Settlement } from "@bike/contracts";
import {
  amountDueNow,
  buyingLimitMinor,
  isDefaulted,
  SETTLEMENT_RULES,
  settlementStage,
  settlementTerms,
  type SettlementTerms,
} from "@bike/domain";
import { imageUrl } from "../catalogue/images";
import { newId } from "../lib/ids";

export const OPEN_STATUSES = ["OFFERED", "AWAITING_INITIAL", "AWAITING_BALANCE"] as const;
/** Statuses during which the buyer still owes the platform (blocks bidding and account deletion). */
export const OWING_STATUSES = ["AWAITING_INITIAL", "AWAITING_BALANCE"] as const;

export interface SettlementRow {
  id: string;
  auction_id: string;
  attempt: number;
  buyer_user_id: string;
  bike_id: string;
  title: string;
  status: Settlement["status"];
  price_minor: number;
  fee_minor: number;
  gst_minor: number;
  total_minor: number;
  deposit_minor: number;
  initial_due_minor: number;
  payable_minor: number;
  start_at: number;
  initial_deadline: number | null;
  balance_deadline: number | null;
  offer_expires_at: number | null;
  extension_ms: number;
  extension_reason: string | null;
  gate_pass: string | null;
  next_step: Settlement["nextStep"];
  refund_due_minor: number;
  refunded_at: number | null;
  closed_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface PaymentRow {
  id: string;
  settlement_id: string;
  amount_minor: number;
  method: Payment["method"];
  reference: string;
  status: Payment["status"];
  reported_by: string;
  reported_at: number;
  decided_at: number | null;
  reject_reason: string | null;
}

const IN_OWING = `('AWAITING_INITIAL','AWAITING_BALANCE')`;
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function termsOf(r: SettlementRow): SettlementTerms {
  return {
    priceMinor: r.price_minor,
    initialTargetMinor: r.initial_due_minor + Math.min(r.deposit_minor, r.total_minor),
    feeMinor: r.fee_minor,
    gstMinor: r.gst_minor,
    totalMinor: r.total_minor,
    depositAppliedMinor: Math.min(r.deposit_minor, r.total_minor),
    initialDueMinor: r.initial_due_minor,
    payableMinor: r.payable_minor,
    initialDeadline: r.initial_deadline ?? r.start_at,
    balanceDeadline: r.balance_deadline ?? r.start_at,
  };
}

/** Random, unambiguous gate-pass code (no 0/O/1/I). */
function gatePass(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function heldDeposits(db: D1Database, userId: string) {
  const rows = await db
    .prepare(`SELECT id, amount_minor FROM deposits WHERE user_id = ? AND status = 'HELD'`)
    .bind(userId)
    .all<{ id: string; amount_minor: number }>();
  return {
    ids: rows.results.map((r) => r.id),
    total: rows.results.reduce((s, r) => s + r.amount_minor, 0),
  };
}

/**
 * Creates one settlement (attempt N) with terms computed now, and applies the buyer's HELD
 * deposits to it, in one atomic batch. `status` is AWAITING_* (a winner, or an accepted offer).
 * Returns false when the row already existed (idempotent).
 */
async function createSettlement(
  db: D1Database,
  input: {
    id: string;
    auctionId: string;
    attempt: number;
    buyerUserId: string;
    bikeId: string;
    title: string;
    priceMinor: number;
    startAt: number;
    now: number;
  },
): Promise<boolean> {
  const held = await heldDeposits(db, input.buyerUserId);
  const t = settlementTerms({
    priceMinor: input.priceMinor,
    depositHeldMinor: held.total,
    startAt: input.startAt,
  });
  const status = t.initialDueMinor === 0 ? "AWAITING_BALANCE" : "AWAITING_INITIAL";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO settlements (id, auction_id, attempt, buyer_user_id, bike_id, title, status,
           price_minor, fee_minor, gst_minor, total_minor, deposit_minor, initial_due_minor, payable_minor,
           start_at, initial_deadline, balance_deadline, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)`,
      )
      .bind(
        input.id,
        input.auctionId,
        input.attempt,
        input.buyerUserId,
        input.bikeId,
        input.title,
        status,
        t.priceMinor,
        t.feeMinor,
        t.gstMinor,
        t.totalMinor,
        held.total,
        t.initialDueMinor,
        t.payableMinor,
        input.startAt,
        t.initialDeadline,
        t.balanceDeadline,
        input.now,
      ),
  ];
  if (held.ids.length > 0) {
    // Applied only if THIS call created the row (created_at = our now) — a re-run never re-applies.
    stmts.push(
      db
        .prepare(
          `UPDATE deposits SET status = 'APPLIED', settlement_id = ?1, updated_at = ?2
           WHERE id IN (${held.ids.map((_, i) => `?${i + 3}`).join(",")}) AND status = 'HELD'
             AND (SELECT created_at FROM settlements WHERE id = ?1) = ?2`,
        )
        .bind(input.id, input.now, ...held.ids),
    );
  }
  const res = await db.batch(stmts);
  return (res[0]?.meta.changes ?? 0) > 0;
}

/** Opens a settlement for every SOLD auction that has none yet (optionally only one buyer's). */
async function openNew(db: D1Database, now: number, buyerUserId?: string): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT r.id, r.winner_user_id, r.current_price_minor, r.closes_at, l.bike_id, l.title
       FROM auctions_rm r JOIN auction_listings l ON l.auction_id = r.id
       WHERE r.status = 'ENDED' AND r.outcome = 'SOLD' AND r.winner_user_id IS NOT NULL
         AND r.current_price_minor > 0 ${buyerUserId ? "AND r.winner_user_id = ?" : ""}
         AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.auction_id = r.id)
         AND r.closes_at >= COALESCE((SELECT value FROM settlement_config WHERE key = 'opens_from'), 0)
       LIMIT 50`,
    )
    .bind(...(buyerUserId ? [buyerUserId] : []))
    .all<{
      id: string;
      winner_user_id: string;
      current_price_minor: number;
      closes_at: number;
      bike_id: string;
      title: string;
    }>();
  let opened = 0;
  for (const r of rows.results) {
    const created = await createSettlement(db, {
      id: `stl_${r.id.replace(/^auc_/, "")}_1`,
      auctionId: r.id,
      attempt: 1,
      buyerUserId: r.winner_user_id,
      bikeId: r.bike_id,
      title: r.title,
      priceMinor: r.current_price_minor,
      startAt: r.closes_at,
      now,
    });
    if (created) opened++;
  }
  return opened;
}

/** Defaults every owing settlement whose current deadline has passed (no timely report pending). */
async function defaultOverdue(db: D1Database, now: number): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT s.*, (SELECT COALESCE(SUM(p.amount_minor), 0) FROM settlement_payments p
                     WHERE p.settlement_id = s.id AND p.status = 'VERIFIED') AS verified
       FROM settlements s
       WHERE s.status IN ${IN_OWING}
         AND ?1 > (CASE s.status WHEN 'AWAITING_INITIAL' THEN s.initial_deadline ELSE s.balance_deadline END) + s.extension_ms
       LIMIT 100`,
    )
    .bind(now)
    .all<SettlementRow & { verified: number }>();
  const defaulted: string[] = [];
  for (const r of rows.results) {
    const due = amountDueNow(termsOf(r), r.verified, r.extension_ms);
    const pending = await db
      .prepare(
        `SELECT 1 FROM settlement_payments WHERE settlement_id = ? AND status = 'REPORTED' AND reported_at <= ? LIMIT 1`,
      )
      .bind(r.id, due.deadline ?? 0)
      .first();
    if (!isDefaulted({ deadline: due.deadline, now, pendingReportedBeforeDeadline: !!pending }))
      continue;
    const reason =
      r.status === "AWAITING_INITIAL"
        ? "The 25% payment was not received within 24 hours."
        : "The balance was not received by the 15-day deadline.";
    const res = await db.batch([
      db
        .prepare(
          `UPDATE settlements SET status = 'DEFAULTED', closed_reason = ?, refund_due_minor = ?, updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .bind(reason, r.verified, now, r.id, r.status),
      // The deposit is forfeited; payments already made are refunded (refund_due_minor).
      db
        .prepare(
          `UPDATE deposits SET status = 'FORFEITED', updated_at = ?1
           WHERE settlement_id = ?2 AND status = 'APPLIED'
             AND (SELECT updated_at FROM settlements WHERE id = ?2 AND status = 'DEFAULTED') = ?1`,
        )
        .bind(now, r.id),
      db
        .prepare(
          `INSERT INTO bidder_flags (user_id, suspended, defaults, reason, updated_at)
           SELECT ?1, 1, 1, ?2, ?3 WHERE (SELECT updated_at FROM settlements WHERE id = ?4 AND status = 'DEFAULTED') = ?3
           ON CONFLICT (user_id) DO UPDATE SET suspended = 1, defaults = bidder_flags.defaults + 1,
             reason = excluded.reason, updated_at = excluded.updated_at`,
        )
        .bind(r.buyer_user_id, `Missed a payment deadline (${r.title})`, now, r.id),
    ]);
    if ((res[0]?.meta.changes ?? 0) > 0) defaulted.push(r.id);
  }
  return defaulted;
}

async function expireOffers(db: D1Database, now: number) {
  await db
    .prepare(
      `UPDATE settlements SET status = 'EXPIRED', closed_reason = 'The offer was not accepted within 24 hours.', updated_at = ?1
       WHERE status = 'OFFERED' AND offer_expires_at < ?1`,
    )
    .bind(now)
    .run();
}

/** Brings every settlement up to date: open new ones, expire offers, default overdue ones. */
export async function sweep(
  env: { DB: D1Database },
  now = Date.now(),
  buyerUserId?: string,
): Promise<{ opened: number; defaulted: string[] }> {
  const opened = await openNew(env.DB, now, buyerUserId);
  await expireOffers(env.DB, now);
  const defaulted = await defaultOverdue(env.DB, now);
  return { opened, defaulted };
}

export async function getRow(db: D1Database, id: string): Promise<SettlementRow | null> {
  return db.prepare(`SELECT * FROM settlements WHERE id = ?`).bind(id).first<SettlementRow>();
}

/** Re-derives the stage after a payment decision; moves AWAITING_* forward (guarded). */
export async function advance(
  db: D1Database,
  id: string,
  now: number,
): Promise<SettlementRow | null> {
  const r = await getRow(db, id);
  if (!r || !OWING_STATUSES.includes(r.status as (typeof OWING_STATUSES)[number])) return r;
  const verified = await verifiedSum(db, id);
  const stage = settlementStage(termsOf(r), verified);
  if (stage === r.status) return r;
  await db
    .prepare(
      `UPDATE settlements SET status = ?, gate_pass = CASE WHEN ? = 'PAID' THEN ? ELSE gate_pass END, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .bind(stage, stage, gatePass(), now, id, r.status)
    .run();
  return getRow(db, id);
}

export async function verifiedSum(db: D1Database, settlementId: string): Promise<number> {
  const v = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS v FROM settlement_payments WHERE settlement_id = ? AND status = 'VERIFIED'`,
    )
    .bind(settlementId)
    .first<{ v: number }>();
  return v?.v ?? 0;
}

/** Accepting a runner-up offer: the clock starts now and HELD deposits are applied. */
export async function acceptOffer(db: D1Database, r: SettlementRow, now: number): Promise<boolean> {
  if (r.status !== "OFFERED" || (r.offer_expires_at ?? 0) < now) return false;
  const held = await heldDeposits(db, r.buyer_user_id);
  const t = settlementTerms({
    priceMinor: r.price_minor,
    depositHeldMinor: held.total,
    startAt: now,
  });
  const status = t.initialDueMinor === 0 ? "AWAITING_BALANCE" : "AWAITING_INITIAL";
  const stmts = [
    db
      .prepare(
        `UPDATE settlements SET status = ?1, fee_minor = ?2, gst_minor = ?3, total_minor = ?4, deposit_minor = ?5,
           initial_due_minor = ?6, payable_minor = ?7, start_at = ?8, initial_deadline = ?9, balance_deadline = ?10,
           offer_expires_at = NULL, updated_at = ?8
         WHERE id = ?11 AND status = 'OFFERED'`,
      )
      .bind(
        status,
        t.feeMinor,
        t.gstMinor,
        t.totalMinor,
        held.total,
        t.initialDueMinor,
        t.payableMinor,
        now,
        t.initialDeadline,
        t.balanceDeadline,
        r.id,
      ),
  ];
  if (held.ids.length > 0) {
    stmts.push(
      db
        .prepare(
          `UPDATE deposits SET status = 'APPLIED', settlement_id = ?1, updated_at = ?2
           WHERE id IN (${held.ids.map((_, i) => `?${i + 3}`).join(",")}) AND status = 'HELD'
             AND (SELECT updated_at FROM settlements WHERE id = ?1 AND start_at = ?2) = ?2`,
        )
        .bind(r.id, now, ...held.ids),
    );
  }
  const res = await db.batch(stmts);
  return (res[0]?.meta.changes ?? 0) > 0;
}

export { createSettlement };

/* ------------------------------ eligibility ------------------------------ */

export interface Eligibility {
  canBid: boolean;
  blockedReason: string | null;
  heldMinor: number;
  buyingLimitMinor: number | null;
  required: boolean;
}

export async function eligibility(
  env: { DB: D1Database; REQUIRE_DEPOSIT?: string; BLOCK_BIDDING_WHILE_OWING?: string },
  userId: string,
): Promise<Eligibility> {
  const required = env.REQUIRE_DEPOSIT === "true";
  const [flag, owing, held] = await env.DB.batch([
    env.DB.prepare(`SELECT suspended FROM bidder_flags WHERE user_id = ?`).bind(userId),
    env.DB.prepare(
      `SELECT title FROM settlements WHERE buyer_user_id = ? AND status IN ${IN_OWING} ORDER BY created_at LIMIT 1`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS held FROM deposits WHERE user_id = ? AND status = 'HELD'`,
    ).bind(userId),
  ]);
  const heldMinor = Number((held?.results?.[0] as { held?: number } | undefined)?.held ?? 0);
  const limit = required || heldMinor > 0 ? buyingLimitMinor(heldMinor) : null;
  const suspended = (flag?.results?.[0] as { suspended?: number } | undefined)?.suspended === 1;
  const owingTitle = (owing?.results?.[0] as { title?: string } | undefined)?.title;
  let blockedReason: string | null = null;
  if (suspended)
    blockedReason =
      "Bidding is paused on your account after a missed payment. Contact us to have it reviewed.";
  else if (owingTitle && env.BLOCK_BIDDING_WHILE_OWING !== "false")
    blockedReason = `Complete the payment for ${owingTitle} before bidding on another auction.`;
  else if (required && heldMinor === 0)
    blockedReason = "Pay a refundable participation deposit to start bidding.";
  return {
    canBid: blockedReason === null,
    blockedReason,
    heldMinor,
    buyingLimitMinor: limit,
    required,
  };
}

/* --------------------------------- views --------------------------------- */

function paymentView(p: PaymentRow, buyerUserId: string): Payment {
  return {
    id: p.id,
    amountMinor: p.amount_minor,
    method: p.method,
    reference: p.reference,
    status: p.status,
    reportedAt: p.reported_at,
    decidedAt: p.decided_at,
    rejectReason: p.reject_reason,
    recordedByAdmin: p.reported_by !== buyerUserId,
  };
}

export async function views(db: D1Database, rows: SettlementRow[]): Promise<Settlement[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const bikeIds = [...new Set(rows.map((r) => r.bike_id))];
  const [pay, covers] = await db.batch([
    db
      .prepare(
        `SELECT * FROM settlement_payments WHERE settlement_id IN (${placeholders(ids.length)}) ORDER BY reported_at`,
      )
      .bind(...ids),
    db
      .prepare(
        `SELECT b.id, (SELECT i.r2_key FROM bike_images i WHERE i.bike_id = b.id ORDER BY i.position LIMIT 1) AS k
         FROM bikes b WHERE b.id IN (${placeholders(bikeIds.length)})`,
      )
      .bind(...bikeIds),
  ]);
  const payments = (pay?.results ?? []) as PaymentRow[];
  const cover = new Map(
    ((covers?.results ?? []) as { id: string; k: string | null }[]).map((c) => [c.id, c.k]),
  );
  return rows.map((r) => {
    const mine = payments.filter((p) => p.settlement_id === r.id);
    const paid = mine
      .filter((p) => p.status === "VERIFIED")
      .reduce((s, p) => s + p.amount_minor, 0);
    const reported = mine
      .filter((p) => p.status === "REPORTED")
      .reduce((s, p) => s + p.amount_minor, 0);
    const owing = OWING_STATUSES.includes(r.status as (typeof OWING_STATUSES)[number]);
    const due = owing ? amountDueNow(termsOf(r), paid, r.extension_ms) : null;
    const k = cover.get(r.bike_id);
    return {
      id: r.id,
      auctionId: r.auction_id,
      attempt: r.attempt,
      title: r.title,
      bikeId: r.bike_id,
      coverUrl: k ? imageUrl(k) : null,
      status: r.status,
      priceMinor: r.price_minor,
      feeMinor: r.fee_minor,
      gstMinor: r.gst_minor,
      totalMinor: r.total_minor,
      depositMinor: Math.min(r.deposit_minor, r.total_minor),
      initialDueMinor: r.initial_due_minor,
      payableMinor: r.payable_minor,
      paidMinor: paid,
      reportedMinor: reported,
      dueNowMinor: due ? Math.max(0, due.dueMinor) : 0,
      dueBy: due?.deadline ?? (r.status === "OFFERED" ? r.offer_expires_at : null),
      startAt: r.start_at,
      initialDeadline:
        r.initial_deadline !== null
          ? r.initial_deadline + (r.status === "AWAITING_INITIAL" ? r.extension_ms : 0)
          : null,
      balanceDeadline:
        r.balance_deadline !== null
          ? r.balance_deadline + (r.status === "AWAITING_BALANCE" ? r.extension_ms : 0)
          : null,
      offerExpiresAt: r.offer_expires_at,
      extensionMs: r.extension_ms,
      gatePass: r.status === "PAID" || r.status === "COLLECTED" ? r.gate_pass : null,
      refundDueMinor: r.refund_due_minor,
      refundedAt: r.refunded_at,
      closedReason: r.closed_reason,
      nextStep: r.next_step,
      updatedAt: r.updated_at,
      payments: mine.map((p) => paymentView(p, r.buyer_user_id)),
    };
  });
}

export async function adminViews(
  db: D1Database,
  rows: SettlementRow[],
): Promise<AdminSettlement[]> {
  const base = await views(db, rows);
  if (rows.length === 0) return [];
  const users = [...new Set(rows.map((r) => r.buyer_user_id))];
  const u = await db
    .prepare(
      `SELECT u.id, u.name, u.email, COALESCE(f.defaults, 0) AS defaults, COALESCE(f.suspended, 0) AS suspended
       FROM "user" u LEFT JOIN bidder_flags f ON f.user_id = u.id WHERE u.id IN (${placeholders(users.length)})`,
    )
    .bind(...users)
    .all<{ id: string; name: string; email: string; defaults: number; suspended: number }>();
  const byId = new Map(u.results.map((x) => [x.id, x]));
  return base.map((s, i) => {
    const b = byId.get(rows[i]!.buyer_user_id);
    return {
      ...s,
      buyer: {
        id: rows[i]!.buyer_user_id,
        name: b?.name ?? "Deleted account",
        email: b?.email ?? "",
        defaults: b?.defaults ?? 0,
        suspended: b?.suspended === 1,
      },
      pendingReports: s.payments.filter((p) => p.status === "REPORTED").length,
    };
  });
}

export function depositView(d: {
  id: string;
  amount_minor: number;
  method: Deposit["method"];
  reference: string;
  status: Deposit["status"];
  note: string | null;
  created_at: number;
  updated_at: number;
}): Deposit {
  return {
    id: d.id,
    amountMinor: d.amount_minor,
    method: d.method,
    reference: d.reference,
    status: d.status,
    note: d.note,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

export { newId, SETTLEMENT_RULES };
