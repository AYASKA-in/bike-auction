import type { AuctionPatch } from "@bike/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AdminResult } from "../auction/auction-do";
import { newId } from "../lib/ids";
import { AppError } from "../lib/problem";
import type { AppEnv } from "../types";
import { AuctionId, auctionStub } from "./auctions";

/** Mounted under the admin router (requireAdmin applied there). Every mutation is audited. */
export const adminAuctionRoutes = new Hono<AppEnv>();

const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));
const Paise = z.number().int().positive();

const CreateBody = z.strictObject({
  startPriceMinor: Paise,
  reserveMinor: Paise.nullable().default(null),
  startsAt: Iso,
  closesAt: Iso,
  schedule: z.boolean().default(true),
  antiSniping: z.boolean().default(true),
});

const PatchBody = z
  .strictObject({
    startPriceMinor: Paise.optional(),
    reserveMinor: Paise.nullable().optional(),
    startsAt: Iso.optional(),
    closesAt: Iso.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");

const CancelBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message);
  return parsed.data;
}

function id(c: Context<AppEnv>): string {
  const p = AuctionId.safeParse(c.req.param("id"));
  if (!p.success) throw new AppError("NOT_FOUND", "Auction not found");
  return p.data;
}

async function audit(
  c: Context<AppEnv>,
  action: string,
  auctionId: string,
  metadata: Record<string, unknown>,
) {
  await c.env.DB.prepare(
    `INSERT INTO audit_log (id, actor_user_id, action, resource_type, resource_id, metadata_json, request_id, created_at)
     VALUES (?, ?, ?, 'auction', ?, ?, ?, ?)`,
  )
    .bind(
      newId("aud"),
      c.get("user")!.id,
      action,
      auctionId,
      JSON.stringify(metadata),
      c.get("requestId"),
      Date.now(),
    )
    .run();
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
  await audit(c, action, auctionId, { ...meta });
  return c.json(r.details, status);
}

adminAuctionRoutes.post("/auctions", async (c) => {
  const b = await body(c, CreateBody);
  const auctionId = newId("auc");
  const r = await auctionStub(c.env, auctionId).create({ auctionId, ...b });
  return respond(c, r, "AUCTION_CREATED", auctionId, b, 201);
});

adminAuctionRoutes.get("/auctions/:id", async (c) => {
  const details = await auctionStub(c.env, id(c)).getAdminDetails();
  if (!details) throw new AppError("NOT_FOUND", "Auction not found");
  c.header("Cache-Control", "no-store");
  return c.json(details);
});

adminAuctionRoutes.patch("/auctions/:id", async (c) => {
  const raw = await body(c, PatchBody);
  // Drop absent keys (exactOptionalPropertyTypes): "absent" means unchanged, null clears the reserve.
  const patch = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  ) as AuctionPatch;
  const auctionId = id(c);
  return respond(
    c,
    await auctionStub(c.env, auctionId).update(patch),
    "AUCTION_UPDATED",
    auctionId,
    patch,
  );
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
  const { reason } = await body(c, CancelBody);
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
  await audit(c, "PROJECTION_RETRIED", auctionId, { pending });
  return c.json({ pending });
});
