import {
  MyBidsTab,
  WATCHLIST_MAX,
  type AuctionCard,
  type Me,
  type MyBidCard,
  type MyBidsPage,
  type PublicConfig,
  type Watchlist,
  type WatchlistIds,
} from "@bike/contracts";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { imageUrl } from "../catalogue/images";
import { AppError, problemBody, problemResponse } from "../lib/problem";
import { requireUser } from "../middleware/session";
import type { AppEnv } from "../types";
import { AuctionId } from "./auctions";
import { EFFECTIVE } from "./catalogue";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", requireUser, (c) => {
  c.header("Cache-Control", "no-store");
  return c.json<Me>(c.get("user")!);
});

/** Public, non-secret runtime config so one SPA build serves every environment. */
export const configRoutes = new Hono<AppEnv>();
configRoutes.get("/config", (c) =>
  c.json<PublicConfig>({
    environment: c.env.ENVIRONMENT,
    turnstileSiteKey: c.env.TURNSTILE_SECRET_KEY ? (c.env.TURNSTILE_SITE_KEY ?? null) : null,
    demoMode: c.env.DEMO_MODE === "true",
  }),
);

// ---------------------------------------------------------------------------------------------
// Buyer self-service: /me/bids and /me/watchlist (Day 7). D1 read models only, never a DO fan-out.
// Identity comes from the session; responses carry no user ids, pseudonyms or reserve amounts.
// ---------------------------------------------------------------------------------------------

/** Signed-in buyers only: anonymous → 401, administrators → 403 (they don't bid or watch). */
const requireBuyer = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) throw new AppError("AUTH_REQUIRED", "Sign in to continue");
  if (user.role === "ADMIN") throw new AppError("FORBIDDEN", "Buyer accounts only");
  c.header("Cache-Control", "no-store");
  await next();
});

/**
 * Coarse per-user limit on watchlist writes. Reuses the edge BID_RATE_LIMIT namespace (30 / 10 s
 * per key) under its own `watch:` key, so it needs no new binding and never eats the bid budget.
 */
async function writeLimited(c: Context<AppEnv>): Promise<Response | null> {
  if (!c.env.BID_RATE_LIMIT) return null;
  const { success } = await c.env.BID_RATE_LIMIT.limit({ key: `watch:${c.get("user")!.id}` });
  if (success) return null;
  return problemResponse(
    problemBody("RATE_LIMITED", c.get("requestId"), "Too many watchlist changes. Slow down."),
    { "retry-after": "10" },
  );
}

const buyer = new Hono<AppEnv>();
// Explicit paths (not "*", which would also match GET /me itself, open to administrators).
// Hono's "/watchlist/*" also matches "/watchlist".
buyer.use("/bids", requireBuyer);
buyer.use("/watchlist/*", requireBuyer);

// Keyset cursor: [closesAt, auctionId, tab] (base64url), bound to its tab.
const Cursor = z.tuple([z.number().int(), z.string().max(64), MyBidsTab]);
const b64 = (s: string) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
function decodeCursor(s: string, tab: MyBidsTab): [number, string] {
  try {
    const [v, id, forTab] = Cursor.parse(
      JSON.parse(atob(s.replaceAll("-", "+").replaceAll("_", "/"))),
    );
    if (forTab !== tab) throw new Error("tab mismatch");
    return [v, id];
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor");
  }
}

const BidsQuery = z.object({
  tab: MyBidsTab.default("leading"),
  limit: z.coerce.number().int().min(1).max(48).default(24),
  cursor: z.string().max(300).optional(),
});

/**
 * Tab classification, all from D1 (`?1` = now, `?2` = the session user):
 *
 * - **leads** — D1 stores only the leader's pseudonym (auctions_rm.leading_bidder), so the user is
 *   the leader iff their highest bid equals the current price AND their last bid is the auction's
 *   latest accepted bid (max seq in auction_bids_rm). Accepted bids strictly increase and a leader
 *   cannot outbid themselves, so exactly one bidder satisfies this; both rows come from the same
 *   atomic projection batch, so they never disagree.
 * - **won** — finalised: status ENDED, outcome SOLD and winner_user_id = me. Between the scheduled
 *   close and the projection landing (moments), a leader whose reserve is met is shown as won too:
 *   that is exactly the engine's rule, and it stops a winner flickering through "lost".
 * - **lost** — ended or cancelled and not won. **leading/outbid** — effectively LIVE.
 */
