import { IdempotencyKeyHeader, PlaceBidBody, SetMaxBidBody, type ErrorCode } from "@bike/contracts";
import type { StoredBidResult, StoredMaxBidResult } from "@bike/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eligibility } from "../settlement/service";
import { AppError, problemBody, problemResponse } from "../lib/problem";
import { isOriginAllowed } from "../middleware/security";
import { loadSession, requireUser } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Buyer-facing auction API. Every response is buyer-safe (PublicAuctionView / pseudonymous bids).
 * Identity comes only from the session; the client never supplies a user id or a timestamp.
 */
export const auctionRoutes = new Hono<AppEnv>();
auctionRoutes.use("*", loadSession);

export const AuctionId = z.string().regex(/^[A-Za-z0-9_-]{3,64}$/);

export function auctionStub(env: Env, id: string) {
  return env.AUCTION.get(env.AUCTION.idFromName(id));
}

function parseId(c: Context<AppEnv>): string {
  const id = AuctionId.safeParse(c.req.param("id"));
  if (!id.success) throw new AppError("NOT_FOUND", "Auction not found");
  return id.data;
}

auctionRoutes.get("/:id", async (c) => {
  const view = await auctionStub(c.env, parseId(c)).getView(c.get("user")?.id ?? null);
  if (!view) throw new AppError("NOT_FOUND", "Auction not found");
  c.header("Cache-Control", "no-store");
  return c.json(view);
});

const BidsQuery = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Cursor pagination by seq (newest first): ?beforeSeq=<nextBeforeSeq>&limit=30 */
auctionRoutes.get("/:id/bids", async (c) => {
  const q = BidsQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError("VALIDATION_FAILED", q.error.issues[0]?.message);
  const page = await auctionStub(c.env, parseId(c)).listBids({
    beforeSeq: q.data.beforeSeq ?? null,
    limit: q.data.limit,
    viewerUserId: c.get("user")?.id ?? null,
  });
  if (!page) throw new AppError("NOT_FOUND", "Auction not found");
  c.header("Cache-Control", "no-store");
  return c.json(page);
});

const BID_DETAIL: Partial<Record<ErrorCode, string>> = {
  BID_TOO_LOW: "Someone may have just bid. Your bid is below the minimum.",
  AUCTION_ENDED: "This auction has ended.",
  AUCTION_NOT_LIVE: "This auction has not started yet.",
  AUCTION_CANCELLED: "This auction was cancelled.",
  ALREADY_LEADING: "You already have the highest bid.",
  BID_UNREASONABLE: "That amount is far above the current price. Check it and try again.",
  BID_INVALID_AMOUNT: "Enter a whole amount in paise.",
};

function bidResponse(c: Context<AppEnv>, result: StoredBidResult, replayed: boolean): Response {
  const headers = { "Idempotent-Replayed": String(replayed), "Cache-Control": "no-store" };
  if (result.ok) {
    const { ok: _ok, ...body } = result;
    return c.json(body, 201, headers);
  }
  const { ok: _ok, code, ...extensions } = result;
  return problemResponse(
    problemBody(code, c.get("requestId"), BID_DETAIL[code], extensions),
    headers,
  );
}

/**
 * Place a bid. Requires a session and an `Idempotency-Key` header (16–128 chars [A-Za-z0-9_-]);
 * retrying with the same key returns the original result (`Idempotent-Replayed: true`).
 */
auctionRoutes.post("/:id/bids", requireUser, async (c) => {
  const user = c.get("user")!;
  if (user.role === "ADMIN") throw new AppError("FORBIDDEN", "Administrators cannot bid");
  const key = IdempotencyKeyHeader.safeParse(c.req.header("idempotency-key"));
  if (!key.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Send an Idempotency-Key header (16–128 letters, digits, - or _)",
    );
  }
  const body = PlaceBidBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success)
    throw new AppError("BID_INVALID_AMOUNT", "Send { amountMinor: <positive whole paise> }");
  const id = parseId(c);

  if (c.env.BID_RATE_LIMIT) {
    const { success } = await c.env.BID_RATE_LIMIT.limit({ key: `bid:${user.id}` });
    if (!success) {
      return problemResponse(
        problemBody("RATE_LIMITED", c.get("requestId"), "You're bidding very fast."),
        {
          "retry-after": "10",
        },
      );
    }
  }

  const elig = await eligibility(c.env, user.id);
  if (!elig.canBid)
    throw new AppError("FORBIDDEN", elig.blockedReason ?? "You can't bid right now.");
  if (elig.buyingLimitMinor !== null && body.data.amountMinor > elig.buyingLimitMinor) {
    throw new AppError(
      "FORBIDDEN",
      `Your buying limit is ₹${(elig.buyingLimitMinor / 100).toLocaleString("en-IN")} (10× your deposit). Add to your deposit to bid higher.`,
      { buyingLimitMinor: elig.buyingLimitMinor },
    );
  }
  const r = await auctionStub(c.env, id).placeBid({
    userId: user.id,
    amountMinor: body.data.amountMinor,
    idempotencyKey: key.data,
    requestId: c.get("requestId"),
  });
  switch (r.kind) {
    case "not_found":
      throw new AppError("NOT_FOUND", "Auction not found");
    case "account_closed":
      throw new AppError("FORBIDDEN", "This account has been closed.");
    case "conflict":
      throw new AppError(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used for a different bid",
      );
    case "rate_limited":
      return problemResponse(
        problemBody("RATE_LIMITED", c.get("requestId"), "You're bidding very fast."),
        {
          "retry-after": String(Math.ceil(r.retryAfterMs / 1000)),
        },
      );
    case "evaluated":
      return bidResponse(c, r.result, r.replayed);
  }
});

