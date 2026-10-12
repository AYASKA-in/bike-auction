import { minNextBid as ladderMinNextBid } from "../ladder";
import { isValidAmount, safeMultiply, type Paise } from "../money";
import {
  AUCTION_ID_PATTERN,
  DEFAULT_RULES,
  hardCloseFor,
  isTimestamp,
  validateTerms,
  type AuctionTerms,
} from "./config";
import { DomainInvariantError, domainError, type DomainError } from "./errors";
import type { AuctionEvent, EventDraft } from "./events";
import type { AuctionOutcome, AuctionRules, AuctionState } from "./types";

/**
 * The auction engine. Every function is PURE: same inputs → same outputs, no clock, no I/O, no
 * hidden state. `now` is always supplied by the trusted caller (the auction Durable Object).
 *
 * Every command returns the new state AND the ordered events to persist. Rejected commands still
 * return lifecycle events produced while resolving time (e.g. a late bid that discovers the
 * auction has ended): the caller must commit those events even though the command failed.
 */
export interface Transition {
  readonly state: AuctionState;
  readonly events: readonly AuctionEvent[];
}

export type CommandResult =
  | (Transition & { readonly ok: true })
  | (Transition & { readonly ok: false; readonly error: DomainError });

export type BidAccepted = Transition & {
  readonly ok: true;
  readonly bid: { readonly bidId: string; readonly seq: number; readonly amountMinor: Paise };
};
export type BidDecision =
  BidAccepted | (Transition & { readonly ok: false; readonly error: DomainError });

// ───────────────────────────── helpers ─────────────────────────────

function assertNow(now: unknown): asserts now is number {
  if (!isTimestamp(now))
    throw new DomainInvariantError(`now must be integer epoch ms, got ${String(now)}`);
}

/** Appends events, assigning seq = state.seq + 1, +2, ... and updating state.seq. */
class EventLog {
  readonly events: AuctionEvent[] = [];
  constructor(public state: AuctionState) {}
  emit(draft: EventDraft, patch: Partial<AuctionState> = {}): void {
    const seq = this.state.seq + 1;
    this.events.push({ ...draft, seq } as AuctionEvent);
    this.state = { ...this.state, ...patch, seq };
  }
  ok(): CommandResult {
    return { ok: true, state: this.state, events: this.events };
  }
  fail(error: DomainError): CommandResult & { ok: false } {
    return { ok: false, error, state: this.state, events: this.events };
  }
}

export function minNextBidFor(state: AuctionState): Paise {
  return ladderMinNextBid(
    { startPriceMinor: state.startPriceMinor, currentPriceMinor: state.currentPriceMinor },
    state.rules.ladder,
  );
}

/** Largest acceptable bid right now (fat-finger protection), never below the minimum. */
export function maxAcceptableBid(state: AuctionState): Paise {
  const reference = state.currentPriceMinor ?? state.startPriceMinor;
  const { maxMultiplier, maxAmountMinor } = state.rules.limits;
  const soft = Math.max(minNextBidFor(state), safeMultiply(reference, maxMultiplier));
  return Math.min(soft, maxAmountMinor);
}

export function isReserveMet(state: AuctionState): boolean {
  if (state.reserveMinor === null) return state.currentPriceMinor !== null;
  return state.currentPriceMinor !== null && state.currentPriceMinor >= state.reserveMinor;
}

/** Outcome is a pure function of the accepted bids and the reserve. */
export function outcomeFor(state: AuctionState): AuctionOutcome {
  if (state.currentPriceMinor === null || state.leaderUserId === null) return "NO_BIDS";
  if (state.reserveMinor !== null && state.currentPriceMinor < state.reserveMinor)
    return "RESERVE_NOT_MET";
  return "SOLD";
}

// ───────────────────────────── creation & configuration ─────────────────────────────

export interface CreateAuctionInput {
  readonly auctionId: string;
  readonly startPriceMinor: Paise;
  readonly reserveMinor?: Paise | null;
  readonly startsAt: number;
  readonly closesAt: number;
  readonly rules?: AuctionRules;
  readonly now: number;
}

const EMPTY: Omit<
  AuctionState,
  | "auctionId"
  | "startPriceMinor"
  | "reserveMinor"
  | "rules"
  | "startsAt"
  | "originalClosesAt"
  | "closesAt"
  | "hardCloseAt"
