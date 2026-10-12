import { safeAdd, type Paise } from "./money";

/**
 * Bid increment ladder: the minimum increment depends on the current price band.
 * Bands are ordered by `upToMinor` ascending; the last band has `upToMinor: null` (unbounded).
 */
export type LadderBand = { readonly upToMinor: Paise | null; readonly incrementMinor: Paise };
export type IncrementLadder = readonly LadderBand[];

/**
 * Default ladder for used two-wheelers (BLUEPRINT §4.3). `upToMinor` is an EXCLUSIVE upper bound
 * on the current price. Exact boundaries (see docs/adr/004-auction-rules.md):
 *   price <  ₹25,000.00            → ₹250
 *   ₹25,000.00 ≤ price < ₹1,00,000 → ₹500
 *   ₹1,00,000 ≤ price ≤ ₹3,00,000  → ₹1,000   ("through ₹3,00,000": inclusive)
 *   price >  ₹3,00,000.00          → ₹2,500
 * Day-3 correction: the Day-1 ladder used `< ₹3,00,000` for the third band, which charged ₹2,500 at
 * exactly ₹3,00,000. The blueprint says "through", so the bound is ₹3,00,000.01 (30_000_001 paise).
 */
export const DEFAULT_LADDER: IncrementLadder = [
  { upToMinor: 2_500_000, incrementMinor: 25_000 },
  { upToMinor: 10_000_000, incrementMinor: 50_000 },
  { upToMinor: 30_000_001, incrementMinor: 100_000 },
  { upToMinor: null, incrementMinor: 250_000 },
];

export function validateLadder(ladder: IncrementLadder): void {
  if (ladder.length === 0) throw new Error("Ladder must have at least one band");
  let prev = 0;
  ladder.forEach((band, i) => {
    const isLast = i === ladder.length - 1;
    if (!Number.isSafeInteger(band.incrementMinor) || band.incrementMinor <= 0) {
      throw new Error(`Band ${i}: increment must be a positive integer`);
    }
    if (isLast !== (band.upToMinor === null)) {
      throw new Error("Only the last band may be unbounded, and it must be");
    }
    if (band.upToMinor !== null) {
      if (band.upToMinor <= prev) throw new Error(`Band ${i}: bounds must strictly increase`);
      prev = band.upToMinor;
    }
  });
}

export function incrementFor(currentMinor: Paise, ladder: IncrementLadder = DEFAULT_LADDER): Paise {
  for (const band of ladder) {
    if (band.upToMinor === null || currentMinor < band.upToMinor) return band.incrementMinor;
  }
  // validateLadder guarantees an unbounded last band; this is unreachable for valid ladders.
  throw new Error("Invalid ladder: no unbounded final band");
}

/**
 * Minimum acceptable next bid. Before any bid, the starting price itself is acceptable.
 */
export function minNextBid(
  input: { startPriceMinor: Paise; currentPriceMinor: Paise | null },
  ladder: IncrementLadder = DEFAULT_LADDER,
): Paise {
  if (input.currentPriceMinor === null) return input.startPriceMinor;
  return safeAdd(input.currentPriceMinor, incrementFor(input.currentPriceMinor, ladder));
}
