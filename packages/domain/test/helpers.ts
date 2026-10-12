import {
  createAuction,
  DEFAULT_RULES,
  placeBid,
  schedule,
  type AuctionRules,
  type AuctionState,
  type BidDecision,
  type CommandResult,
} from "../src";

export const T0 = 1_800_000_000_000; // fixed epoch ms; tests never read the real clock
export const MIN = 60_000;
export const START = T0 + MIN;
export const CLOSE = START + 60 * MIN;

export function expectOk<T extends CommandResult | BidDecision>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r as Extract<T, { ok: true }>;
}

export function draft(
  opts: {
    startPriceMinor?: number;
    reserveMinor?: number | null;
    startsAt?: number;
    closesAt?: number;
    rules?: AuctionRules;
  } = {},
): AuctionState {
  return expectOk(
    createAuction({
      auctionId: "auc-test",
      startPriceMinor: opts.startPriceMinor ?? 5_000_000, // ₹50,000
      reserveMinor: opts.reserveMinor ?? null,
      startsAt: opts.startsAt ?? START,
      closesAt: opts.closesAt ?? CLOSE,
      rules: opts.rules ?? DEFAULT_RULES,
      now: T0,
    }),
  ).state;
}

/** A LIVE auction (scheduled at T0, observed at START). */
export function live(opts: Parameters<typeof draft>[0] = {}): AuctionState {
  const d = draft(opts);
  return expectOk(schedule(d, d.startsAt)).state;
}

let n = 0;
export function bid(
  state: AuctionState,
  userId: string,
  amountMinor: unknown,
  now: number,
): BidDecision {
  n += 1;
  return placeBid(state, { bidId: `bid-${n}`, userId, amountMinor, now });
}
