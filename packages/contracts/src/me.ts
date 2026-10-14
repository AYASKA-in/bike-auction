import { z } from "zod";
import { AuctionOutcome, AuctionStatus } from "./auction";
import { AuctionCard } from "./catalogue";

/**
 * Buyer self-service ("My bids", "Watchlist"). Served from D1 read models only. Every object is
 * STRICT: a reserve amount, another user's id or a pseudonym in a response fails parsing.
 */

/** leading/outbid = live auctions you bid on; won/lost = finished ones (lost includes cancelled). */
export const MyBidsTab = z.enum(["leading", "outbid", "won", "lost"]);
export type MyBidsTab = z.infer<typeof MyBidsTab>;

export const MyBidCard = z.strictObject({
  auctionId: z.string(),
  title: z.string(),
  coverUrl: z.string().nullable(),
  /** Effective status (a due start/close is applied from the schedule, like the catalogue). */
  status: AuctionStatus,
  outcome: AuctionOutcome.nullable(),
  currentPriceMinor: z.number().int().nullable(),
  myHighestMinor: z.number().int().positive(),
  bidCount: z.number().int().nonnegative(),
  closesAt: z.number().int(),
  startsAt: z.number().int(),
  /** Live and your bid is the latest accepted bid. Always false once the auction is over. */
  isLeading: z.boolean(),
});
export type MyBidCard = z.infer<typeof MyBidCard>;

export const MyBidsPage = z.strictObject({
  tab: MyBidsTab,
  items: z.array(MyBidCard),
  nextCursor: z.string().nullable(),
});
export type MyBidsPage = z.infer<typeof MyBidsPage>;

/** Max auctions one buyer can watch (PUT beyond this is 409 CONFLICT). */
export const WATCHLIST_MAX = 100;

export const WatchlistItem = z.strictObject({
  ...AuctionCard.shape,
  watchedAt: z.number().int(),
});
export type WatchlistItem = z.infer<typeof WatchlistItem>;

/** The whole list (bounded by WATCHLIST_MAX, so no pagination), newest first. */
export const Watchlist = z.strictObject({
  items: z.array(WatchlistItem),
});
export type Watchlist = z.infer<typeof Watchlist>;

export const WatchlistIds = z.strictObject({
  ids: z.array(z.string()),
  max: z.number().int().positive(),
});
export type WatchlistIds = z.infer<typeof WatchlistIds>;