const CLASSIFIED = `
  WITH mine AS (
    SELECT u.auction_id, u.highest_amount_minor, l.title, l.bike_id, r.status AS raw_status,
      r.outcome, r.current_price_minor, r.bid_count, r.starts_at, r.closes_at, r.reserve_met,
      ${EFFECTIVE} AS eff,
      (r.bid_count > 0 AND u.highest_amount_minor = r.current_price_minor AND u.last_bid_seq =
        (SELECT MAX(b.seq) FROM auction_bids_rm b WHERE b.auction_id = u.auction_id)) AS leads,
      (r.winner_user_id IS NOT NULL AND r.winner_user_id = ?2) AS is_winner
    FROM user_bids_rm u
    JOIN auctions_rm r ON r.id = u.auction_id
    JOIN auction_listings l ON l.auction_id = u.auction_id
    WHERE u.user_id = ?2
  )
  SELECT *, CASE
      WHEN eff = 'LIVE' THEN CASE WHEN leads THEN 'leading' ELSE 'outbid' END
      WHEN eff IN ('ENDED','CANCELLED') THEN CASE
        WHEN (raw_status = 'ENDED' AND outcome = 'SOLD' AND is_winner)
          OR (raw_status IN ('SCHEDULED','LIVE') AND eff = 'ENDED' AND leads AND reserve_met = 1)
        THEN 'won' ELSE 'lost' END
    END AS tab
  FROM mine`;

type BidRow = {
  auction_id: string;
  highest_amount_minor: number;
  title: string;
  bike_id: string;
  outcome: MyBidCard["outcome"];
  current_price_minor: number | null;
  bid_count: number;
  starts_at: number;
  closes_at: number;
  eff: MyBidCard["status"];
  leads: number | null;
  cover_key: string | null;
};

buyer.get("/bids", async (c) => {
  const parsed = BidsQuery.safeParse(c.req.query());
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message);
  const { tab, limit, cursor } = parsed.data;
  // Live tabs: ending soonest first. Finished tabs: most recently closed first.
  const dir = tab === "leading" || tab === "outbid" ? "ASC" : "DESC";
  const cmp = dir === "ASC" ? ">" : "<";
  const binds: unknown[] = [Date.now(), c.get("user")!.id, tab];
  let keyset = "";
  if (cursor) {
    const [v, id] = decodeCursor(cursor, tab);
    binds.push(v, id);
    keyset = `AND (closes_at ${cmp} ?4 OR (closes_at = ?4 AND auction_id ${cmp} ?5))`;
  }
  binds.push(limit + 1);
  const rows = await c.env.DB.prepare(
    `SELECT t.*, (SELECT i.r2_key FROM bike_images i WHERE i.bike_id = t.bike_id ORDER BY i.position LIMIT 1) AS cover_key
     FROM (${CLASSIFIED}) t
     WHERE tab = ?3 ${keyset}
     ORDER BY closes_at ${dir}, auction_id ${dir}
     LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<BidRow>();
  const page = rows.results.slice(0, limit);
  const items: MyBidCard[] = page.map((r) => ({
    auctionId: r.auction_id,
    title: r.title,
    coverUrl: r.cover_key ? imageUrl(r.cover_key) : null,
    status: r.eff,
    outcome: r.outcome ?? null,
    currentPriceMinor: r.current_price_minor ?? null,
    myHighestMinor: r.highest_amount_minor,
    bidCount: r.bid_count,
    closesAt: r.closes_at,
    startsAt: r.starts_at,
    isLeading: tab === "leading",
  }));
  const last = page.at(-1);
  return c.json<MyBidsPage>({
    tab,
    items,
    nextCursor:
      rows.results.length > limit && last
        ? b64(JSON.stringify([last.closes_at, last.auction_id, tab]))
        : null,
  });
});

buyer.get("/watchlist", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.auction_id, l.title, b.make, b.model, b.variant, b.manufacture_year, b.km_driven, b.owner_count, b.fuel,
       b.engine_cc, b.city, b.repossessed, r.outcome, r.start_price_minor, r.current_price_minor, r.bid_count,
       r.starts_at, r.closes_at, r.has_reserve, r.reserve_met, ${EFFECTIVE} AS effective_status, w.created_at AS watched_at,
       (SELECT grade FROM bike_inspections i WHERE i.bike_id = b.id ORDER BY version DESC LIMIT 1) AS grade,
       (SELECT i.r2_key FROM bike_images i WHERE i.bike_id = b.id ORDER BY i.position LIMIT 1) AS cover_key
     FROM watchlist w
     JOIN auction_listings l ON l.auction_id = w.auction_id
     JOIN bikes b ON b.id = l.bike_id
     JOIN auctions_rm r ON r.id = w.auction_id
     WHERE w.user_id = ?2 AND r.status <> 'DRAFT'
     ORDER BY w.created_at DESC, w.auction_id DESC
     LIMIT ${WATCHLIST_MAX}`,
  )
    .bind(Date.now(), c.get("user")!.id)
    .all<Record<string, number | string | null>>();
  const items = rows.results.map((r) => ({
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
    watchedAt: r.watched_at as number,
  }));
  return c.json<Watchlist>({ items });
});

