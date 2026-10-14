import { imageStore } from "../lib/image-store";
import type { AuctionList } from "@bike/contracts";
import { ListSort, ListStatus, type AuctionCard } from "@bike/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { getBike } from "../catalogue/bikes";
import { IMAGE_KEY, imageUrl } from "../catalogue/images";
import { AppError } from "../lib/problem";
import type { AppEnv } from "../types";

/**
 * Public catalogue, served from D1 read models only (never a fan-out to auction objects).
 * Live price/status for one auction always come from its DO (GET /auctions/:id).
 */
export const catalogueRoutes = new Hono<AppEnv>();

const int = z.coerce.number().int();
const ListQuery = z
  .object({
    status: ListStatus.default("ACTIVE"),
    sort: ListSort.optional(),
    make: z.string().trim().min(1).max(40).optional(),
    q: z.string().trim().min(2).max(60).optional(),
    city: z.string().trim().min(1).max(60).optional(),
    yearMin: int.min(1990).max(2100).optional(),
    yearMax: int.min(1990).max(2100).optional(),
    ccMin: int.min(0).max(5000).optional(),
    ccMax: int.min(0).max(5000).optional(),
    priceMin: int.min(0).optional(), // paise
    priceMax: int.min(0).optional(),
    limit: int.min(1).max(48).default(12),
    cursor: z.string().max(300).optional(),
  })
  .refine(
    (q) => q.yearMin === undefined || q.yearMax === undefined || q.yearMin <= q.yearMax,
    "yearMin > yearMax",
  )
  .refine(
    (q) => q.ccMin === undefined || q.ccMax === undefined || q.ccMin <= q.ccMax,
    "ccMin > ccMax",
  )
  .refine(
    (q) => q.priceMin === undefined || q.priceMax === undefined || q.priceMin <= q.priceMax,
    "priceMin > priceMax",
  );

/**
 * Effective status from the authoritative schedule: the read model can lag the auction object by
 * moments, and a start/close may be due before its alarm's projection lands. (The DO stays the
 * authority; this only keeps the catalogue honest about timing.)
 */
export const EFFECTIVE = `(CASE
  WHEN r.status = 'SCHEDULED' AND r.starts_at <= ?1 AND r.closes_at > ?1 THEN 'LIVE'
  WHEN r.status IN ('SCHEDULED','LIVE') AND r.closes_at <= ?1 THEN 'ENDED'
  ELSE r.status END)`;
const PRICE = `COALESCE(r.current_price_minor, r.start_price_minor)`;

const SORTS: Record<ListSort, { expr: string; dir: "ASC" | "DESC" }> = {
  ending_soon: { expr: "r.closes_at", dir: "ASC" },
  starting_soon: { expr: "r.starts_at", dir: "ASC" },
  recently_ended: { expr: "r.closes_at", dir: "DESC" },
  price_asc: { expr: PRICE, dir: "ASC" },
  price_desc: { expr: PRICE, dir: "DESC" },
  newest: { expr: "l.created_at", dir: "DESC" },
};
const DEFAULT_SORT: Record<ListStatus, ListSort> = {
  ACTIVE: "ending_soon",
  LIVE: "ending_soon",
  UPCOMING: "starting_soon",
  ENDED: "recently_ended",
};

// Keyset cursor: [sortValue, auctionId, sort] (base64url). Bound to its sort so it can't be misused.
const Cursor = z.tuple([z.number(), z.string(), ListSort]);
const b64 = (s: string) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
function decodeCursor(s: string, sort: ListSort): [number, string] {
  try {
    const [v, id, forSort] = Cursor.parse(
      JSON.parse(atob(s.replaceAll("-", "+").replaceAll("_", "/"))),
    );
    if (forSort !== sort) throw new Error("sort mismatch");
    return [v, id];
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor");
  }
}

