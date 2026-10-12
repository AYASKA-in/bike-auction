import { describe, expect, it } from "vitest";
import { duration, formatKm, istLocalToIso, isoToIstLocal, ownersLabel } from "./format";

describe("format", () => {
  it("durations", () => {
    expect(duration(45_000)).toBe("45s");
    expect(duration(125_000)).toBe("2m 05s");
    expect(duration(2 * 3600_000 + 5 * 60_000)).toBe("2h 05m");
    expect(duration(3 * 86400_000 + 4 * 3600_000)).toBe("3d 4h");
    expect(duration(-5)).toBe("0s");
  });
  it("Indian grouping and owners", () => {
    expect(formatKm(124500)).toBe("1,24,500 km");
    expect(ownersLabel(2)).toBe("2nd owner");
  });
  it("IST datetime-local round trip", () => {
    const iso = istLocalToIso("2026-10-14T18:30");
    expect(Date.parse(iso)).toBe(Date.UTC(2026, 9, 14, 13, 0));
    expect(isoToIstLocal(Date.parse(iso))).toBe("2026-10-14T18:30");
  });
});