const MAX_BID_DETAIL: Partial<Record<ErrorCode, string>> = {
  ...BID_DETAIL,
  BID_TOO_LOW: "Your maximum must be at least the minimum next bid.",
  BID_UNREASONABLE: "That maximum is far above the current price. Check it and try again.",
};

/**
 * Set (or replace) your hidden maximum bid (proxy bidding, BLUEPRINT §4.7). USER only, requires an
 * `Idempotency-Key`. The 200 body is returned only to the owner; the maximum itself never appears
 * in any public view, event, history row or projection. Automatic bids it causes are ordinary
 * public bids with `kind: "PROXY"`. A maximum can be raised, or lowered while it stays ≥ the
 * minimum next bid; there is no DELETE (an active maximum is a commitment like a bid).
 */
auctionRoutes.put("/:id/max-bid", requireUser, async (c) => {
  const user = c.get("user")!;
  if (user.role === "ADMIN") throw new AppError("FORBIDDEN", "Administrators cannot bid");
  const key = IdempotencyKeyHeader.safeParse(c.req.header("idempotency-key"));
  if (!key.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Send an Idempotency-Key header (16–128 letters, digits, - or _)",
    );
  }
  const body = SetMaxBidBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success)
    throw new AppError("BID_INVALID_AMOUNT", "Send { maxMinor: <positive whole paise> }");
  const id = parseId(c);

  if (c.env.BID_RATE_LIMIT) {
    const { success } = await c.env.BID_RATE_LIMIT.limit({ key: `bid:${user.id}` });
    if (!success) {
      return problemResponse(
        problemBody("RATE_LIMITED", c.get("requestId"), "You're bidding very fast."),
        { "retry-after": "10" },
      );
    }
  }

  const elig = await eligibility(c.env, user.id);
  if (!elig.canBid)
    throw new AppError("FORBIDDEN", elig.blockedReason ?? "You can't bid right now.");
  if (elig.buyingLimitMinor !== null && body.data.maxMinor > elig.buyingLimitMinor) {
    throw new AppError(
      "FORBIDDEN",
      `Your buying limit is ₹${(elig.buyingLimitMinor / 100).toLocaleString("en-IN")} (10× your deposit). Add to your deposit to bid higher.`,
      { buyingLimitMinor: elig.buyingLimitMinor },
    );
  }
  const r = await auctionStub(c.env, id).setMaxBid({
    userId: user.id,
    maxMinor: body.data.maxMinor,
    idempotencyKey: key.data,
    requestId: c.get("requestId"),
  });
  switch (r.kind) {
    case "not_found":
      throw new AppError("NOT_FOUND", "Auction not found");
    case "account_closed":
      throw new AppError("FORBIDDEN", "This account has been closed.");
    case "conflict":
      throw new AppError(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used for a different request",
      );
    case "rate_limited":
      return problemResponse(
        problemBody("RATE_LIMITED", c.get("requestId"), "You're bidding very fast."),
        { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) },
      );
    case "evaluated":
      return maxBidResponse(c, r.result, r.replayed);
  }
});

function maxBidResponse(
  c: Context<AppEnv>,
  result: StoredMaxBidResult,
  replayed: boolean,
): Response {
  const headers = { "Idempotent-Replayed": String(replayed), "Cache-Control": "no-store" };
  if (result.ok) {
    const { ok: _ok, ...body } = result;
    return c.json(body, 200, headers);
  }
  const { ok: _ok, code, ...extensions } = result;
  return problemResponse(
    problemBody(code, c.get("requestId"), MAX_BID_DETAIL[code], extensions),
    headers,
  );
}

/**
 * Live event stream. Browsers do not apply CORS to WebSockets, so Origin is checked explicitly
 * (cross-site WebSocket hijacking). The user id forwarded to the DO comes from the session only.
 */
auctionRoutes.get("/:id/stream", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new AppError("VALIDATION_FAILED", "Expected a WebSocket upgrade");
  }
  if (!isOriginAllowed(c.req.header("origin"), c.req.url, c.env)) {
    throw new AppError("FORBIDDEN", "Origin not allowed");
  }
  const id = parseId(c);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-user-id");
  const user = c.get("user");
  if (user) headers.set("x-user-id", user.id);
  const upstream = await auctionStub(c.env, id).fetch(new Request(c.req.raw, { headers }));
  if (upstream.status === 404) throw new AppError("NOT_FOUND", "Auction not found");
  // A 101 returned through a DO stub has immutable headers; re-wrap so middleware can annotate it.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: new Headers(upstream.headers),
    webSocket: upstream.webSocket,
  });
});