> = {
  status: "DRAFT",
  currentPriceMinor: null,
  leaderUserId: null,
  leaderBidSeq: null,
  bidCount: 0,
  extensionCount: 0,
  seq: 0,
  outcome: null,
  winnerUserId: null,
  endedAt: null,
  cancelledAt: null,
  cancelReason: null,
};

/** DRAFT auction. Emits auction.created (seq 1). */
export function createAuction(input: CreateAuctionInput): CommandResult {
  assertNow(input.now);
  const rules = input.rules ?? DEFAULT_RULES;
  const terms: AuctionTerms = {
    startPriceMinor: input.startPriceMinor,
    reserveMinor: input.reserveMinor ?? null,
    startsAt: input.startsAt,
    closesAt: input.closesAt,
    rules,
  };
  const placeholder: AuctionState = {
    ...EMPTY,
    auctionId: input.auctionId,
    startPriceMinor: 0,
    reserveMinor: null,
    rules,
    startsAt: 0,
    originalClosesAt: 0,
    closesAt: 0,
    hardCloseAt: 0,
  };
  if (typeof input.auctionId !== "string" || !AUCTION_ID_PATTERN.test(input.auctionId)) {
    return new EventLog(placeholder).fail(domainError("VALIDATION_FAILED", "Invalid auction id"));
  }
  const invalid = validateTerms(terms);
  if (invalid) return new EventLog(placeholder).fail(invalid);

  const log = new EventLog({
    ...placeholder,
    startPriceMinor: terms.startPriceMinor,
    reserveMinor: terms.reserveMinor,
    startsAt: terms.startsAt,
    originalClosesAt: terms.closesAt,
    closesAt: terms.closesAt,
    hardCloseAt: hardCloseFor(terms.closesAt, rules),
  });
  log.emit({
    type: "auction.created",
    at: input.now,
    startPriceMinor: terms.startPriceMinor,
    reserveMinor: terms.reserveMinor,
    startsAt: terms.startsAt,
    closesAt: terms.closesAt,
  });
  return log.ok();
}

export type AuctionPatch = Partial<
  Pick<AuctionTerms, "startPriceMinor" | "reserveMinor" | "startsAt" | "closesAt" | "rules">
>;

/**
 * Admin edits. Allowed only while DRAFT or SCHEDULED and not yet started (time is resolved first,
 * so an auction whose start time has passed is LIVE and immutable even if no alarm ran).
 */
export function updateTerms(state: AuctionState, patch: AuctionPatch, now: number): CommandResult {
  assertNow(now);
  const t = tick(state, now);
  const log = new EventLog(t.state);
  log.events.push(...t.events);
  const s = log.state;
  if (s.status !== "DRAFT" && s.status !== "SCHEDULED") {
    return log.fail(
      domainError("INVALID_TRANSITION", `Cannot edit an auction that is ${s.status}`),
    );
  }
  const terms: AuctionTerms = {
    startPriceMinor: patch.startPriceMinor ?? s.startPriceMinor,
    reserveMinor: patch.reserveMinor === undefined ? s.reserveMinor : patch.reserveMinor,
    startsAt: patch.startsAt ?? s.startsAt,
    closesAt: patch.closesAt ?? s.originalClosesAt,
    rules: patch.rules ?? s.rules,
  };
  const invalid = validateTerms(terms);
  if (invalid) return log.fail(invalid);
  if (s.status === "SCHEDULED" && terms.closesAt <= now) {
    return log.fail(
      domainError("VALIDATION_FAILED", "A scheduled auction must close in the future"),
    );
  }
  const fields = (Object.keys(patch) as (keyof AuctionPatch)[])
    .filter((k) => patch[k] !== undefined)
    .sort();
  if (fields.length === 0) return log.ok();
  log.emit(
    { type: "auction.updated", at: now, fields },
    {
      startPriceMinor: terms.startPriceMinor,
      reserveMinor: terms.reserveMinor,
      startsAt: terms.startsAt,
      originalClosesAt: terms.closesAt,
      closesAt: terms.closesAt,
      hardCloseAt: hardCloseFor(terms.closesAt, terms.rules),
      rules: terms.rules,
    },
  );
  // An edit can move startsAt into the past: resolve time again so state is never stale.
  const after = tick(log.state, now);
  log.state = after.state;
  log.events.push(...after.events);
  return log.ok();
}

