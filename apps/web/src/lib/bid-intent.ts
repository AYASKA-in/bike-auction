import { DEFAULT_LADDER, incrementFor, type IncrementLadder } from "@bike/domain";
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

/** A positive whole-paise amount from an untrusted problem extension member, else null. */
function paiseExtension(e: unknown, key: "minNextBidMinor" | "maxAcceptableMinor"): number | null {
  if (!(e instanceof ApiError)) return null;
  const v = e.extensions?.[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** The server's current minimum carried by a BID_TOO_LOW rejection (used to refill the input). */
export function minFromError(e: unknown): number | null {
  return e instanceof ApiError && e.code === "BID_TOO_LOW"
    ? paiseExtension(e, "minNextBidMinor")
    : null;
}

/** Human copy per error code (BLUEPRINT §11.5); raw server messages are never shown. */
export function bidErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Your bid may not have been placed.";
  if (isUncertain(e))
    return "We couldn't confirm your bid. Press Retry: it resends the same bid and can't place it twice.";
  if (e.code === "BID_TOO_LOW") {
    const min = minFromError(e);
    return min !== null
      ? `Someone just bid. Minimum is now ${formatINR(min)}.`
      : "Someone just bid. The minimum has gone up.";
  }
  if (e.code === "BID_UNREASONABLE") {
    const max = paiseExtension(e, "maxAcceptableMinor");
    return max !== null
      ? `That's far above the current price. The most you can bid right now is ${formatINR(max)}.`
      : "That's far above the current price. Check the amount.";
  }
  const map: Partial<Record<string, string>> = {
    AUTH_REQUIRED: "Your session has expired. Sign in again to bid.",
    // The server's reason is written for the buyer (pay first, buying limit, account paused).
    FORBIDDEN: e.detail ?? "This account can't bid.",
    ALREADY_LEADING: "You already have the highest bid.",
    BID_INVALID_AMOUNT: "Enter a valid amount in whole rupees.",
    AUCTION_ENDED: "This auction has ended.",
    AUCTION_NOT_LIVE: "This auction hasn't started yet.",
    AUCTION_CANCELLED: "This auction was cancelled.",
    RATE_LIMITED: "You're bidding very fast. Try again in a few seconds.",
    IDEMPOTENCY_KEY_REUSED: "Please submit the bid again.",
    NOT_FOUND: "This auction no longer exists.",
  };
  return map[e.code] ?? "Your bid wasn't placed.";
}

/** Quick-bid chips: +1, +2 and +5 ladder increments (BLUEPRINT §11.3). */
export const QUICK_STEPS = [1, 2, 5] as const;
export type QuickChip = { steps: number; amountMinor: number };

/**
 * Chip k is the bid k increments above the current price, i.e. the minimum next bid plus (k−1)
 * further increments, each taken at the price it starts from, so a chip that crosses a ladder band
 * (e.g. ₹24,750 → ₹25,000 → ₹25,500) uses the larger increment from the boundary on. The server's
 * ladder is not part of the public view; every auction currently uses DEFAULT_LADDER.
 */
export function quickBidChips(
  minNextBidMinor: number,
  ladder: IncrementLadder = DEFAULT_LADDER,
  steps: readonly number[] = QUICK_STEPS,
): QuickChip[] {
  return steps.map((k) => {
    let amountMinor = minNextBidMinor;
    for (let i = 1; i < k; i++) amountMinor += incrementFor(amountMinor, ladder);
    return { steps: k, amountMinor };
  });
}

/**
 * When the minimum rises (a new bid arrived or a rejection told us), keep what the bidder typed if
 * it's still a valid bid; otherwise prefill the new minimum.
 */
export function nextBidInput(rupees: string, minNextBidMinor: number): string {
  const t = rupees.trim();
  if (/^\d{1,9}$/.test(t) && Number(t) * 100 >= minNextBidMinor) return t;
  return String(minNextBidMinor / 100);
}
