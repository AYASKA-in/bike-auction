import type { Paise } from "../money";
import type { DomainErrorCode } from "./errors";
import { minNextBidFor, type BidDecision, type MaxBidDecision } from "./engine";

/**
 * Idempotency for bid commands (BLUEPRINT §5). Pure decision logic only: the auction Durable
 * Object stores records in its own SQLite table in the SAME transaction as the bid (Day 4).
 * Nothing in this module is storage; an in-memory map is never durable.
 *
 * Semantics:
 *  - Records are scoped by (userId, key). Two users may use the same key independently.
 *  - Same key + same fingerprint within retention → the ORIGINAL stored result, no new effects.
 *  - Same key + different fingerprint → conflict (IDEMPOTENCY_KEY_REUSED), no effects. Bids and
 *    maximum-bid commands share the key space; their fingerprints differ by prefix, so reusing a
 *    bid's key for a maximum (or vice versa) is a conflict.
 *  - Both accepted and rejected outcomes are stored: every domain outcome is deterministic, so a
 *    retry must see what the first attempt saw, not a re-evaluation against newer state.
 *  - Transport/infrastructure failures (rate limit, 5xx before commit) are NOT stored.
 *  - Retention: at least 24 hours; expired records behave as absent.
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && IDEMPOTENCY_KEY_PATTERN.test(key);
}

const fingerprintValue = (v: unknown) => (typeof v === "number" ? String(v) : JSON.stringify(v));

/**
 * Identity of the *request payload*. Excludes server-assigned values (bidId, now) so a retry of the
 * same intent matches. Versioned so the format can evolve without colliding with old records.
 */
export function bidFingerprint(input: { auctionId: string; amountMinor: unknown }): string {
  return `bid:v1:${input.auctionId}:${fingerprintValue(input.amountMinor)}`;
}

/** Fingerprint of a set-maximum command: `max:v1:<auctionId>:<max>`. */
export function maxBidFingerprint(input: { auctionId: string; maxMinor: unknown }): string {
  return `max:v1:${input.auctionId}:${fingerprintValue(input.maxMinor)}`;
}

export type StoredRejection = {
  readonly ok: false;
  readonly code: DomainErrorCode;
  readonly minNextBidMinor?: Paise;
  readonly maxAcceptableMinor?: Paise;
};

export type StoredBidResult =
  | {
      readonly ok: true;
      readonly bidId: string;
      readonly seq: number;
      readonly amountMinor: Paise;
      readonly closesAt: number;
      /** Minimum next bid once the whole command committed (after any automatic responses). */
      readonly minNextBidMinor: Paise;
    }
  | StoredRejection;

/** Stored result of a set-maximum command. `maxMinor` is the owner's own value (owner-only). */
export type StoredMaxBidResult =
  | {
      readonly ok: true;
      readonly maxMinor: Paise;
      readonly isLeading: boolean;
      readonly currentPriceMinor: Paise;
      readonly minNextBidMinor: Paise;
      readonly seq: number;
    }
  | StoredRejection;

export interface IdempotencyRecord<R = StoredBidResult> {
  readonly userId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly result: R;
  readonly createdAt: number;
}

export type IdempotencyResolution<R = StoredBidResult> =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly result: R }
  | { readonly kind: "conflict" };

export function isExpired(record: IdempotencyRecord<unknown>, now: number): boolean {
  return now - record.createdAt >= IDEMPOTENCY_RETENTION_MS;
}

/** `existing` must be the record stored under (request.userId, request.key), if any. */
export function resolveIdempotency<R = StoredBidResult>(
  existing: IdempotencyRecord<R> | null | undefined,
  request: { readonly userId: string; readonly key: string; readonly fingerprint: string },
  now: number,
): IdempotencyResolution<R> {
  if (!existing || isExpired(existing, now)) return { kind: "new" };
  if (existing.userId !== request.userId || existing.key !== request.key) {
    // Storage returned a record for a different scope: a caller bug, never a replay.
    throw new Error("Idempotency record scope mismatch");
  }
  return existing.fingerprint === request.fingerprint
    ? { kind: "replay", result: existing.result }
    : { kind: "conflict" };
}

function toRejection(error: {
  readonly code: DomainErrorCode;
  readonly minNextBidMinor?: Paise;
  readonly maxAcceptableMinor?: Paise;
}): StoredRejection {
  const { code, minNextBidMinor, maxAcceptableMinor } = error;
  return {
    ok: false,
    code,
    ...(minNextBidMinor === undefined ? {} : { minNextBidMinor }),
    ...(maxAcceptableMinor === undefined ? {} : { maxAcceptableMinor }),
  };
}

/** The client-visible result of a decision, as stored for replays. */
export function toStoredResult(decision: BidDecision): StoredBidResult {
  if (decision.ok) {
    return {
      ok: true,
      bidId: decision.bid.bidId,
      seq: decision.bid.seq,
      amountMinor: decision.bid.amountMinor,
      closesAt: decision.state.closesAt,
      minNextBidMinor: minNextBidFor(decision.state),
    };
  }
  return toRejection(decision.error);
}

export function toStoredMaxResult(decision: MaxBidDecision): StoredMaxBidResult {
  return decision.ok ? { ok: true, ...decision.outcome } : toRejection(decision.error);
}

export function makeIdempotencyRecord(
  request: { userId: string; key: string; fingerprint: string },
  decision: BidDecision,
  now: number,
): IdempotencyRecord {
  return { ...request, result: toStoredResult(decision), createdAt: now };
}

export function makeMaxIdempotencyRecord(
  request: { userId: string; key: string; fingerprint: string },
  decision: MaxBidDecision,
  now: number,
): IdempotencyRecord<StoredMaxBidResult> {
  return { ...request, result: toStoredMaxResult(decision), createdAt: now };
}