/** DRAFT → SCHEDULED. If startsAt has already passed, the same call also starts it. */
export function schedule(state: AuctionState, now: number): CommandResult {
  assertNow(now);
  const log = new EventLog(state);
  if (state.status !== "DRAFT") {
    return log.fail(
      domainError(
        "INVALID_TRANSITION",
        `Only a DRAFT auction can be scheduled (is ${state.status})`,
      ),
    );
  }
  if (state.closesAt <= now) {
    return log.fail(
      domainError("VALIDATION_FAILED", "Cannot schedule an auction whose close time has passed"),
    );
  }
  log.emit(
    {
      type: "auction.scheduled",
      at: now,
      startsAt: state.startsAt,
      closesAt: state.closesAt,
      hardCloseAt: state.hardCloseAt,
    },
    { status: "SCHEDULED" },
  );
  const t = tick(log.state, now);
  log.state = t.state;
  log.events.push(...t.events);
  return log.ok();
}

// ───────────────────────────── time ─────────────────────────────

/**
 * Resolves lifecycle transitions that are due at `now`. Idempotent: calling it again with the same
 * or a later `now` never repeats an event (invariant L). Handles arbitrarily delayed alarms: an
 * auction observed long after its close goes SCHEDULED → LIVE → ENDED in one call, with
 * `startedAt`/`endedAt` set to the authoritative schedule, not the observation time.
 */
export function tick(state: AuctionState, now: number): Transition {
  assertNow(now);
  const log = new EventLog(state);
  if (log.state.status === "SCHEDULED" && now >= log.state.startsAt) {
    log.emit(
      { type: "auction.started", at: now, startedAt: log.state.startsAt },
      { status: "LIVE" },
    );
  }
  if (log.state.status === "LIVE" && now >= log.state.closesAt) {
    const s = log.state;
    const outcome = outcomeFor(s);
    const winnerUserId = outcome === "SOLD" ? s.leaderUserId : null;
    log.emit(
      {
        type: "auction.ended",
        at: now,
        outcome,
        winnerUserId,
        finalPriceMinor: s.currentPriceMinor,
        endedAt: s.closesAt,
      },
      { status: "ENDED", outcome, winnerUserId, endedAt: s.closesAt },
    );
  }
  return { state: log.state, events: log.events };
}

// ───────────────────────────── bidding ─────────────────────────────

export interface PlaceBidCommand {
  /** Server-generated id for the bid row. */
  readonly bidId: string;
  /** From the authenticated session, never from the request body. */
  readonly userId: string;
  /** Untrusted until validated here. */
  readonly amountMinor: unknown;
  /** Authoritative server time. */
  readonly now: number;
}

/**
 * Evaluates a bid against authoritative state at `now`.
 *
 * Order of checks (deterministic, documented in ADR 004):
 *   1. resolve time (start/close)       5. bidder is not already leading
 *   2. auction is LIVE                  6. amount ≥ minimum next bid
 *   3. amount is a valid integer        7. amount ≤ fat-finger limit
 *   4. amount ≤ absolute ceiling
 * A rejection never changes price, leader, bid count or ledger. It may carry lifecycle events
 * from step 1, which the caller must commit.
 */
