import type { Settlement } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { breakdown, needsAction, progressSteps, STATUS_LABEL } from "./settlement";

const base: Settlement = {
  id: "stl_x_1",
  auctionId: "auc_x",
  attempt: 1,
  title: "2021 Honda Activa 6G",
  bikeId: "bike_x",
  coverUrl: null,
  status: "AWAITING_INITIAL",
  priceMinor: 12_500_000,
  feeMinor: 250_000,
  gstMinor: 45_000,
  totalMinor: 12_795_000,
  depositMinor: 1_500_000,
  initialDueMinor: 1_625_000,
  payableMinor: 11_295_000,
  paidMinor: 0,
  reportedMinor: 0,
  dueNowMinor: 1_625_000,
  dueBy: 1_000,
  startAt: 0,
  initialDeadline: 1_000,
  balanceDeadline: 2_000,
  offerExpiresAt: null,
  extensionMs: 0,
  gatePass: null,
  refundDueMinor: 0,
  refundedAt: null,
  closedReason: null,
  nextStep: null,
  updatedAt: 0,
  payments: [],
};

describe("settlement helpers", () => {
  it("needs action while something is due or an offer waits", () => {
    expect(needsAction(base)).toBe(true);
    expect(needsAction({ ...base, status: "OFFERED" })).toBe(true);
    expect(needsAction({ ...base, status: "AWAITING_BALANCE", dueNowMinor: 0 })).toBe(false);
    expect(needsAction({ ...base, status: "PAID", dueNowMinor: 0 })).toBe(false);
    expect(needsAction({ ...base, status: "DEFAULTED" })).toBe(false);
  });

  it("progress line marks done / current / todo", () => {
    expect(progressSteps(base).map((s) => s.state)).toEqual(["current", "todo", "todo"]);
    expect(progressSteps({ ...base, status: "AWAITING_BALANCE" }).map((s) => s.state)).toEqual([
      "done",
      "current",
      "todo",
    ]);
    expect(progressSteps({ ...base, status: "PAID" }).map((s) => s.state)).toEqual([
      "done",
      "done",
      "current",
    ]);
  });

  it("breakdown shows the fee, GST, the deposit counted and verified payments", () => {
    const rows = breakdown({ ...base, paidMinor: 1_625_000 });
    expect(rows.map((r) => r.label)).toEqual([
      "Winning bid",
      "Buyer fee (2%)",
      "GST on the fee (18%)",
      "Total",
      "Your deposit, counted",
      "Paid and verified",
    ]);
    expect(rows.find((r) => r.label === "Total")?.value).toBe("₹1,27,950");
    expect(
      breakdown({ ...base, depositMinor: 0 }).some((r) => r.label.startsWith("Your deposit")),
    ).toBe(false);
  });

  it("every status has a plain-words label", () => {
    expect(STATUS_LABEL.AWAITING_INITIAL).toBe("Pay 25%");
    expect(Object.keys(STATUS_LABEL)).toHaveLength(9);
  });
});
