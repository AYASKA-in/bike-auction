import { describe, expect, it } from "vitest";
import { createAuction, DEFAULT_RULES, ManualClock, systemClock, type AuctionRules } from "../src";
import { CLOSE, START, T0 } from "./helpers";

const make = (rules: AuctionRules) =>
  createAuction({
    auctionId: "auc-cfg",
    startPriceMinor: 100_000,
    startsAt: START,
    closesAt: CLOSE,
    rules,
    now: T0,
  });

describe("rule validation (admin-configurable guards)", () => {
  it.each<[string, AuctionRules]>([
    ["empty ladder", { ...DEFAULT_RULES, ladder: [] }],
    [
      "non-monotonic ladder",
      {
        ...DEFAULT_RULES,
        ladder: [
          { upToMinor: 10, incrementMinor: 1 },
          { upToMinor: 5, incrementMinor: 1 },
          { upToMinor: null, incrementMinor: 1 },
        ],
      },
    ],
    ["zero increment", { ...DEFAULT_RULES, ladder: [{ upToMinor: null, incrementMinor: 0 }] }],
    [
      "multiplier below 1",
      { ...DEFAULT_RULES, limits: { ...DEFAULT_RULES.limits, maxMultiplier: 0 } },
    ],
    [
      "fractional multiplier",
      { ...DEFAULT_RULES, limits: { ...DEFAULT_RULES.limits, maxMultiplier: 1.5 } },
    ],
    [
      "ceiling above platform max",
      { ...DEFAULT_RULES, limits: { ...DEFAULT_RULES.limits, maxAmountMinor: 2_000_000_000 } },
    ],
    [
      "negative soft-close duration",
      { ...DEFAULT_RULES, softClose: { windowMs: -1, extensionMs: 1, maxTotalExtensionMs: 1 } },
    ],
    [
      "zero soft-close window",
      { ...DEFAULT_RULES, softClose: { windowMs: 0, extensionMs: 1, maxTotalExtensionMs: 1 } },
    ],
    [
      "unbounded total extension",
      {
        ...DEFAULT_RULES,
        softClose: { windowMs: 1, extensionMs: 1, maxTotalExtensionMs: 25 * 3_600_000 },
      },
    ],
  ])("rejects %s", (_label, rules) => {
    expect(make(rules)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("start price above a per-auction ceiling is rejected", () => {
    const rules = { ...DEFAULT_RULES, limits: { ...DEFAULT_RULES.limits, maxAmountMinor: 50_000 } };
    expect(make(rules).ok).toBe(false);
  });

  it("reserve above the ceiling is rejected", () => {
    const r = createAuction({
      auctionId: "auc-cfg",
      startPriceMinor: 100,
      reserveMinor: 2_000_000_000,
      startsAt: START,
      closesAt: CLOSE,
      now: T0,
    });
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });
});

describe("clocks", () => {
  it("ManualClock is deterministic; systemClock reads real time (infrastructure only)", () => {
    const c = new ManualClock(1_000);
    c.advance(500);
    expect(c.now()).toBe(1_500);
    c.set(42);
    expect(c.now()).toBe(42);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1_000);
  });
});
