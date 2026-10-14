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
  viewer: z
    .strictObject({
      isLeading: z.boolean(),
      isWinner: z.boolean(),
      /**
       * Day 7: the signed-in viewer's OWN hidden maximum (null = none). Personal: only ever present
       * in views built for that viewer. Optional for clients that build views locally; the server
       * always sends it.
       */
      myMaxMinor: Paise.nullable().optional(),
    })
    .nullable(),
});
export type PublicAuctionView = z.infer<typeof PublicAuctionView>;

/** MANUAL = placed by the bidder; PROXY = placed automatically from the bidder's hidden maximum. */
export const BidKind = z.enum(["MANUAL", "PROXY"]);
export type BidKind = z.infer<typeof BidKind>;

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
    /** Day 7 (additive): always sent by the server; optional so older fixtures still parse. */
    kind: BidKind.optional(),
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

/** One accepted bid as buyers see it (pseudonymous; `isYou` only for the signed-in viewer). */
export const PublicBid = z.strictObject({
  seq: z.number().int().positive(),
  bidId: z.string(),
  bidder: Pseudonym,
  amountMinor: Paise,
  /** Day 7 (additive): always sent by the server. */
  kind: BidKind.optional(),
  at: Ms,
  isYou: z.boolean(),
});
export type PublicBid = z.infer<typeof PublicBid>;

/** GET /auctions/:id/bids — newest first; pass `nextBeforeSeq` as `beforeSeq` for older bids. */
export const BidHistoryPage = z.strictObject({
  items: z.array(PublicBid),
  nextBeforeSeq: z.number().int().positive().nullable(),
});
export type BidHistoryPage = z.infer<typeof BidHistoryPage>;

/** 201 body of POST /auctions/:id/bids. */
export const PlaceBidResult = z.strictObject({
  bidId: z.string(),
  seq: z.number().int().positive(),
  amountMinor: Paise,
  closesAt: Ms,
  minNextBidMinor: Paise,
});
export type PlaceBidResult = z.infer<typeof PlaceBidResult>;

/**
 * PUT /auctions/:id/max-bid body (Day 7). The maximum stays hidden from everyone but its owner.
 * Like bids, userId and time are never accepted from the client.
 */
export const SetMaxBidBody = z.strictObject({ maxMinor: z.number().int().positive() });
export type SetMaxBidBody = z.infer<typeof SetMaxBidBody>;

/** 200 body of PUT /auctions/:id/max-bid (returned only to the owner of the maximum). */
export const SetMaxBidResult = z.strictObject({
  maxMinor: Paise,
  isLeading: z.boolean(),
  currentPriceMinor: Paise,
  minNextBidMinor: Paise,
  seq: z.number().int().positive(),
});
export type SetMaxBidResult = z.infer<typeof SetMaxBidResult>;
