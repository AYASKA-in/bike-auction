import type { Paise } from "../money";
import type { AuctionOutcome, AuctionStatus, BidKind } from "./types";

/**
 * Internal domain events. Each has a `seq` that is exactly previous seq + 1 within one auction,
 * assigned in the order the engine emits them. `at` is the authoritative server time of the command
 * (or tick) that produced it. Events may contain private data (user ids, reserve); map them with
 * toPublicEvent() before sending to clients.
 */
interface Base {
  readonly seq: number;
  readonly at: number;
}

export type AuctionEvent =
  | (Base & {
      readonly type: "auction.created";
      readonly startPriceMinor: Paise;
      readonly reserveMinor: Paise | null;
      readonly startsAt: number;
      readonly closesAt: number;
    })
  | (Base & { readonly type: "auction.updated"; readonly fields: readonly string[] })
  | (Base & {
      readonly type: "auction.scheduled";
      readonly startsAt: number;
      readonly closesAt: number;
      readonly hardCloseAt: number;
    })
  | (Base & { readonly type: "auction.started"; readonly startedAt: number })
  | (Base & {
      readonly type: "bid.accepted";
      readonly bidId: string;
      readonly userId: string;
      readonly amountMinor: Paise;
      /** MANUAL = placed by the bidder; PROXY = placed automatically from their hidden maximum. */
      readonly kind: BidKind;
      readonly previousPriceMinor: Paise | null;
      readonly minNextBidMinor: Paise;
      readonly reserveMet: boolean;
      readonly closesAt: number;
    })
  | (Base & {
      readonly type: "auction.extended";
      readonly previousClosesAt: number;
      readonly closesAt: number;
      readonly extensionCount: number;
    })
  | (Base & {
      readonly type: "auction.cancelled";
      readonly reason: string;
      readonly previousStatus: AuctionStatus;
    })
  | (Base & {
      readonly type: "auction.ended";
      readonly outcome: AuctionOutcome;
      readonly winnerUserId: string | null;
      readonly finalPriceMinor: Paise | null;
      readonly endedAt: number;
    });

export type AuctionEventType = AuctionEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventDraft = DistributiveOmit<AuctionEvent, "seq">;
