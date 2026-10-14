import type { PublicAuctionView } from "@bike/contracts";
import { ApiError } from "./api";
import { CONFIRM_MULTIPLE, isUncertain } from "./bid-intent";
import { formatINR } from "./format";

/**
 * Client-side checks for a hidden maximum (proxy bid). The server stays authoritative; these
 * mirror its rules (ADR 004 › Proxy bidding) so mistakes are caught before a request:
 *   - at least the minimum next bid;
 *   - at most max(minimum, 3 × reference price) — the same fat-finger guard as bids;
 *   - a large maximum asks for confirmation, like a large bid.
 */
export type MaxBidCheck =
  { ok: true; maxMinor: number; needsConfirm: boolean } | { ok: false; message: string };

/** Largest maximum the server will accept right now (mirrors maxAcceptableBid in the engine). */
export function maxAcceptableMax(view: PublicAuctionView): number {
  const min = view.minNextBidMinor ?? view.startPriceMinor;
  const reference = view.currentPriceMinor ?? view.startPriceMinor;
  return Math.max(min, reference * 3);
}

export function checkMaxBid(rupees: string, view: PublicAuctionView): MaxBidCheck {
  const t = rupees.trim();
  if (!/^\d{1,9}$/.test(t)) return { ok: false, message: "Enter the amount in whole rupees." };
  const maxMinor = Number(t) * 100;
  const min = view.minNextBidMinor ?? view.startPriceMinor;
  if (maxMinor < min)
    return { ok: false, message: `Your maximum must be at least ${formatINR(min)}.` };
  const ceiling = maxAcceptableMax(view);
  if (maxMinor > ceiling)
    return {
      ok: false,
      message: `For now a maximum can be at most ${formatINR(ceiling)} (3× the current price). You can raise it later.`,
    };
  return { ok: true, maxMinor, needsConfirm: maxMinor >= min * CONFIRM_MULTIPLE };
}

/** Where the viewer's own maximum stands, for the status line. */
export type MaxStatus = "none" | "leading" | "active" | "passed";

export function maxStatus(view: PublicAuctionView): MaxStatus {
  const mine = view.viewer?.myMaxMinor ?? null;
  if (mine === null) return "none";
  if (view.viewer?.isLeading === true) return "leading";
  const min = view.minNextBidMinor ?? view.startPriceMinor;
  return mine >= min ? "active" : "passed";
}

export function maxBidErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError))
    return "Something went wrong. Your maximum may not have been saved.";
  if (isUncertain(e))
    return "We couldn't confirm your maximum. Press Retry: it resends the same request and can't apply it twice.";
  const map: Partial<Record<string, string>> = {
    AUTH_REQUIRED: "Your session has expired. Sign in again to set a maximum.",
    FORBIDDEN: "This account can't bid.",
    BID_TOO_LOW: "The price has moved. Your maximum must be at least the new minimum bid.",
    BID_UNREASONABLE: "That's far above the current price. Check the amount.",
    BID_INVALID_AMOUNT: "Enter a valid amount in whole rupees.",
    AUCTION_ENDED: "This auction has ended.",
    AUCTION_NOT_LIVE: "This auction hasn't started yet.",
    AUCTION_CANCELLED: "This auction was cancelled.",
    RATE_LIMITED: "You're going very fast. Wait a moment and try again.",
    IDEMPOTENCY_KEY_REUSED: "Please submit your maximum again.",
    NOT_FOUND: "This auction no longer exists.",
  };
  return map[e.code] ?? e.detail ?? "Your maximum wasn't saved.";
}
