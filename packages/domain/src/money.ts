/**
 * Money is an integer count of paise (1 INR = 100 paise). Never floating point.
 * ₹1 crore = 1e9 paise, comfortably inside Number.MAX_SAFE_INTEGER (~9e15).
 */
export type Paise = number;

export const PAISE_PER_RUPEE = 100;

/** Hard platform ceiling for any single amount: ₹1 crore. Far above any two-wheeler, far below 2^53. */
export const MAX_AMOUNT_MINOR: Paise = 1_000_000_000;

/** A valid amount is a positive safe integer number of paise within the platform ceiling. */
export function isValidAmount(
  amountMinor: unknown,
  max: Paise = MAX_AMOUNT_MINOR,
): amountMinor is Paise {
  return (
    typeof amountMinor === "number" &&
    Number.isSafeInteger(amountMinor) &&
    amountMinor > 0 &&
    amountMinor <= max
  );
}

/** Multiplication that refuses to leave the safe-integer range (never silently loses precision). */
export function safeMultiply(a: number, b: number): number {
  const r = a * b;
  if (!Number.isSafeInteger(r)) throw new RangeError(`Unsafe integer arithmetic: ${a} * ${b}`);
  return r;
}

export function safeAdd(a: number, b: number): number {
  const r = a + b;
  if (!Number.isSafeInteger(r)) throw new RangeError(`Unsafe integer arithmetic: ${a} + ${b}`);
  return r;
}

/** Test/seed helper: whole or fractional rupees → paise. Never used on user input. */
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
