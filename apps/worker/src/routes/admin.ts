import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../lib/problem";
import { requireAdmin } from "../middleware/session";
import { adminAuctionRoutes } from "./admin-auctions";
import { adminBikeRoutes } from "./admin-bikes";
import { adminOpsRoutes } from "./admin-ops";
import { adminSettlementRoutes } from "./admin-settlement";
import { EFFECTIVE } from "./catalogue";
import type { AppEnv } from "../types";

/**
 * Every route in this sub-app is admin-only: the guard is applied once at the router level, and
 * test/authz.test.ts enumerates `adminRoutes.routes` to prove anonymous → 401, user → 403.
 */
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

adminRoutes.get("/overview", async (c) => {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const [users, events, bikes, auctions] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT role, COUNT(*) AS n FROM "user" GROUP BY role`),
    c.env.DB.prepare(
      `SELECT type, COUNT(*) AS n FROM security_events WHERE created_at >= ? GROUP BY type`,
    ).bind(since),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM bikes`),
    // Same schedule-derived status the catalogue uses, so the KPIs match the desk rows.
    c.env.DB.prepare(
      `SELECT ${EFFECTIVE} AS status, COUNT(*) AS n FROM auctions_rm r GROUP BY 1`,
    ).bind(Date.now()),
  ]);
  return c.json({
    usersByRole: users?.results ?? [],
    securityEvents24h: events?.results ?? [],
    bikes: Number((bikes?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    auctionsByStatus: auctions?.results ?? [],
  });
});

const EventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});

adminRoutes.get("/security-events", async (c) => {
  const q = EventsQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError("VALIDATION_FAILED", q.error.issues[0]?.message);
  const { limit, before } = q.data;
  const rows = await c.env.DB.prepare(
    `SELECT id, type, user_id AS userId, request_id AS requestId, created_at AS createdAt
     FROM security_events WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(before ?? Number.MAX_SAFE_INTEGER, limit)
    .all();
  const items = rows.results as { createdAt: number }[];
  return c.json({ items, nextBefore: items.length === limit ? items.at(-1)!.createdAt : null });
});

adminRoutes.route("/", adminOpsRoutes);
adminRoutes.route("/", adminAuctionRoutes);
adminRoutes.route("/", adminBikeRoutes);
adminRoutes.route("/", adminSettlementRoutes);
