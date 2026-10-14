import { describe, expect, it } from "vitest";
import {
  duration,
  formatEndsAt,
  formatExtension,
  formatISTClock,
  formatISTFull,
  formatKm,
  istLocalToIso,
  isoToIstLocal,
  ownersLabel,
  relativeTime,
} from "./format";

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

describe("live page formatting", () => {
  const t = Date.UTC(2026, 9, 14, 16, 12, 5); // 14 Oct 2026, 9:42:05 PM IST
  it("relative time against a server-corrected now", () => {
    expect(relativeTime(t, t)).toBe("just now");
    expect(relativeTime(t, t - 3_000)).toBe("just now"); // event slightly in the future (skew)
    expect(relativeTime(t, t + 9_999)).toBe("just now");
    expect(relativeTime(t, t + 10_000)).toBe("10s ago");
    expect(relativeTime(t, t + 59_999)).toBe("59s ago");
    expect(relativeTime(t, t + 60_000)).toBe("1 min ago");
    expect(relativeTime(t, t + 2 * 60_000 + 30_000)).toBe("2 min ago");
    expect(relativeTime(t, t + 59 * 60_000)).toBe("59 min ago");
    expect(relativeTime(t, t + 3 * 3600_000)).toBe("3 h ago");
    expect(relativeTime(t, t + 50 * 3600_000)).toBe("2 d ago");
  });
  it("absolute end time in IST, with the date only when it isn't today (IST)", () => {
    expect(formatISTClock(t)).toBe("9:42 PM IST");
    expect(formatEndsAt(t, Date.UTC(2026, 9, 14, 4, 0))).toBe("9:42 PM IST");
    expect(formatEndsAt(t, Date.UTC(2026, 9, 13, 10, 0))).toBe("Wed, 14 Oct, 9:42 PM IST");
    // 00:10 IST on the 15th vs 23:50 IST on the 14th: same UTC day, different IST day.
    expect(formatEndsAt(Date.UTC(2026, 9, 14, 18, 40), Date.UTC(2026, 9, 14, 18, 20))).toBe(
      "Thu, 15 Oct, 12:10 AM IST",
    );
    expect(formatISTFull(t)).toBe("14 Oct 2026, 9:42:05 PM IST");
  });
  it("extension chip labels", () => {
    expect(formatExtension(120_000)).toBe("+2:00");
    expect(formatExtension(45_400)).toBe("+0:45");
    expect(formatExtension(61_000)).toBe("+1:01");
    expect(formatExtension(-5)).toBe("+0:00");
  });
});
