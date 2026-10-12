import { DEFAULT_LADDER, validateLadder } from "../ladder";
import { isValidAmount, MAX_AMOUNT_MINOR, type Paise } from "../money";
import { domainError, type DomainError } from "./errors";
import type { AuctionRules, BidLimits, SoftCloseRules } from "./types";

export const MINUTE_MS = 60_000;

/** BLUEPRINT §4.5: 2-minute window, 2-minute extension, at most 30 minutes in total. */
export const DEFAULT_SOFT_CLOSE: SoftCloseRules = {
  windowMs: 2 * MINUTE_MS,
  extensionMs: 2 * MINUTE_MS,
  maxTotalExtensionMs: 30 * MINUTE_MS,
};

/** BLUEPRINT §4.3: reject bids above 3× the reference price. */
export const DEFAULT_LIMITS: BidLimits = { maxMultiplier: 3, maxAmountMinor: MAX_AMOUNT_MINOR };

export const DEFAULT_RULES: AuctionRules = {
  ladder: DEFAULT_LADDER,
  softClose: DEFAULT_SOFT_CLOSE,
  limits: DEFAULT_LIMITS,
};

export const MIN_AUCTION_DURATION_MS = MINUTE_MS;
export const MAX_AUCTION_DURATION_MS = 30 * 24 * 60 * MINUTE_MS;

export const AUCTION_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export interface AuctionTerms {
  readonly startPriceMinor: Paise;
  readonly reserveMinor: Paise | null;
  readonly startsAt: number;
  readonly closesAt: number;
  readonly rules: AuctionRules;
}

export function isTimestamp(t: unknown): t is number {
  return typeof t === "number" && Number.isSafeInteger(t) && t >= 0;
}

/** hardCloseAt is derived, never supplied: the original close plus the maximum total extension. */
export function hardCloseFor(closesAt: number, rules: AuctionRules): number {
  return closesAt + (rules.softClose?.maxTotalExtensionMs ?? 0);
}

function validateRules(rules: AuctionRules): DomainError | null {
  try {
    validateLadder(rules.ladder);
  } catch (err) {
    return domainError("VALIDATION_FAILED", `Invalid increment ladder: ${(err as Error).message}`);
  }
  const { limits, softClose } = rules;
  if (!Number.isSafeInteger(limits.maxMultiplier) || limits.maxMultiplier < 1) {
    return domainError("VALIDATION_FAILED", "maxMultiplier must be an integer ≥ 1");
  }
  if (!isValidAmount(limits.maxAmountMinor)) {
    return domainError(
      "VALIDATION_FAILED",
      `maxAmountMinor must be a positive amount ≤ ${MAX_AMOUNT_MINOR}`,
    );
  }
  if (softClose) {
    const { windowMs, extensionMs, maxTotalExtensionMs } = softClose;
    if (
      ![windowMs, extensionMs, maxTotalExtensionMs].every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
      return domainError("VALIDATION_FAILED", "Soft-close durations must be non-negative integers");
    }
    if (windowMs === 0 || extensionMs === 0) {
      return domainError(
        "VALIDATION_FAILED",
        "Soft-close window and extension must be positive (or disable soft close)",
      );
    }
    if (maxTotalExtensionMs > 24 * 60 * MINUTE_MS) {
      return domainError("VALIDATION_FAILED", "Total soft-close extension is capped at 24 hours");
    }
  }
  return null;
}

/** Validates everything an admin can configure. Returns null when valid. */
export function validateTerms(t: AuctionTerms): DomainError | null {
  const ruleError = validateRules(t.rules);
  if (ruleError) return ruleError;
  const max = t.rules.limits.maxAmountMinor;
  if (!isValidAmount(t.startPriceMinor, max)) {
    return domainError(
      "VALIDATION_FAILED",
      "Start price must be a positive whole number of paise within limits",
    );
  }
  if (t.reserveMinor !== null) {
    if (!isValidAmount(t.reserveMinor, max)) {
      return domainError(
        "VALIDATION_FAILED",
        "Reserve must be a positive whole number of paise within limits",
      );
    }
    if (t.reserveMinor < t.startPriceMinor) {
      return domainError("VALIDATION_FAILED", "Reserve cannot be below the start price");
    }
  }
  if (!isTimestamp(t.startsAt) || !isTimestamp(t.closesAt)) {
    return domainError("VALIDATION_FAILED", "Times must be integer epoch milliseconds");
  }
  const duration = t.closesAt - t.startsAt;
  if (duration < MIN_AUCTION_DURATION_MS) {
    return domainError("VALIDATION_FAILED", "Auction must run for at least one minute");
  }
  if (duration > MAX_AUCTION_DURATION_MS) {
    return domainError("VALIDATION_FAILED", "Auction cannot run longer than 30 days");
  }
  if (!Number.isSafeInteger(hardCloseFor(t.closesAt, t.rules))) {
    return domainError("VALIDATION_FAILED", "Close time out of range");
  }
  return null;
}
