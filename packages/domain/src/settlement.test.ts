import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  amountDueNow,
  buyingLimitMinor,
  canExtend,
  endOfDayIst,
  isDefaulted,
  pickRunnerUp,
  SETTLEMENT_RULES,
  settlementStage,
  settlementTerms,
} from "./settlement";

const H = 3_600_000;
// 14 Oct 2026 20:00 IST
const CLOSE = Date.UTC(2026, 9, 14, 14, 30);

describe("settlement terms", () => {
  it("matches the worked example in docs/settlement.md", () => {
    const t = settlementTerms({
      priceMinor: 12_500_000,
      depositHeldMinor: 1_500_000,
      startAt: CLOSE,
    });
    expect(t.initialTargetMinor).toBe(3_125_000);
    expect(t.initialDueMinor).toBe(1_625_000); // ₹16,250
    expect(t.feeMinor).toBe(250_000); // ₹2,500
    expect(t.gstMinor).toBe(45_000); // ₹450
    expect(t.payableMinor - t.initialDueMinor).toBe(9_670_000); // ₹96,700 balance
    expect(t.totalMinor).toBe(12_795_000); // ₹1,27,950
    expect(t.initialDeadline).toBe(CLOSE + 24 * H);
    // Day 15 after 14 Oct = 29 Oct, 23:59:59.999 IST
    expect(new Date(t.balanceDeadline).toISOString()).toBe("2026-10-29T18:29:59.999Z");
  });

  it("a deposit larger than 25% leaves nothing due at the first stage", () => {
    const t = settlementTerms({
      priceMinor: 3_400_000,
      depositHeldMinor: 1_000_000,
      startAt: CLOSE,
    });
    expect(t.initialDueMinor).toBe(0);
    expect(settlementStage(t, 0)).toBe("AWAITING_BALANCE");
  });

  it("refuses non-positive prices and negative deposits", () => {
    expect(() => settlementTerms({ priceMinor: 0, depositHeldMinor: 0, startAt: CLOSE })).toThrow();
    expect(() =>
      settlementTerms({ priceMinor: 100, depositHeldMinor: -1, startAt: CLOSE }),
    ).toThrow();
  });

  it("property: the money always adds up and deadlines are ordered", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
        (price, deposit, start) => {
          const t = settlementTerms({
            priceMinor: price,
            depositHeldMinor: deposit,
            startAt: start,
          });
          expect(t.depositAppliedMinor + t.payableMinor).toBe(t.totalMinor);
          expect(t.totalMinor).toBe(price + t.feeMinor + t.gstMinor);
          expect(t.initialDueMinor + t.depositAppliedMinor).toBeGreaterThanOrEqual(
            Math.min(t.initialTargetMinor, t.totalMinor),
          );
          expect(t.initialDueMinor).toBeLessThanOrEqual(t.payableMinor);
          expect(t.initialTargetMinor * 4).toBeGreaterThanOrEqual(price);
          expect(t.balanceDeadline).toBeGreaterThan(t.initialDeadline);
          expect(t.balanceDeadline - start).toBeLessThanOrEqual(16 * 24 * H);
          expect(t.balanceDeadline - start).toBeGreaterThan(15 * 24 * H - 1);
        },
      ),
    );
  });
});

describe("stage and amount due", () => {
  const t = settlementTerms({
    priceMinor: 12_500_000,
    depositHeldMinor: 1_500_000,
    startAt: CLOSE,
  });

  it("moves through the stages as payments are verified", () => {
    expect(amountDueNow(t, 0)).toEqual({
      stage: "AWAITING_INITIAL",
      dueMinor: 1_625_000,
      deadline: t.initialDeadline,
    });
    expect(amountDueNow(t, 1_000_000).dueMinor).toBe(625_000);
    expect(amountDueNow(t, 1_625_000)).toEqual({
      stage: "AWAITING_BALANCE",
      dueMinor: 9_670_000,
      deadline: t.balanceDeadline,
    });
    expect(amountDueNow(t, t.payableMinor)).toEqual({ stage: "PAID", dueMinor: 0, deadline: null });
  });

  it("an extension moves only the current deadline", () => {
    expect(amountDueNow(t, 0, 6 * H).deadline).toBe(t.initialDeadline + 6 * H);
  });
});

describe("defaults", () => {
  it("defaults only after the deadline and only without a timely pending report", () => {
    expect(isDefaulted({ deadline: 1000, now: 1000, pendingReportedBeforeDeadline: false })).toBe(
      false,
    );
    expect(isDefaulted({ deadline: 1000, now: 1001, pendingReportedBeforeDeadline: false })).toBe(
      true,
    );
    expect(isDefaulted({ deadline: 1000, now: 9999, pendingReportedBeforeDeadline: true })).toBe(
      false,
    );
    expect(isDefaulted({ deadline: null, now: 9999, pendingReportedBeforeDeadline: false })).toBe(
      false,
    );
  });
});

describe("end of day in IST", () => {
  it("is 23:59:59.999 IST whatever the time of day", () => {
    for (const hour of [0, 5, 12, 18, 23]) {
      const t = Date.UTC(2026, 9, 20, hour) - 5.5 * H + 30 * 60_000; // hour:30 IST on 20 Oct
      expect(new Date(endOfDayIst(t)).toISOString()).toBe("2026-10-20T18:29:59.999Z");
    }
  });
});

describe("buying limit, extensions and the runner-up", () => {
  it("buying limit is 10× the deposit held", () => {
    expect(buyingLimitMinor(1_000_000)).toBe(10_000_000);
    expect(buyingLimitMinor(0)).toBe(0);
  });

  it("allows one extension of up to 72 hours", () => {
    expect(canExtend(0, 72 * H)).toBe(true);
    expect(canExtend(0, 72 * H + 1)).toBe(false);
    expect(canExtend(0, 0)).toBe(false);
    expect(canExtend(H, H)).toBe(false);
    expect(SETTLEMENT_RULES.maxExtensionMs).toBe(72 * H);
  });

  it("picks the highest eligible bidder who meets the reserve", () => {
    const bidders = [
      { userId: "winner", highestMinor: 900 },
      { userId: "b", highestMinor: 800 },
      { userId: "c", highestMinor: 700 },
    ];
    expect(pickRunnerUp(bidders, new Set(["winner"]), null)?.userId).toBe("b");
    expect(pickRunnerUp(bidders, new Set(["winner", "b"]), null)?.userId).toBe("c");
    expect(pickRunnerUp(bidders, new Set(["winner"]), 850)).toBeNull();
    expect(pickRunnerUp([], new Set(), null)).toBeNull();
  });
});
