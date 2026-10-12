import { z } from "zod";

/**
 * Server -> client WebSocket protocol. Commands travel over HTTP; this channel is a read-only
 * event feed. Every message carries `protocolVersion` so clients can detect incompatibility.
 */
export const WS_PROTOCOL_VERSION = 1 as const;

const Base = z.object({ protocolVersion: z.literal(WS_PROTOCOL_VERSION) });

export const WsHello = Base.extend({ type: z.literal("hello"), serverTime: z.number().int() });

export const WsBidAccepted = Base.extend({
  type: z.literal("bid.accepted"),
  seq: z.number().int().positive(),
  bidId: z.string(),
  bidder: z.string(),
  amountMinor: z.number().int().positive(),
  at: z.number().int(),
  closesAt: z.number().int(),
  minNextBidMinor: z.number().int().positive(),
  /** Added Day 3 (optional, backwards compatible). */
  reserveMet: z.boolean().optional(),
});

/** Day 3: further lifecycle events. Additive; protocolVersion stays 1. */
export const WsAuctionExtended = Base.extend({
  type: z.literal("auction.extended"),
  seq: z.number().int().positive(),
  previousClosesAt: z.number().int(),
  closesAt: z.number().int(),
});
export const WsAuctionStarted = Base.extend({
  type: z.literal("auction.started"),
  seq: z.number().int().positive(),
  startedAt: z.number().int(),
});
export const WsAuctionCancelled = Base.extend({
  type: z.literal("auction.cancelled"),
  seq: z.number().int().positive(),
  reason: z.string(),
});
export const WsAuctionEnded = Base.extend({
  type: z.literal("auction.ended"),
  seq: z.number().int().positive(),
  outcome: z.enum(["SOLD", "RESERVE_NOT_MET", "NO_BIDS"]),
  finalPriceMinor: z.number().int().positive().nullable(),
  winningBidder: z.string().nullable(),
  endedAt: z.number().int(),
});

export const WsServerMessage = z.discriminatedUnion("type", [
  WsHello,
  WsBidAccepted,
  WsAuctionExtended,
  WsAuctionStarted,
  WsAuctionCancelled,
  WsAuctionEnded,
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

/** Heartbeat strings answered by the Durable Object auto-response without waking it. */
export const WS_PING = '{"type":"ping"}';
export const WS_PONG = '{"type":"pong"}';
