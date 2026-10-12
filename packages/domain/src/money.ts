/**
 * Money is an integer count of paise (1 INR = 100 paise). Never floating point.
 * ₹1 crore = 1e9 paise, comfortably inside Number.MAX_SAFE_INTEGER (~9e15).
 */
export type Paise = number;

export const PAISE_PER_RUPEE = 100;

export function isValidAmount(amountMinor: unknown): amountMinor is Paise {
  return typeof amountMinor === "number" && Number.isSafeInteger(amountMinor) && amountMinor > 0;
}

export function rupees(r: number): Paise {
  const p = Math.round(r * PAISE_PER_RUPEE);
  if (!Number.isSafeInteger(p)) throw new RangeError(`Amount out of range: ${r}`);
  return p;
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/** Presentation only: ₹2,81,500 (Indian digit grouping). */
export function formatINR(amountMinor: Paise): string {
  return inr.format(amountMinor / PAISE_PER_RUPEE);
}
