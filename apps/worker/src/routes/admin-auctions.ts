import type { AuctionPatch } from "@bike/domain";
import { EFFECTIVE } from "./catalogue";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AdminResult } from "../auction/auction-do";
import { titleFor } from "../catalogue/bikes";
import { newId } from "../lib/ids";
import { errorFields } from "../lib/logger";
import { AppError } from "../lib/problem";
import type { AppEnv } from "../types";
import { audit, json } from "./admin-bikes";
import { AuctionId, auctionStub } from "./auctions";

/** Admin auction routes (mounted under the admin router, which enforces ADMIN). All audited. */
export const adminAuctionRoutes = new Hono<AppEnv>();

const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));
const Paise = z.number().int().positive();
const Terms = z.string().trim().max(2000);

const CreateBody = z.strictObject({
  bikeId: z.string().regex(/^bike_[a-f0-9]{32}$/),
  startPriceMinor: Paise,
  reserveMinor: Paise.nullable().default(null),
  startsAt: Iso,
  closesAt: Iso,
  antiSniping: z.boolean().default(true),
  terms: Terms.default(""),
  /** Default: create as a DRAFT for review; schedule separately. */
  schedule: z.boolean().default(false),
});

const PatchBody = z
  .strictObject({
    startPriceMinor: Paise.optional(),
    reserveMinor: Paise.nullable().optional(),
    startsAt: Iso.optional(),
    closesAt: Iso.optional(),
    terms: Terms.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");

const CancelBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

function id(c: Context<AppEnv>): string {
  const p = AuctionId.safeParse(c.req.param("id"));
  if (!p.success) throw new AppError("NOT_FOUND", "Auction not found");
  return p.data;
}

/** Make the catalogue reflect a command immediately (best effort; the outbox retries anyway). */
async function syncNow(c: Context<AppEnv>, auctionId: string) {
  try {
    await auctionStub(c.env, auctionId).retryProjection();
  } catch (err) {
    c.get("log").warn("admin.sync_now_failed", { auctionId, ...errorFields(err) });
  }
}

async function respond(
  c: Context<AppEnv>,
  r: AdminResult,
  action: string,
  auctionId: string,
  meta: object,
  status: 200 | 201 = 200,
) {
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND") throw new AppError("NOT_FOUND", r.error.message);
    throw new AppError(r.error.code, r.error.message);
  }
  await syncNow(c, auctionId);
  await audit(c, action, "auction", auctionId, { ...meta });
  return c.json(r.details, status);
}

/**
 * Create an auction for an existing, inspected bike.
 * Order (D1 ↔ DO consistency): 1) reserve the bike by inserting the listing row (the unique index
 * rejects a second open auction, even under a race); 2) create the auction object; 3) if that fails,
 * delete the listing row. A listing whose object was never created has no read-model row, so it is
 * invisible to buyers and is released after 2 minutes (see the open-auction check).
 */
adminAuctionRoutes.post("/auctions", async (c) => {
  const b = await json(c, CreateBody);
  const bike = await c.env.DB.prepare(
    `SELECT b.make, b.model, b.variant, b.manufacture_year AS manufactureYear,
       (SELECT COUNT(*) FROM bike_inspections i WHERE i.bike_id = b.id) AS inspections
     FROM bikes b WHERE b.id = ?`,
  )
    .bind(b.bikeId)
    .first<{
      make: string;
      model: string;
      variant: string | null;
      manufactureYear: number;
      inspections: number;
    }>();
  if (!bike) throw new AppError("VALIDATION_FAILED", "bikeId: no such bike");
  if (bike.inspections === 0)
    throw new AppError("VALIDATION_FAILED", "Record an inspection before creating an auction");

  // Release listings stranded by a failed create (no auction object after 2 minutes).
  await c.env.DB.prepare(
    `UPDATE auction_listings SET active = 0 WHERE bike_id = ? AND active = 1 AND created_at < ?
       AND auction_id NOT IN (SELECT id FROM auctions_rm)`,
  )
    .bind(b.bikeId, Date.now() - 120_000)
    .run();

  const auctionId = newId("auc");
  try {
    await c.env.DB.prepare(
      `INSERT INTO auction_listings (auction_id, bike_id, title, terms, active, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(auctionId, b.bikeId, titleFor(bike), b.terms, c.get("user")!.id, Date.now())
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE"))
      throw new AppError("CONFLICT", "This bike already has an open auction");
    throw err;
  }

  let r: AdminResult;
  try {
    r = await auctionStub(c.env, auctionId).create({
      auctionId,
      startPriceMinor: b.startPriceMinor,
      reserveMinor: b.reserveMinor,
      startsAt: b.startsAt,
      closesAt: b.closesAt,
      schedule: b.schedule,
      antiSniping: b.antiSniping,
    });
  } catch (err) {
    r = { ok: false, error: { code: "INTERNAL" as never, message: String(err) } };
  }
  if (!r.ok) {
    await c.env.DB.prepare(`DELETE FROM auction_listings WHERE auction_id = ?`)
      .bind(auctionId)
      .run();
    if ((r.error.code as string) === "INTERNAL") throw new AppError("INTERNAL");
  }
  const { bikeId, terms: _t, ...meta } = b;
  return respond(c, r, "AUCTION_CREATED", auctionId, { bikeId, ...meta }, 201);
});

/** Auction Desk list (all statuses incl. drafts; admin-only). */
adminAuctionRoutes.get("/auctions", async (c) => {
  const status = z
    .enum(["DRAFT", "SCHEDULED", "LIVE", "ENDED", "CANCELLED"])
    .optional()
    .safeParse(c.req.query("status"));
  if (!status.success) throw new AppError("VALIDATION_FAILED", "Unknown status");
  const rows = await c.env.DB.prepare(
    `SELECT l.auction_id AS auctionId, l.title, l.bike_id AS bikeId, l.created_at AS createdAt,
       ${EFFECTIVE} AS status, r.outcome, r.start_price_minor AS startPriceMinor, r.current_price_minor AS currentPriceMinor,
       r.bid_count AS bidCount, r.starts_at AS startsAt, r.closes_at AS closesAt, r.has_reserve AS hasReserve,
       r.reserve_met AS reserveMet
     FROM auction_listings l JOIN auctions_rm r ON r.id = l.auction_id
     WHERE (?2 IS NULL OR ${EFFECTIVE} = ?2)
     ORDER BY CASE ${EFFECTIVE} WHEN 'LIVE' THEN 0 WHEN 'SCHEDULED' THEN 1 WHEN 'DRAFT' THEN 2 ELSE 3 END, r.closes_at DESC
     LIMIT 200`,
  )
    .bind(Date.now(), status.data ?? null)
    .all();
  return c.json({ items: rows.results });
});

adminAuctionRoutes.get("/auctions/:id", async (c) => {
  const auctionId = id(c);
  const details = await auctionStub(c.env, auctionId).getAdminDetails();
  if (!details) throw new AppError("NOT_FOUND", "Auction not found");
  const listing = await c.env.DB.prepare(
    `SELECT bike_id AS bikeId, title, terms FROM auction_listings WHERE auction_id = ?`,
  )
    .bind(auctionId)
    .first();
  c.header("Cache-Control", "no-store");
  return c.json({ ...details, listing });
});

adminAuctionRoutes.patch("/auctions/:id", async (c) => {
  const raw = await json(c, PatchBody);
  const auctionId = id(c);
  const { terms, ...termsless } = raw;
  const patch = Object.fromEntries(
    Object.entries(termsless).filter(([, v]) => v !== undefined),
  ) as AuctionPatch;
  const stub = auctionStub(c.env, auctionId);
  // Terms are listing content (D1) but follow the same rule: editable only before the auction is live.
  const r = Object.keys(patch).length ? await stub.update(patch) : await stub.update({});
  if (r.ok && terms !== undefined) {
    if (!["DRAFT", "SCHEDULED"].includes(r.details.state.status))
      throw new AppError("INVALID_TRANSITION", "Terms are locked once live");
    await c.env.DB.prepare(`UPDATE auction_listings SET terms = ? WHERE auction_id = ?`)
      .bind(terms, auctionId)
      .run();
  }
  return respond(c, r, "AUCTION_UPDATED", auctionId, { fields: Object.keys(raw) });
});

adminAuctionRoutes.post("/auctions/:id/schedule", async (c) => {
  const auctionId = id(c);
  return respond(
    c,
    await auctionStub(c.env, auctionId).schedule(),
    "AUCTION_SCHEDULED",
    auctionId,
    {},
  );
});

adminAuctionRoutes.post("/auctions/:id/cancel", async (c) => {
  const { reason } = await json(c, CancelBody);
  const auctionId = id(c);
  return respond(
    c,
    await auctionStub(c.env, auctionId).cancel(reason),
    "AUCTION_CANCELLED",
    auctionId,
    { reason },
  );
});

adminAuctionRoutes.post("/auctions/:id/retry-projection", async (c) => {
  const auctionId = id(c);
  const pending = await auctionStub(c.env, auctionId).retryProjection();
  await audit(c, "PROJECTION_RETRIED", "auction", auctionId, { pending });
  return c.json({ pending });
});
