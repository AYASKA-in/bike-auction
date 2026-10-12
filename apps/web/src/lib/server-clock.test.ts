import { describe, expect, it } from "vitest";
import { bestSample, computeOffset, formatIST } from "./server-clock";

describe("server clock", () => {
  it("computes offset from the midpoint of the round trip", () => {
    // Device is 500 ms behind the server; request took 100 ms.
    expect(computeOffset(1_000, 1_550, 1_100)).toEqual({
      offsetMs: 500,
      rttMs: 100,
      sampledAt: 1_100,
    });
  });
  it("prefers the lowest-RTT sample", () => {
    const a = computeOffset(0, 1_000, 400);
    const b = computeOffset(0, 1_000, 40);
    expect(bestSample([a, b])).toBe(b);
    expect(bestSample([])).toBeNull();
  });
  it("formats in IST regardless of device time zone", () => {
    expect(formatIST(Date.UTC(2026, 9, 12, 16, 0, 5))).toBe("21:30:05");
  });
});
