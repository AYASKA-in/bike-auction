import type { Paise } from "../money";

/** Stable machine-readable rejection reasons. Clients branch on `code`, never on `message`. */
export type DomainErrorCode =
  | "VALIDATION_FAILED"
  | "INVALID_TRANSITION"
  | "AUCTION_NOT_LIVE"
  | "AUCTION_ENDED"
  | "AUCTION_CANCELLED"
  | "BID_INVALID_AMOUNT"
  | "BID_TOO_LOW"
  | "BID_UNREASONABLE"
  | "ALREADY_LEADING";

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly minNextBidMinor?: Paise;
  readonly maxAcceptableMinor?: Paise;
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  extra: Pick<DomainError, "minNextBidMinor" | "maxAcceptableMinor"> = {},
): DomainError {
  return { code, message, ...extra };
}

/**
 * Thrown only for programming errors (e.g. a non-integer timestamp from the trusted server).
 * Business rejections are returned as values, never thrown.
 */
export class DomainInvariantError extends Error {
  override readonly name = "DomainInvariantError";
}
