import type { CatalogueFilters } from "./catalogue";

/** Engine-size presets common in Indian two-wheeler listings. */
export const CC_BANDS = [
  { label: "Up to 125 cc", hint: "scooters and commuters", min: 0, max: 125 },
  { label: "126–200 cc", hint: "premium commuters", min: 126, max: 200 },
  { label: "201–400 cc", hint: "mid-size", min: 201, max: 400 },
  { label: "400 cc+", hint: "large", min: 401, max: 2500 },
] as const;

type Search = Partial<Record<keyof CatalogueFilters, string | number | undefined>>;

/** One removable chip per active filter (ranges collapse into one chip). */
export function activeFilterChips(
  s: Search,
): { label: string; clear: Partial<CatalogueFilters> }[] {
  const out: { label: string; clear: Partial<CatalogueFilters> }[] = [];
  const inr = (n: string | number) => `₹${Number(n).toLocaleString("en-IN")}`;
  const range = (lo: unknown, hi: unknown, fmt: (n: string | number) => string) =>
    lo !== undefined && hi !== undefined
      ? `${fmt(lo as number)}–${fmt(hi as number)}`
      : lo !== undefined
        ? `from ${fmt(lo as number)}`
        : `up to ${fmt(hi as number)}`;
  if (s.q) out.push({ label: `“${s.q}”`, clear: { q: undefined } });
  if (s.make) out.push({ label: String(s.make), clear: { make: undefined } });
  if (s.city) out.push({ label: String(s.city), clear: { city: undefined } });
  if (s.yearMin !== undefined || s.yearMax !== undefined)
    out.push({
      label: `Year ${range(s.yearMin, s.yearMax, String)}`,
      clear: { yearMin: undefined, yearMax: undefined },
    });
  if (s.ccMin !== undefined || s.ccMax !== undefined) {
    const band = CC_BANDS.find((b) => b.min === s.ccMin && b.max === s.ccMax);
    out.push({
      label: band ? band.label : `${range(s.ccMin, s.ccMax, String)} cc`,
      clear: { ccMin: undefined, ccMax: undefined },
    });
  }
  if (s.priceMin !== undefined || s.priceMax !== undefined)
    out.push({
      label: `Price ${range(s.priceMin, s.priceMax, inr)}`,
      clear: { priceMin: undefined, priceMax: undefined },
    });
  return out;
}
