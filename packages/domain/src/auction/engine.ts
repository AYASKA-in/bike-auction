import { incrementFor, minNextBid as ladderMinNextBid } from "../ladder";
import { isValidAmount, safeAdd, safeMultiply, type Paise } from "../money";
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
import type { AuctionOutcome, AuctionRules, AuctionState, BidKind, ProxyBid } from "./types";

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
  proxies: [],
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
 * from step 1, which the caller must commit. One exception (proxy tie): a bid exactly equal to
 * someone's earlier maximum is rejected BID_TOO_LOW while that maximum's automatic bid at the same
 * amount is committed. An accepted bid is followed, in the same command, by any automatic
 * responses from standing maxima (kind PROXY) and at most one soft-close extension.
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

  const stepId = stepIds(cmd.bidId);

  // ── tie with an earlier maximum (BLUEPRINT §4.7: equal amounts → the earlier commitment wins) ──
  // A manual bid exactly equal to someone else's standing maximum cannot be recorded and then
  // matched (the ledger is strictly increasing), so the earlier maximum takes the amount and this
  // bid is rejected as too low. The proxy step is committed even though the command fails.
  const rival = rankProxies(
    s.proxies.filter((p) => p.userId !== cmd.userId && p.maxMinor >= amount),
  )[0];
  if (rival && rival.maxMinor === amount) {
    emitBid(log, {
      bidId: stepId(),
      userId: rival.userId,
      amountMinor: amount,
      kind: "PROXY",
      now: cmd.now,
    });
    resolveProxies(log, cmd.now, stepId);
    applySoftClose(log, cmd.now);
    return log.fail(
      domainError("BID_TOO_LOW", "An earlier maximum bid of the same amount takes priority", {
        minNextBidMinor: minNextBidFor(log.state),
      }),
    );
  }

  // ── accept, then let standing maxima respond (same atomic command) ──
  const bidSeq = emitBid(log, {
    bidId: cmd.bidId,
    userId: cmd.userId,
    amountMinor: amount,
    kind: "MANUAL",
    now: cmd.now,
  });
  resolveProxies(log, cmd.now, stepId);
  applySoftClose(log, cmd.now);
  return {
    ok: true,
    state: log.state,
    events: log.events,
    bid: { bidId: cmd.bidId, seq: bidSeq, amountMinor: amount },
  };
}

// ───────────────────────────── proxy (automatic) bidding ─────────────────────────────

/**
 * Ranks maxima: higher max first; equal maxima → earlier `setSeq` (BLUEPRINT §4.7); `userId` only
 * as a final deterministic tie-break (competing maxima never share a setSeq, see ADR 004).
 */
export function compareProxies(a: ProxyBid, b: ProxyBid): number {
  return (
    b.maxMinor - a.maxMinor ||
    a.setSeq - b.setSeq ||
    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  );
}

function rankProxies(proxies: readonly ProxyBid[]): ProxyBid[] {
  return [...proxies].sort(compareProxies);
}

export function proxyOf(state: AuctionState, userId: string): ProxyBid | null {
  return state.proxies.find((p) => p.userId === userId) ?? null;
}

/** Deterministic ids for automatic steps: `<commandBidId>-p1`, `-p2`, … (pure, no randomness). */
function stepIds(base: string): () => string {
  let n = 0;
  return () => `${base}-p${++n}`;
}