/** Ids only, for the Watch buttons' pressed state (one cheap index-only query). */
buyer.get("/watchlist/ids", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT auction_id FROM watchlist WHERE user_id = ? ORDER BY created_at DESC LIMIT ${WATCHLIST_MAX}`,
  )
    .bind(c.get("user")!.id)
    .all<{ auction_id: string }>();
  return c.json<WatchlistIds>({
    ids: rows.results.map((r) => r.auction_id),
    max: WATCHLIST_MAX,
  });
});

function watchId(c: Context<AppEnv>): string {
  const id = AuctionId.safeParse(c.req.param("auctionId"));
  if (!id.success) throw new AppError("NOT_FOUND", "Auction not found");
  return id.data;
}

/** Idempotent add (204). Drafts and unknown auctions are 404; the 101st distinct auction is 409. */
buyer.put("/watchlist/:auctionId", async (c) => {
  const auctionId = watchId(c);
  const limited = await writeLimited(c);
  if (limited) return limited;
  const userId = c.get("user")!.id;
  const listing = await c.env.DB.prepare(
    `SELECT r.status FROM auction_listings l JOIN auctions_rm r ON r.id = l.auction_id WHERE l.auction_id = ?`,
  )
    .bind(auctionId)
    .first<{ status: string }>();
  if (!listing || listing.status === "DRAFT") throw new AppError("NOT_FOUND", "Auction not found");
  // One statement = atomic: the cap check and the insert can't interleave with a parallel PUT.
  const res = await c.env.DB.prepare(
    `INSERT INTO watchlist (user_id, auction_id, created_at)
     SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM watchlist WHERE user_id = ?1) < ?4
     ON CONFLICT (user_id, auction_id) DO NOTHING`,
  )
    .bind(userId, auctionId, Date.now(), WATCHLIST_MAX)
    .run();
  if (res.meta.changes === 0) {
    const exists = await c.env.DB.prepare(
      `SELECT 1 AS x FROM watchlist WHERE user_id = ? AND auction_id = ?`,
    )
      .bind(userId, auctionId)
      .first();
    if (!exists) {
      throw new AppError(
        "CONFLICT",
        `Your watchlist is full (${WATCHLIST_MAX}). Remove one to add another.`,
      );
    }
  }
  return c.body(null, 204);
});

/** Idempotent remove (204 even if it wasn't watched). */
buyer.delete("/watchlist/:auctionId", async (c) => {
  const auctionId = watchId(c);
  const limited = await writeLimited(c);
  if (limited) return limited;
  await c.env.DB.prepare(`DELETE FROM watchlist WHERE user_id = ? AND auction_id = ?`)
    .bind(c.get("user")!.id, auctionId)
    .run();
  return c.body(null, 204);
});

meRoutes.route("/me", buyer);