export function placeBid(state: AuctionState, cmd: PlaceBidCommand): BidDecision {
  assertNow(cmd.now);
  if (typeof cmd.userId !== "string" || cmd.userId.length === 0) {
    throw new DomainInvariantError("userId must come from the authenticated session");
  }
  if (typeof cmd.bidId !== "string" || cmd.bidId.length === 0)
    throw new DomainInvariantError("bidId required");

  const t = tick(state, cmd.now);
  const log = new EventLog(t.state);
  log.events.push(...t.events);
  const s = log.state;

  if (s.status === "CANCELLED")
    return log.fail(domainError("AUCTION_CANCELLED", "This auction was cancelled"));
  if (s.status === "ENDED") return log.fail(domainError("AUCTION_ENDED", "This auction has ended"));
  if (s.status !== "LIVE")
    return log.fail(domainError("AUCTION_NOT_LIVE", "This auction has not started"));

  const amount = cmd.amountMinor;
  // Shape check only (positive safe integer); the ceiling is a separate, more specific rejection.
  if (!isValidAmount(amount, Number.MAX_SAFE_INTEGER)) {
    return log.fail(
      domainError("BID_INVALID_AMOUNT", "Bid must be a positive whole number of paise"),
    );
  }
  const required = minNextBidFor(s);
  if (amount > s.rules.limits.maxAmountMinor) {
    return log.fail(
      domainError("BID_UNREASONABLE", "Bid exceeds the maximum for this auction", {
        maxAcceptableMinor: maxAcceptableBid(s),
        minNextBidMinor: required,
      }),
    );
  }
  if (s.leaderUserId === cmd.userId) {
    return log.fail(domainError("ALREADY_LEADING", "You already have the highest bid"));
  }
  if (amount < required) {
    return log.fail(
      domainError("BID_TOO_LOW", "Bid is below the minimum next bid", {
        minNextBidMinor: required,
      }),
    );
  }
  const ceiling = maxAcceptableBid(s);
  if (amount > ceiling) {
    return log.fail(
      domainError("BID_UNREASONABLE", "Bid is far above the current price. Check the amount.", {
        maxAcceptableMinor: ceiling,
        minNextBidMinor: required,
      }),
    );
  }

  // ── accept ──
  const accepted: AuctionState = {
    ...s,
    currentPriceMinor: amount,
    leaderUserId: cmd.userId,
    leaderBidSeq: s.seq + 1,
    bidCount: s.bidCount + 1,
  };
  const nextMin = minNextBidFor(accepted);
  log.emit(
    {
      type: "bid.accepted",
      at: cmd.now,
      bidId: cmd.bidId,
      userId: cmd.userId,
      amountMinor: amount,
      previousPriceMinor: s.currentPriceMinor,
      minNextBidMinor: nextMin,
      reserveMet: isReserveMet(accepted),
      closesAt: s.closesAt,
    },
    {
      currentPriceMinor: accepted.currentPriceMinor,
      leaderUserId: accepted.leaderUserId,
      leaderBidSeq: accepted.leaderBidSeq,
      bidCount: accepted.bidCount,
    },
  );
  const bidSeq = log.state.seq;

  // ── soft close ──
  const sc = s.rules.softClose;
  if (sc && log.state.closesAt - cmd.now < sc.windowMs) {
    const proposed = Math.min(cmd.now + sc.extensionMs, log.state.hardCloseAt);
    if (proposed > log.state.closesAt) {
      const previous = log.state.closesAt;
      log.emit(
        {
          type: "auction.extended",
          at: cmd.now,
          previousClosesAt: previous,
          closesAt: proposed,
          extensionCount: log.state.extensionCount + 1,
        },
        { closesAt: proposed, extensionCount: log.state.extensionCount + 1 },
      );
    }
  }
  return {
    ok: true,
    state: log.state,
    events: log.events,
    bid: { bidId: cmd.bidId, seq: bidSeq, amountMinor: amount },
  };
}

// ───────────────────────────── cancellation ─────────────────────────────

export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 500;

/** DRAFT/SCHEDULED/LIVE → CANCELLED. Time is resolved first: an auction past its close has ENDED. */
export function cancel(
  state: AuctionState,
  input: { readonly reason: string; readonly now: number },
): CommandResult {
  assertNow(input.now);
  const t = tick(state, input.now);
  const log = new EventLog(t.state);
  log.events.push(...t.events);
  const s = log.state;
  if (s.status === "ENDED")
    return log.fail(domainError("AUCTION_ENDED", "An ended auction cannot be cancelled"));
  if (s.status === "CANCELLED")
    return log.fail(domainError("AUCTION_CANCELLED", "Auction is already cancelled"));
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < CANCEL_REASON_MIN || reason.length > CANCEL_REASON_MAX) {
    return log.fail(
      domainError(
        "VALIDATION_FAILED",
        `Reason must be ${CANCEL_REASON_MIN}–${CANCEL_REASON_MAX} characters`,
      ),
    );
  }
  log.emit(
    { type: "auction.cancelled", at: input.now, reason, previousStatus: s.status },
    { status: "CANCELLED", cancelledAt: input.now, cancelReason: reason, winnerUserId: null },
  );
  return log.ok();
}

/** ENDED and CANCELLED are terminal: no command can leave them (invariant F). */
export function isTerminal(state: AuctionState): boolean {
  return state.status === "ENDED" || state.status === "CANCELLED";
}