/** Appends one accepted bid (manual or automatic) and returns its seq. */
function emitBid(
  log: EventLog,
  b: {
    readonly bidId: string;
    readonly userId: string;
    readonly amountMinor: Paise;
    readonly kind: BidKind;
    readonly now: number;
  },
): number {
  const s = log.state;
  if (s.currentPriceMinor !== null && b.amountMinor <= s.currentPriceMinor) {
    throw new DomainInvariantError("Accepted bids must strictly increase");
  }
  const accepted: AuctionState = {
    ...s,
    currentPriceMinor: b.amountMinor,
    leaderUserId: b.userId,
    leaderBidSeq: s.seq + 1,
    bidCount: s.bidCount + 1,
  };
  log.emit(
    {
      type: "bid.accepted",
      at: b.now,
      bidId: b.bidId,
      userId: b.userId,
      amountMinor: b.amountMinor,
      kind: b.kind,
      previousPriceMinor: s.currentPriceMinor,
      minNextBidMinor: minNextBidFor(accepted),
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
  return log.state.seq;
}

/**
 * Reserve rule for maxima (eBay behaviour): when the winning maximum covers the reserve but the
 * computed price is below it, the price jumps to exactly the reserve.
 */
function withReserveJump(state: AuctionState, price: Paise, maxMinor: Paise): Paise {
  const r = state.reserveMinor;
  return r !== null && maxMinor >= r && price < r ? r : price;
}

/**
 * Lets standing maxima respond until the auction is stable: no maximum other than the leader's can
 * still meet the minimum next bid or beat the leader's commitment L = max(current price, leader's
 * own maximum). Each round takes the best such challenging maximum C:
 *
 *   C wins (C > L, or C = L and C was set earlier):
 *     [leader's maximum, if it is a real step]  then  C at min(C, max(minNext, L + inc(L)))
 *   L holds (L > C, or equal and L earlier):
 *     [C's maximum, if below the final price]   then  leader at min(L, max(minNext, C + inc(C)))
 *
 * Final prices then pass the reserve rule. Every round permanently exhausts a maximum (price passes
 * it) or makes it the leader, so the loop ends; with the stable state every command leaves behind,
 * it runs at most once (two steps).
 */
function resolveProxies(log: EventLog, now: number, stepId: () => string): void {
  const limit = 2 * log.state.proxies.length + 2;
  for (let round = 0; ; round++) {
    if (round > limit) throw new DomainInvariantError("Proxy resolution did not converge");
    const s = log.state;
    const min = minNextBidFor(s);
    const leader = s.leaderUserId;
    const price = s.currentPriceMinor;
    const leaderProxy = leader === null ? null : proxyOf(s, leader);
    const leaderCommit = price === null ? 0 : Math.max(price, leaderProxy?.maxMinor ?? 0);
    const outranksLeader = (p: ProxyBid) =>
      leader !== null &&
      (p.maxMinor > leaderCommit ||
        (p.maxMinor === leaderCommit &&
          leaderProxy !== null &&
          leaderProxy.maxMinor === leaderCommit &&
          compareProxies(p, leaderProxy) < 0));
    // A maximum can act if it can make a valid bid, or if it beats the leader's commitment even
    // by less than one increment (then it wins capped at its own maximum, e.g. a leader's maximum
    // defending against a manual bid just below it).
    const challenger = rankProxies(
      s.proxies.filter((p) => p.userId !== leader && (p.maxMinor >= min || outranksLeader(p))),
    )[0];
    const step = (userId: string, amountMinor: Paise) =>
      emitBid(log, { bidId: stepId(), userId, amountMinor, kind: "PROXY", now });

    if (!challenger) {
      // Nobody can compete; a leader whose maximum covers the reserve still lifts the price to it.
      if (leader !== null && price !== null && leaderProxy) {
        const target = withReserveJump(s, price, leaderProxy.maxMinor);
        if (target > price) step(leader, target);
      }
      return;
    }
    if (leader === null || price === null) {
      step(challenger.userId, withReserveJump(s, min, challenger.maxMinor));
      continue;
    }
    const ladder = s.rules.ladder;
    if (outranksLeader(challenger)) {
      const target = withReserveJump(
        s,
        Math.min(
          challenger.maxMinor,
          Math.max(min, safeAdd(leaderCommit, incrementFor(leaderCommit, ladder))),
        ),
        challenger.maxMinor,
      );
      const lm = leaderProxy?.maxMinor;
      if (lm !== undefined && lm > price && lm >= min && lm < target) step(leader, lm);
      step(challenger.userId, target);
    } else {
      // leaderCommit ≥ challenger ≥ min > price, so the leader's commitment is their maximum.
      if (!leaderProxy) throw new DomainInvariantError("Leader holds without a maximum");
      const cm = challenger.maxMinor;
      const target = withReserveJump(
        s,
        Math.min(leaderProxy.maxMinor, Math.max(min, safeAdd(cm, incrementFor(cm, ladder)))),
        leaderProxy.maxMinor,
      );
      if (cm < target) step(challenger.userId, cm);
      step(leader, target);
    }
  }
}

/**
 * Soft close, at most once per command: if the command accepted any bid (manual or automatic)
 * while `closesAt − now < window`, the close moves to `min(now + extension, hardCloseAt)`. All steps
 * of one command share `now`, so one extension is exactly what per-step extensions would give.
 */
function applySoftClose(log: EventLog, now: number): void {
  const sc = log.state.rules.softClose;
  if (!sc || log.state.closesAt - now >= sc.windowMs) return;
  const proposed = Math.min(now + sc.extensionMs, log.state.hardCloseAt);
  if (proposed <= log.state.closesAt) return;
  log.emit(
    {
      type: "auction.extended",
      at: now,
      previousClosesAt: log.state.closesAt,
      closesAt: proposed,
      extensionCount: log.state.extensionCount + 1,
    },
    { closesAt: proposed, extensionCount: log.state.extensionCount + 1 },
  );
}

export interface SetMaxBidCommand {
  /** Server-generated base id; automatic steps get `<bidId>-p1`, `-p2`, … */
  readonly bidId: string;
  /** From the authenticated session, never from the request body. */
  readonly userId: string;
  /** Untrusted until validated here. */
  readonly maxMinor: unknown;
  readonly now: number;
}

/** What the owner learns after setting a maximum (their own max, and public auction state). */
export interface MaxBidOutcome {
  readonly maxMinor: Paise;
  readonly isLeading: boolean;
  readonly currentPriceMinor: Paise;
  readonly minNextBidMinor: Paise;
  readonly seq: number;
}

export type MaxBidDecision =
  | (Transition & { readonly ok: true; readonly outcome: MaxBidOutcome })
  | (Transition & { readonly ok: false; readonly error: DomainError });

/**
 * Sets (or replaces) the caller's hidden maximum and resolves it against the field in the same
 * command. Checks, in order (ADR 004 › Proxy bidding):
 *   1. resolve time   2. auction is LIVE   3. valid amount   4. ≤ absolute ceiling
 *   5. ≥ minimum next bid (also bounds lowering: never below current exposure)
 *   6. ≤ fat-finger limit max(minNext, 3 × reference)  — same BID_UNREASONABLE rule as bids
 * The leader may raise (or lower, while ≥ minNext) their own maximum: no public bid unless the
 * reserve rule lifts the price. Re-sending the current maximum is a no-op that keeps priority.
 */
export function setMaxBid(state: AuctionState, cmd: SetMaxBidCommand): MaxBidDecision {
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

  const max = cmd.maxMinor;
  if (!isValidAmount(max, Number.MAX_SAFE_INTEGER)) {
    return log.fail(
      domainError("BID_INVALID_AMOUNT", "Maximum must be a positive whole number of paise"),
    );
  }
  const required = minNextBidFor(s);
  if (max > s.rules.limits.maxAmountMinor) {
    return log.fail(
      domainError("BID_UNREASONABLE", "Maximum exceeds the limit for this auction", {
        maxAcceptableMinor: maxAcceptableBid(s),
        minNextBidMinor: required,
      }),
    );
  }
  if (max < required) {
    return log.fail(
      domainError("BID_TOO_LOW", "Maximum is below the minimum next bid", {
        minNextBidMinor: required,
      }),
    );
  }
  const ceiling = maxAcceptableBid(s);
  if (max > ceiling) {
    return log.fail(
      domainError("BID_UNREASONABLE", "Maximum is far above the current price. Check the amount.", {
        maxAcceptableMinor: ceiling,
        minNextBidMinor: required,
      }),
    );
  }

  const existing = proxyOf(s, cmd.userId);
  if (!existing || existing.maxMinor !== max) {
    // Provisionally last in priority; the real setSeq is the seq once this command commits.
    const provisional: ProxyBid = {
      userId: cmd.userId,
      maxMinor: max,
      setSeq: Number.MAX_SAFE_INTEGER,
      updatedAt: cmd.now,
    };
    log.state = {
      ...s,
      proxies: [...s.proxies.filter((p) => p.userId !== cmd.userId), provisional],
    };
    const bidsBefore = log.state.bidCount;
    resolveProxies(log, cmd.now, stepIds(cmd.bidId));
    if (log.state.bidCount > bidsBefore) applySoftClose(log, cmd.now);
    const setSeq = log.state.seq;
    log.state = {
      ...log.state,
      proxies: log.state.proxies.map((p) => (p.userId === cmd.userId ? { ...p, setSeq } : p)),
    };
  }
  const f = log.state;
  if (f.currentPriceMinor === null) throw new DomainInvariantError("A maximum left no price");
  return {
    ok: true,
    state: f,
    events: log.events,
    outcome: {
      maxMinor: max,
      isLeading: f.leaderUserId === cmd.userId,
      currentPriceMinor: f.currentPriceMinor,
      minNextBidMinor: minNextBidFor(f),
      seq: f.seq,
    },
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
