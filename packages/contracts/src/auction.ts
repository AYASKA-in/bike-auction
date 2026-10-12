import { z } from "zod";

/**
 * Public (buyer-facing) auction contracts. All objects are STRICT: an unexpected key (e.g. a
 * reserve amount or a raw user id) makes parsing fail, so a leak is a test failure, not a silent bug.
 */
export const AuctionStatus = z.enum(["DRAFT", "SCHEDULED", "LIVE", "ENDED", "CANCELLED"]);
export const AuctionOutcome = z.enum(["SOLD", "RESERVE_NOT_MET", "NO_BIDS"]);
const Paise = z.number().int().positive();
const Ms = z.number().int().nonnegative();
const Pseudonym = z.string().regex(/^Bidder [0-9A-HJKMNP-TV-Z]{4,16}$/);

export const PublicAuctionView = z.strictObject({
  auctionId: z.string(),
  status: AuctionStatus,
  outcome: AuctionOutcome.nullable(),
  startsAt: Ms,
  closesAt: Ms,
  startPriceMinor: Paise,
  currentPriceMinor: Paise.nullable(),
  minNextBidMinor: Paise.nullable(),
  bidCount: z.number().int().nonnegative(),
  hasReserve: z.boolean(),
  reserveMet: z.boolean(),
  leadingBidder: Pseudonym.nullable(),
  extensionCount: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  viewer: z.strictObject({ isLeading: z.boolean(), isWinner: z.boolean() }).nullable(),
});
export type PublicAuctionView = z.infer<typeof PublicAuctionView>;

export const PublicAuctionEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("auction.scheduled"),
    seq: z.number().int(),
    startsAt: Ms,
    closesAt: Ms,
  }),
  z.strictObject({ type: z.literal("auction.started"), seq: z.number().int(), startedAt: Ms }),
  z.strictObject({
    type: z.literal("bid.accepted"),
    seq: z.number().int(),
    bidId: z.string(),
    bidder: Pseudonym,
    amountMinor: Paise,
    at: Ms,
    closesAt: Ms,
    minNextBidMinor: Paise,
    reserveMet: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("auction.extended"),
    seq: z.number().int(),
    previousClosesAt: Ms,
    closesAt: Ms,
  }),
  z.strictObject({
    type: z.literal("auction.cancelled"),
    seq: z.number().int(),
    reason: z.string(),
  }),
  z.strictObject({
    type: z.literal("auction.ended"),
    seq: z.number().int(),
    outcome: AuctionOutcome,
    finalPriceMinor: Paise.nullable(),
    winningBidder: Pseudonym.nullable(),
    endedAt: Ms,
  }),
]);
export type PublicAuctionEvent = z.infer<typeof PublicAuctionEvent>;

/** Bid command body. userId and time are NEVER accepted from the client. */
export const PlaceBidBody = z.strictObject({ amountMinor: z.number().int().positive() });
export const IdempotencyKeyHeader = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
