import type { Paise } from "../money";
import type { DomainErrorCode } from "./errors";
import type { BidDecision } from "./engine";

/**
 * Idempotency for bid commands (BLUEPRINT §5). Pure decision logic only: the auction Durable
 * Object stores records in its own SQLite table in the SAME transaction as the bid (Day 4).
 * Nothing in this module is storage; an in-memory map is never durable.
 *
 * Semantics:
 *  - Records are scoped by (userId, key). Two users may use the same key independently.
 *  - Same key + same fingerprint within retention → the ORIGINAL stored result, no new effects.
 *  - Same key + different fingerprint → conflict (IDEMPOTENCY_KEY_REUSED), no effects.
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

/**
 * Identity of the *request payload*. Excludes server-assigned values (bidId, now) so a retry of the
 * same intent matches. Versioned so the format can evolve without colliding with old records.
 */
export function bidFingerprint(input: { auctionId: string; amountMinor: unknown }): string {
  return `bid:v1:${input.auctionId}:${typeof input.amountMinor === "number" ? input.amountMinor : JSON.stringify(input.amountMinor)}`;
}

export type StoredBidResult =
  | {
      readonly ok: true;
      readonly bidId: string;
      readonly seq: number;
      readonly amountMinor: Paise;
      readonly closesAt: number;
      readonly minNextBidMinor: Paise;
    }
  | {
      readonly ok: false;
      readonly code: DomainErrorCode;
      readonly minNextBidMinor?: Paise;
      readonly maxAcceptableMinor?: Paise;
    };

export interface IdempotencyRecord {
  readonly userId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly result: StoredBidResult;
  readonly createdAt: number;
}

export type IdempotencyResolution =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly result: StoredBidResult }
  | { readonly kind: "conflict" };

export function isExpired(record: IdempotencyRecord, now: number): boolean {
  return now - record.createdAt >= IDEMPOTENCY_RETENTION_MS;
}

/** `existing` must be the record stored under (request.userId, request.key), if any. */
export function resolveIdempotency(
  existing: IdempotencyRecord | null | undefined,
  request: { readonly userId: string; readonly key: string; readonly fingerprint: string },
  now: number,
): IdempotencyResolution {
  if (!existing || isExpired(existing, now)) return { kind: "new" };
  if (existing.userId !== request.userId || existing.key !== request.key) {
    // Storage returned a record for a different scope: a caller bug, never a replay.
    throw new Error("Idempotency record scope mismatch");
  }
  return existing.fingerprint === request.fingerprint
    ? { kind: "replay", result: existing.result }
    : { kind: "conflict" };
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
      minNextBidMinor: nextMinFromEvents(decision),
    };
  }
  const { code, minNextBidMinor, maxAcceptableMinor } = decision.error;
  return {
    ok: false,
    code,
    ...(minNextBidMinor === undefined ? {} : { minNextBidMinor }),
    ...(maxAcceptableMinor === undefined ? {} : { maxAcceptableMinor }),
  };
}

function nextMinFromEvents(decision: BidDecision): Paise {
  for (const e of decision.events) if (e.type === "bid.accepted") return e.minNextBidMinor;
  throw new Error("Accepted decision without bid.accepted event");
}

export function makeIdempotencyRecord(
  request: { userId: string; key: string; fingerprint: string },
  decision: BidDecision,
  now: number,
): IdempotencyRecord {
  return { ...request, result: toStoredResult(decision), createdAt: now };
}
