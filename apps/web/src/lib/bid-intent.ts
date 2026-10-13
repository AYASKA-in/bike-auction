import { formatINR } from "./format";
import { ApiError } from "./api";

/**
 * Client-side bid safety. The server stays authoritative (amount rules, throttling, auth); this only
 * catches obvious mistakes early and makes retries safe.
 */
export type BidCheck =
  { ok: true; amountMinor: number; needsConfirm: boolean } | { ok: false; message: string };

/** Above this multiple of the minimum next bid we ask "are you sure?" (server rejects > 3×). */
export const CONFIRM_MULTIPLE = 1.5;

export function checkBid(rupees: string, minNextBidMinor: number): BidCheck {
  const t = rupees.trim();
  if (!/^\d{1,9}$/.test(t)) return { ok: false, message: "Enter the amount in whole rupees." };
  const amountMinor = Number(t) * 100;
  if (amountMinor < minNextBidMinor)
    return { ok: false, message: `The minimum bid is ${formatINR(minNextBidMinor)}.` };
  return { ok: true, amountMinor, needsConfirm: amountMinor >= minNextBidMinor * CONFIRM_MULTIPLE };
}

/**
 * One idempotency key per intended bid. A retry of the SAME amount after an uncertain failure
 * (network error, timeout, 5xx) reuses the key, so the server returns the original result instead
 * of placing a second bid. A definitive answer (accepted or rejected) or a different amount starts
 * a new intent.
 */
export class BidIntent {
  private key: string | null = null;
  private amount: number | null = null;
  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

  keyFor(amountMinor: number): string {
    if (this.key === null || this.amount !== amountMinor) {
      this.key = this.newKey();
      this.amount = amountMinor;
    }
    return this.key;
  }

  /** Call with the request outcome. Only uncertain failures keep the key. */
  settle(error: unknown | null): void {
    if (error !== null && isUncertain(error)) return;
    this.key = null;
    this.amount = null;
  }

  get pendingRetryAmount(): number | null {
    return this.key === null ? null : this.amount;
  }
}

/** We don't know whether the server applied the bid: retrying with the same key is the safe move. */
export function isUncertain(e: unknown): boolean {
  return !(e instanceof ApiError) || e.code === "NETWORK" || e.status >= 500;
}

export function bidErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Your bid may not have been placed.";
  if (isUncertain(e))
    return "We couldn't confirm your bid. Press Retry: it resends the same bid and can't place it twice.";
  const map: Partial<Record<string, string>> = {
    AUTH_REQUIRED: "Your session has expired. Sign in again to bid.",
    FORBIDDEN: "This account can't bid.",
    BID_TOO_LOW: "Someone bid first. The minimum has gone up.",
    ALREADY_LEADING: "You already have the highest bid.",
    BID_UNREASONABLE: "That's far above the current price. Check the amount.",
    BID_INVALID_AMOUNT: "Enter a valid amount in whole rupees.",
    AUCTION_ENDED: "This auction has ended.",
    AUCTION_NOT_LIVE: "This auction hasn't started yet.",
    AUCTION_CANCELLED: "This auction was cancelled.",
    RATE_LIMITED: "You're bidding very fast. Wait a moment and try again.",
    IDEMPOTENCY_KEY_REUSED: "Please submit the bid again.",
    NOT_FOUND: "This auction no longer exists.",
  };
  return map[e.code] ?? e.detail ?? "Your bid wasn't placed.";
}
