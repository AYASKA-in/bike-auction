import { describe, expect, it } from "vitest";
import { activeFilterChips, CC_BANDS } from "./catalogue-filters";

describe("activeFilterChips", () => {
  it("is empty without filters", () => {
    expect(activeFilterChips({})).toEqual([]);
  });
  it("collapses ranges, names cc bands, formats rupees, and clears both ends", () => {
    const chips = activeFilterChips({
      q: "classic",
      make: "Honda",
      yearMin: 2020,
      ccMin: CC_BANDS[1].min,
      ccMax: CC_BANDS[1].max,
      priceMax: 150000,
    });
    expect(chips.map((c) => c.label)).toEqual([
      "“classic”",
      "Honda",
      "Year from 2020",
      "126–200 cc",
      "Price up to ₹1,50,000",
    ]);
    expect(chips[3]!.clear).toEqual({ ccMin: undefined, ccMax: undefined });
  });
  it("labels custom cc ranges", () => {
    expect(activeFilterChips({ ccMin: 100, ccMax: 300 })[0]!.label).toBe("100–300 cc");
  });
});
