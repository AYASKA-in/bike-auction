import type { IncrementLadder } from "../ladder";
import type { Paise } from "../money";

export type AuctionStatus = "DRAFT" | "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";
export type AuctionOutcome = "SOLD" | "RESERVE_NOT_MET" | "NO_BIDS";

/**
 * Soft close (anti-sniping). A bid accepted while `closesAt - now < windowMs` moves the close to
 * `min(now + extensionMs, hardCloseAt)`. `hardCloseAt = originalClosesAt + maxTotalExtensionMs` is
 * fixed when the schedule is fixed, so every auction terminates.
 */
export interface SoftCloseRules {
  readonly windowMs: number;
  readonly extensionMs: number;
  readonly maxTotalExtensionMs: number;
}

/** Server-side fat-finger protection. */
export interface BidLimits {
  /** A bid may not exceed max(minNextBid, reference × maxMultiplier), reference = current ?? start. */
  readonly maxMultiplier: number;
  /** Absolute per-auction ceiling (≤ MAX_AMOUNT_MINOR). */
  readonly maxAmountMinor: Paise;
}

export interface AuctionRules {
  readonly ladder: IncrementLadder;
  readonly softClose: SoftCloseRules | null;
  readonly limits: BidLimits;
}

/** How an accepted bid was placed: by the bidder directly, or automatically by their maximum. */
export type BidKind = "MANUAL" | "PROXY";

/**
 * A bidder's hidden maximum (proxy bid, BLUEPRINT §4.7). PRIVATE: only its owner may ever see
 * `maxMinor`. At most one per user per auction; setting a new one replaces it.
 */
export interface ProxyBid {
  readonly userId: string;
  readonly maxMinor: Paise;
  /**
   * Priority for equal maxima (lower wins): the auction seq once the command that set this maximum
   * committed. Unique among competing maxima (see ADR 004 › Proxy bidding).
   */
  readonly setSeq: number;
  readonly updatedAt: number;
}

/**
 * Authoritative auction state. Immutable: every command returns a new object.
 * Contains private fields (reserve, user ids, proxy maxima); NEVER serialise it to clients. Use
 * toPublicView().
 */
export interface AuctionState {
  readonly auctionId: string;
  readonly status: AuctionStatus;
  readonly startPriceMinor: Paise;
  /** Hidden reserve. null = no reserve. */
  readonly reserveMinor: Paise | null;
  readonly rules: AuctionRules;
  readonly startsAt: number;
  /** Close time as scheduled (before any soft-close extension). */
  readonly originalClosesAt: number;
  /** Effective close time (may be extended; always ≤ hardCloseAt). */
  readonly closesAt: number;
  readonly hardCloseAt: number;
  readonly currentPriceMinor: Paise | null;
  readonly leaderUserId: string | null;
  /** seq of the leading bid's bid.accepted event. */
  readonly leaderBidSeq: number | null;
  readonly bidCount: number;
  readonly extensionCount: number;
  /** seq of the last committed event. Each event increments it by exactly 1. */
  readonly seq: number;
  readonly outcome: AuctionOutcome | null;
  readonly winnerUserId: string | null;
  /** Authoritative end time (= closesAt at the moment of closing), not when it was observed. */
  readonly endedAt: number | null;
  readonly cancelledAt: number | null;
  readonly cancelReason: string | null;
  /** Hidden maxima, one per user (PRIVATE). Never part of any public view or event. */
  readonly proxies: readonly ProxyBid[];
}
