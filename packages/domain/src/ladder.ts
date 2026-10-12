import type { Paise } from "./money";

/**
 * Bid increment ladder: the minimum increment depends on the current price band.
 * Bands are ordered by `upToMinor` ascending; the last band has `upToMinor: null` (unbounded).
 */
export type LadderBand = { readonly upToMinor: Paise | null; readonly incrementMinor: Paise };
export type IncrementLadder = readonly LadderBand[];

/** Default ladder for used two-wheelers (see BLUEPRINT §4.3). */
export const DEFAULT_LADDER: IncrementLadder = [
  { upToMinor: 2_500_000, incrementMinor: 25_000 }, // < ₹25,000 → ₹250
  { upToMinor: 10_000_000, incrementMinor: 50_000 }, // < ₹1,00,000 → ₹500
  { upToMinor: 30_000_000, incrementMinor: 100_000 }, // < ₹3,00,000 → ₹1,000
  { upToMinor: null, incrementMinor: 250_000 }, // ≥ ₹3,00,000 → ₹2,500
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
  return input.currentPriceMinor + incrementFor(input.currentPriceMinor, ladder);
}
