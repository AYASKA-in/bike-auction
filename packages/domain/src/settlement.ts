/**
 * Post-auction settlement rules (docs/settlement.md). Pure functions: no clock, no I/O.
 *
 * A winner pays 25% of the hammer price within 24 hours (the participation deposit counts towards
 * it), and the rest plus the buyer fee and GST on that fee by 23:59 IST on day 15. Missing either
 * deadline defaults the sale: the deposit is forfeited and the bike goes to the runner-up or back
 * to auction. All amounts are integer paise.
 */
import type { Paise } from "./money";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** IST = UTC+05:30, no daylight saving. */
const IST_OFFSET_MS = 5.5 * HOUR_MS;

export const SETTLEMENT_RULES = {
  /** Share of the hammer price due first (percent). */
  initialPercent: 25,
  initialWindowMs: DAY_MS,
  /** Balance due by 23:59:59.999 IST on this many days after the start. */
  balanceDays: 15,
  /** Buyer fee on the hammer price, in basis points (200 = 2%). */
  feeBps: 200,
  /** GST on the buyer fee, in basis points (1800 = 18%). */
  gstOnFeeBps: 1800,
  /** A runner-up has this long to accept a second-chance offer. */
  offerWindowMs: DAY_MS,
  /** One extension per settlement, at most this long. */
  maxExtensionMs: 72 * HOUR_MS,
  /** Days to collect the bike after paying in full. */
  collectionDays: 7,
  /** A bidder may bid up to this multiple of the deposit they hold. */
  depositMultiple: 10,
  /** Deposit amounts offered to buyers (₹5,000 / ₹10,000 / ₹25,000). */
  depositTiersMinor: [500_000, 1_000_000, 2_500_000] as readonly Paise[],
} as const;

export type SettlementStage = "AWAITING_INITIAL" | "AWAITING_BALANCE" | "PAID";

export interface SettlementTerms {
  priceMinor: Paise;
  /** 25% of the price, rounded up to the paisa. */
  initialTargetMinor: Paise;
  feeMinor: Paise;
  gstMinor: Paise;
  /** Price + fee + GST: what the sale costs in total. */
  totalMinor: Paise;
  /** Deposit counted towards the price (never more than the total). */
  depositAppliedMinor: Paise;
  /** What must be paid (beyond the deposit) by the first deadline. */
  initialDueMinor: Paise;
  /** What must be paid in all (beyond the deposit) by the second deadline. */
  payableMinor: Paise;
  initialDeadline: number;
  balanceDeadline: number;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

/** 23:59:59.999 IST on the calendar day (in IST) that contains `t`. */
export function endOfDayIst(t: number): number {
  const day = Math.floor((t + IST_OFFSET_MS) / DAY_MS);
  return (day + 1) * DAY_MS - IST_OFFSET_MS - 1;
}

export function settlementTerms(input: {
  priceMinor: Paise;
  depositHeldMinor: Paise;
  /** When the clock starts: the auction's close, or a runner-up's acceptance. */
  startAt: number;
  rules?: typeof SETTLEMENT_RULES;
}): SettlementTerms {
  const r = input.rules ?? SETTLEMENT_RULES;
  const price = input.priceMinor;
  if (!Number.isSafeInteger(price) || price <= 0)
    throw new RangeError("price must be positive paise");
  if (!Number.isSafeInteger(input.depositHeldMinor) || input.depositHeldMinor < 0)
    throw new RangeError("deposit must be non-negative paise");
  const initialTargetMinor = ceilDiv(price * r.initialPercent, 100);
  const feeMinor = ceilDiv(price * r.feeBps, 10_000);
  const gstMinor = ceilDiv(feeMinor * r.gstOnFeeBps, 10_000);
  const totalMinor = price + feeMinor + gstMinor;
  const depositAppliedMinor = Math.min(input.depositHeldMinor, totalMinor);
  return {
    priceMinor: price,
    initialTargetMinor,
    feeMinor,
    gstMinor,
    totalMinor,
    depositAppliedMinor,
    initialDueMinor: Math.max(0, initialTargetMinor - depositAppliedMinor),
    payableMinor: totalMinor - depositAppliedMinor,
    initialDeadline: input.startAt + r.initialWindowMs,
    balanceDeadline: endOfDayIst(input.startAt + r.balanceDays * DAY_MS),
  };
}

/** Where a settlement stands given what has been verified as paid. */
export function settlementStage(terms: SettlementTerms, verifiedMinor: Paise): SettlementStage {
  if (verifiedMinor >= terms.payableMinor) return "PAID";
  if (verifiedMinor >= terms.initialDueMinor) return "AWAITING_BALANCE";
  return "AWAITING_INITIAL";
}

/** The amount and deadline the buyer must meet next (0 / null once paid in full). */
export function amountDueNow(
  terms: SettlementTerms,
  verifiedMinor: Paise,
  extensionMs = 0,
): { stage: SettlementStage; dueMinor: Paise; deadline: number | null } {
  const stage = settlementStage(terms, verifiedMinor);
  if (stage === "PAID") return { stage, dueMinor: 0, deadline: null };
  if (stage === "AWAITING_INITIAL")
    return {
      stage,
      dueMinor: terms.initialDueMinor - verifiedMinor,
      deadline: terms.initialDeadline + extensionMs,
    };
  return {
    stage,
    dueMinor: terms.payableMinor - verifiedMinor,
    deadline: terms.balanceDeadline + extensionMs,
  };
}

/**
 * A stage defaults only once its deadline has passed AND no payment reported before the deadline
 * is still waiting for an admin's decision (a buyer who paid on time is never defaulted by a slow
 * verification).
 */
export function isDefaulted(input: {
  deadline: number | null;
  now: number;
  pendingReportedBeforeDeadline: boolean;
}): boolean {
  return (
    input.deadline !== null && input.now > input.deadline && !input.pendingReportedBeforeDeadline
  );
}

/** Highest bid a bidder may place (or maximum they may set). */
export function buyingLimitMinor(depositHeldMinor: Paise, rules = SETTLEMENT_RULES): Paise {
  return depositHeldMinor * rules.depositMultiple;
}

/** An extension is allowed once per settlement, for 1 ms .. 72 h. */
export function canExtend(alreadyExtendedMs: number, extraMs: number, rules = SETTLEMENT_RULES) {
  return (
    alreadyExtendedMs === 0 &&
    Number.isSafeInteger(extraMs) &&
    extraMs > 0 &&
    extraMs <= rules.maxExtensionMs
  );
}

/**
 * The second-chance offer goes to the highest bidder who is not excluded (earlier buyers of this
 * auction, suspended accounts) and whose own highest bid meets the reserve. Ties: lower user id.
 */
export function pickRunnerUp(
  bidders: readonly { userId: string; highestMinor: Paise }[],
  excluded: ReadonlySet<string>,
  reserveMinor: Paise | null,
): { userId: string; highestMinor: Paise } | null {
  const eligible = bidders
    .filter((b) => !excluded.has(b.userId))
    .filter((b) => reserveMinor === null || b.highestMinor >= reserveMinor)
    .sort((a, b) => b.highestMinor - a.highestMinor || (a.userId < b.userId ? -1 : 1));
  return eligible[0] ?? null;
}
