import type { Paise } from "../money";
import { isReserveMet, minNextBidFor } from "./engine";
import type { AuctionEvent } from "./events";
import type { AuctionOutcome, AuctionState, AuctionStatus } from "./types";

/**
 * Buyer-facing representations. Built field by field (an allow-list), never by spreading internal
 * state, so private fields (reserve amount, user ids, rules) cannot leak by accident (invariant I).
 */
export interface PublicAuctionView {
  readonly auctionId: string;
  readonly status: AuctionStatus;
  readonly outcome: AuctionOutcome | null;
  readonly startsAt: number;
  readonly closesAt: number;
  readonly startPriceMinor: Paise;
  readonly currentPriceMinor: Paise | null;
  readonly minNextBidMinor: Paise | null;
  readonly bidCount: number;
  readonly hasReserve: boolean;
  readonly reserveMet: boolean;
  readonly leadingBidder: string | null;
  readonly extensionCount: number;
  readonly seq: number;
  readonly viewer: { readonly isLeading: boolean; readonly isWinner: boolean } | null;
}

export function toPublicView(
  state: AuctionState,
  opts: { readonly leaderPseudonym: string | null; readonly viewerUserId: string | null },
): PublicAuctionView {
  const leading = opts.viewerUserId !== null && state.leaderUserId === opts.viewerUserId;
  return {
    auctionId: state.auctionId,
    status: state.status,
    outcome: state.outcome,
    startsAt: state.startsAt,
    closesAt: state.closesAt,
    startPriceMinor: state.startPriceMinor,
    currentPriceMinor: state.currentPriceMinor,
    minNextBidMinor:
      state.status === "ENDED" || state.status === "CANCELLED" ? null : minNextBidFor(state),
    bidCount: state.bidCount,
    hasReserve: state.reserveMinor !== null,
    reserveMet: isReserveMet(state),
    leadingBidder: state.leaderUserId === null ? null : opts.leaderPseudonym,
    extensionCount: state.extensionCount,
    seq: state.seq,
    viewer:
      opts.viewerUserId === null
        ? null
        : {
            isLeading: leading && state.status === "LIVE",
            isWinner: state.winnerUserId === opts.viewerUserId,
          },
  };
}

export type PublicAuctionEvent =
  | {
      readonly type: "auction.scheduled";
      readonly seq: number;
      readonly startsAt: number;
      readonly closesAt: number;
    }
  | { readonly type: "auction.started"; readonly seq: number; readonly startedAt: number }
  | {
      readonly type: "bid.accepted";
      readonly seq: number;
      readonly bidId: string;
      readonly bidder: string;
      readonly amountMinor: Paise;
      readonly at: number;
      readonly closesAt: number;
      readonly minNextBidMinor: Paise;
      readonly reserveMet: boolean;
    }
  | {
      readonly type: "auction.extended";
      readonly seq: number;
      readonly previousClosesAt: number;
      readonly closesAt: number;
    }
  | { readonly type: "auction.cancelled"; readonly seq: number; readonly reason: string }
  | {
      readonly type: "auction.ended";
      readonly seq: number;
      readonly outcome: AuctionOutcome;
      readonly finalPriceMinor: Paise | null;
      readonly winningBidder: string | null;
      readonly endedAt: number;
    };

/**
 * Maps an internal event to its public form, or null for admin-only events (created/updated carry
 * the reserve and draft details). `pseudonymOf` resolves user ids to per-auction pseudonyms.
 */
export function toPublicEvent(
  event: AuctionEvent,
  pseudonymOf: (userId: string) => string,
): PublicAuctionEvent | null {
  switch (event.type) {
    case "auction.created":
    case "auction.updated":
      return null;
    case "auction.scheduled":
      return {
        type: event.type,
        seq: event.seq,
        startsAt: event.startsAt,
        closesAt: event.closesAt,
      };
    case "auction.started":
      return { type: event.type, seq: event.seq, startedAt: event.startedAt };
    case "bid.accepted":
      return {
        type: event.type,
        seq: event.seq,
        bidId: event.bidId,
        bidder: pseudonymOf(event.userId),
        amountMinor: event.amountMinor,
        at: event.at,
        closesAt: event.closesAt,
        minNextBidMinor: event.minNextBidMinor,
        reserveMet: event.reserveMet,
      };
    case "auction.extended":
      return {
        type: event.type,
        seq: event.seq,
        previousClosesAt: event.previousClosesAt,
        closesAt: event.closesAt,
      };
    case "auction.cancelled":
      return { type: event.type, seq: event.seq, reason: event.reason };
    case "auction.ended":
      return {
        type: event.type,
        seq: event.seq,
        outcome: event.outcome,
        finalPriceMinor: event.finalPriceMinor,
        winningBidder: event.winnerUserId === null ? null : pseudonymOf(event.winnerUserId),
        endedAt: event.endedAt,
      };
  }
}