catalogueRoutes.get("/auctions", async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message);
  const q = parsed.data;
  const sort = q.sort ?? DEFAULT_SORT[q.status];
  const { expr, dir } = SORTS[sort];
  const now = Date.now();
  const binds: unknown[] = [now];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const where: string[] = [
    q.status === "ACTIVE"
      ? `${EFFECTIVE} IN ('LIVE','SCHEDULED')`
      : `${EFFECTIVE} = ${p(q.status === "UPCOMING" ? "SCHEDULED" : q.status)}`,
  ];
  if (q.make) where.push(`b.make = ${p(q.make)} COLLATE NOCASE`);
  if (q.city) where.push(`b.city = ${p(q.city)} COLLATE NOCASE`);
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(`(l.title LIKE ${p(like)} ESCAPE '\\' COLLATE NOCASE)`);
  }
  if (q.yearMin !== undefined) where.push(`b.manufacture_year >= ${p(q.yearMin)}`);
  if (q.yearMax !== undefined) where.push(`b.manufacture_year <= ${p(q.yearMax)}`);
  if (q.ccMin !== undefined) where.push(`b.engine_cc >= ${p(q.ccMin)}`);
  if (q.ccMax !== undefined) where.push(`b.engine_cc <= ${p(q.ccMax)}`);
  if (q.priceMin !== undefined) where.push(`${PRICE} >= ${p(q.priceMin)}`);
  if (q.priceMax !== undefined) where.push(`${PRICE} <= ${p(q.priceMax)}`);
  if (q.cursor) {
    const [v, id] = decodeCursor(q.cursor, sort);
    const cmp = dir === "ASC" ? ">" : "<";
    const pv = p(v);
    where.push(`(${expr} ${cmp} ${pv} OR (${expr} = ${pv} AND l.auction_id ${cmp} ${p(id)}))`);
  }
  const lim = p(q.limit + 1);
  const rows = await c.env.DB.prepare(
    `SELECT l.auction_id, l.title, b.make, b.model, b.variant, b.manufacture_year, b.km_driven, b.owner_count, b.fuel,
       b.engine_cc, b.city, b.repossessed, r.outcome, r.start_price_minor, r.current_price_minor, r.bid_count, r.starts_at,
       r.closes_at, r.has_reserve, r.reserve_met, ${EFFECTIVE} AS effective_status, ${expr} AS sort_value,
       (SELECT grade FROM bike_inspections i WHERE i.bike_id = b.id ORDER BY version DESC LIMIT 1) AS grade,
       (SELECT i.r2_key FROM bike_images i WHERE i.bike_id = b.id ORDER BY i.position LIMIT 1) AS cover_key
     FROM auction_listings l JOIN bikes b ON b.id = l.bike_id JOIN auctions_rm r ON r.id = l.auction_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${expr} ${dir}, l.auction_id ${dir}
     LIMIT ${lim}`,
  )
    .bind(...binds)
    .all<Record<string, number | string | null>>();
  const page = rows.results.slice(0, q.limit);
  const items: AuctionCard[] = page.map((r) => ({
    auctionId: r.auction_id as string,
    status: r.effective_status as AuctionCard["status"],
    outcome: (r.outcome as AuctionCard["outcome"]) ?? null,
    title: r.title as string,
    make: r.make as string,
    model: r.model as string,
    variant: (r.variant as string | null) ?? null,
    manufactureYear: r.manufacture_year as number,
    kmDriven: r.km_driven as number,
    ownerCount: r.owner_count as number,
    fuel: r.fuel as AuctionCard["fuel"],
    engineCc: (r.engine_cc as number | null) ?? null,
    city: r.city as string,
    inspectionGrade: (r.grade as AuctionCard["inspectionGrade"]) ?? null,
    repossessed: r.repossessed === 1,
    startPriceMinor: r.start_price_minor as number,
    currentPriceMinor: (r.current_price_minor as number | null) ?? null,
    bidCount: r.bid_count as number,
    startsAt: r.starts_at as number,
    closesAt: r.closes_at as number,
    hasReserve: r.has_reserve === 1,
    reserveMet: r.reserve_met === 1,
    coverUrl: r.cover_key ? imageUrl(r.cover_key as string) : null,
  }));
  const last = page.at(-1);
  const body: AuctionList = {
    items,
    nextCursor:
      rows.results.length > q.limit && last
        ? b64(JSON.stringify([last.sort_value as number, last.auction_id as string, sort]))
        : null,
  };
  c.header("Cache-Control", "no-store");
  return c.json(body);
});

/** Filter options for the catalogue UI (makes and cities that currently have public listings). */
catalogueRoutes.get("/catalogue/facets", async (c) => {
  const [makes, cities] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT DISTINCT b.make AS v FROM auction_listings l JOIN bikes b ON b.id = l.bike_id JOIN auctions_rm r ON r.id = l.auction_id
       WHERE r.status IN ('SCHEDULED','LIVE','ENDED') ORDER BY v`,
    ),
    c.env.DB.prepare(
      `SELECT DISTINCT b.city AS v FROM auction_listings l JOIN bikes b ON b.id = l.bike_id JOIN auctions_rm r ON r.id = l.auction_id
       WHERE r.status IN ('SCHEDULED','LIVE','ENDED') ORDER BY v`,
    ),
  ]);
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    makes: (makes?.results ?? []).map((r) => (r as { v: string }).v),
    cities: (cities?.results ?? []).map((r) => (r as { v: string }).v),
  });
});

/** Static listing content (bike, inspection, images, terms). Drafts are not public. */
catalogueRoutes.get("/auctions/:id/details", async (c) => {
  const listing = await c.env.DB.prepare(
    `SELECT l.auction_id, l.title, l.terms, l.bike_id, r.status FROM auction_listings l
     LEFT JOIN auctions_rm r ON r.id = l.auction_id WHERE l.auction_id = ?`,
  )
    .bind(c.req.param("id"))
    .first<{
      auction_id: string;
      title: string;
      terms: string;
      bike_id: string;
      status: string | null;
    }>();
  if (!listing || listing.status === null || listing.status === "DRAFT")
    throw new AppError("NOT_FOUND", "Auction not found");
  const bike = await getBike(c.env.DB, listing.bike_id);
  if (!bike) throw new AppError("NOT_FOUND", "Auction not found");
  c.header("Cache-Control", "no-store");
  return c.json({
    auctionId: listing.auction_id,
    title: listing.title,
    terms: listing.terms,
    bike,
  });
});

/** Images from the PRIVATE bucket, through the Worker (no public bucket URL exists). */
catalogueRoutes.get("/images/*", async (c) => {
  const key = c.req.path.replace(/^\/api\/v1\/images\//, "");
  if (!IMAGE_KEY.test(key)) throw new AppError("NOT_FOUND", "Image not found");
  const store = imageStore(c.env);
  const obj = store ? await store.get(key) : null;
  if (!obj) throw new AppError("NOT_FOUND", "Image not found");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      etag: obj.etag,
    },
  });
});
