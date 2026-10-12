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
});

export const WsServerMessage = z.discriminatedUnion("type", [WsHello, WsBidAccepted]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

/** Heartbeat strings answered by the Durable Object auto-response without waking it. */
export const WS_PING = '{"type":"ping"}';
export const WS_PONG = '{"type":"pong"}';
