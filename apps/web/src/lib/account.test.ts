import { describe, expect, it } from "vitest";
import { confirmationMatches, deletionBlockers, exportFilename } from "./account";
import { ApiError } from "./api";

describe("account helpers", () => {
  it("delete confirmation must match the account email (case/space-insensitive)", () => {
    expect(confirmationMatches(" Asha@Example.org ", "asha@example.org")).toBe(true);
    expect(confirmationMatches("asha@example.or", "asha@example.org")).toBe(false);
    expect(confirmationMatches("", "")).toBe(false);
  });

  it("uses the server's safe filename, else a dated default", () => {
    expect(exportFilename('attachment; filename="bike-auction-data-2026-10-13.json"')).toBe(
      "bike-auction-data-2026-10-13.json",
    );
    expect(exportFilename('attachment; filename="../../etc/passwd"', new Date("2026-10-13"))).toBe(
      "bike-auction-data-2026-10-13.json",
    );
    expect(exportFilename(null, new Date("2026-01-02"))).toBe("bike-auction-data-2026-01-02.json");
  });

  it("reads deletion blockers only from a validated 409 extension", () => {
    const blockers = [{ auctionId: "a1", title: "RE Classic", reason: "LEADING_LIVE_AUCTION" }];
    const conflict = new ApiError(409, "CONFLICT", "x", "req", undefined, { blockers });
    expect(deletionBlockers(conflict)).toEqual(blockers);
    const junk = new ApiError(409, "CONFLICT", "x", "req", undefined, { blockers: [{ evil: 1 }] });
    expect(deletionBlockers(junk)).toEqual([]);
    expect(deletionBlockers(new ApiError(422, "VALIDATION_FAILED"))).toEqual([]);
    expect(deletionBlockers(new Error("x"))).toEqual([]);
  });
});
