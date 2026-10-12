import { z } from "zod";
import { PublicAuctionEvent, PublicAuctionView } from "./auction";

/**
 * Server → client WebSocket protocol (v1). Commands travel over HTTP; this channel is an event feed.
 *
 * Ordering: every auction event carries `seq` (contiguous per auction, but admin-only events such
 * as draft edits are not broadcast). A client applies an event only if seq === lastSeq + 1; a
 * duplicate/older seq is ignored; a gap means "send {"type":"resync"} or reconnect" and the server
 * answers with a fresh `auction.snapshot`. See apps/web/src/lib/live-auction.ts.
 *
 * Day-4 change: `auction.snapshot` now carries the buyer-safe `view` (PublicAuctionView) instead of
 * the Day-1 internal snapshot fields (which exposed a raw user id; fixed on Day 3).
 */
export const WS_PROTOCOL_VERSION = 1 as const;

const V = { protocolVersion: z.literal(WS_PROTOCOL_VERSION) };

export const WsHello = z.strictObject({
  ...V,
  type: z.literal("hello"),
  serverTime: z.number().int(),
});

export const WsSnapshot = z.strictObject({
  ...V,
  type: z.literal("auction.snapshot"),
  serverTime: z.number().int(),
  view: PublicAuctionView,
});

/** Sent only to the previous leader's sockets. */
export const WsOutbid = z.strictObject({
  ...V,
  type: z.literal("you.outbid"),
  seq: z.number().int().positive(),
  currentPriceMinor: z.number().int().positive(),
  minNextBidMinor: z.number().int().positive(),
});

const versioned = PublicAuctionEvent.options.map((o) => o.extend(V));
export const WsAuctionEvent = z.discriminatedUnion("type", [
  versioned[0]!,
  versioned[1]!,
  versioned[2]!,
  versioned[3]!,
  versioned[4]!,
  versioned[5]!,
]);
export type WsAuctionEvent = z.infer<typeof WsAuctionEvent>;

export const WsServerMessage = z.union([WsHello, WsSnapshot, WsOutbid, WsAuctionEvent]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

/** Heartbeats answered by the Durable Object auto-response without waking it. */
export const WS_PING = '{"type":"ping"}';
export const WS_PONG = '{"type":"pong"}';
/** The only other client → server message: request a fresh snapshot after a seq gap. */
export const WS_RESYNC = '{"type":"resync"}';
