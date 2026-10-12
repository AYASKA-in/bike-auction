import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../lib/problem";
import { isOriginAllowed } from "../middleware/security";
import type { AppEnv } from "../types";

export const auctionRoutes = new Hono<AppEnv>();

const AuctionId = z.string().regex(/^[a-z0-9_-]{3,64}$/i);

function auctionStub(env: Env, id: string) {
  return env.AUCTION.get(env.AUCTION.idFromName(id));
}

auctionRoutes.get("/:id/snapshot", async (c) => {
  const id = AuctionId.safeParse(c.req.param("id"));
  if (!id.success) throw new AppError("NOT_FOUND");
  const snap = await auctionStub(c.env, id.data).getPublicSnapshot();
  if (!snap) throw new AppError("NOT_FOUND", "Auction not found");
  c.header("Cache-Control", "no-store");
  return c.json(snap);
});

/**
 * Live event stream. Browsers do not apply CORS to WebSockets, so the Origin header is checked
 * explicitly to prevent cross-site WebSocket hijacking.
 */
auctionRoutes.get("/:id/stream", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new AppError("VALIDATION_FAILED", "Expected a WebSocket upgrade");
  }
  if (!isOriginAllowed(c.req.header("origin"), c.req.url, c.env)) {
    throw new AppError("FORBIDDEN", "Origin not allowed");
  }
  const id = AuctionId.safeParse(c.req.param("id"));
  if (!id.success) throw new AppError("NOT_FOUND");
  // Identity is attached server-side once sessions exist (Day 2); never trusted from the client.
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-user-id");
  const upstream = await auctionStub(c.env, id.data).fetch(new Request(c.req.raw, { headers }));
  // A 101 response returned through a Durable Object stub has immutable headers; re-wrap it so
  // the request-id and security-header middleware can annotate it.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: new Headers(upstream.headers),
    webSocket: upstream.webSocket,
  });
});
