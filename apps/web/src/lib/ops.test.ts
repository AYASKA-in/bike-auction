import { describe, expect, it } from "vitest";
import {
  actionLabel,
  AuditSearch,
  auditQueryString,
  formatAge,
  healthOfOps,
  istDayStart,
  metadataSummary,
  type AuctionOps,
} from "./ops";

const ops = (over: Partial<AuctionOps> = {}): AuctionOps => ({
  seq: 5,
  projectedSeq: 5,
  pendingOutbox: 0,
  oldestPendingAgeMs: null,
  sync: { lastAttemptAt: 1, lastSuccessAt: 1, consecutiveFailures: 0, lastError: null },
  connections: 0,
  timers: [],
  ...over,
});

describe("admin ops helpers", () => {
  it("audit search drops invalid values instead of failing the page", () => {
    expect(
      AuditSearch.parse({
        action: "drop table",
        actorId: "ok_id",
        resourceId: "auc_1",
        fromDay: "2026-13",
        toDay: "2026-10-12",
      }),
    ).toEqual({ actorId: "ok_id", resourceId: "auc_1", toDay: "2026-10-12" });
  });

  it("date range is IST calendar days, inclusive of the 'to' day", () => {
    const from = istDayStart("2026-10-12")!;
    expect(new Date(from).toISOString()).toBe("2026-10-11T18:30:00.000Z");
    const q = new URLSearchParams(
      auditQueryString(
        {
          action: "AUCTION_CANCELLED",
          resourceId: "auc_1",
          fromDay: "2026-10-12",
          toDay: "2026-10-12",
        },
        "123_aud_x",
        25,
      ),
    );
    expect(Object.fromEntries(q)).toEqual({
      action: "AUCTION_CANCELLED",
      resourceId: "auc_1",
      from: String(from),
      to: String(from + 86_400_000),
      cursor: "123_aud_x",
      limit: "25",
    });
  });

  it("labels and summaries", () => {
    expect(actionLabel("PROJECTION_RETRIED")).toBe("Projection retried");
    expect(metadataSummary({ reason: "Seller withdrew", fields: ["closesAt", "terms"] })).toBe(
      "reason: Seller withdrew · fields: closesAt, terms",
    );
    expect(metadataSummary({ long: "x".repeat(400) }).length).toBe(160);
  });

  it("health mirrors the server rule; ages are compact; null is never shown as 0", () => {
    expect(healthOfOps(ops())).toBe("ok");
    expect(healthOfOps(ops({ pendingOutbox: 2, oldestPendingAgeMs: 6_000 }))).toBe("lagging");
    expect(
      healthOfOps(
        ops({
          sync: { lastAttemptAt: 1, lastSuccessAt: 1, consecutiveFailures: 1, lastError: "x" },
        }),
      ),
    ).toBe("failing");
    expect(formatAge(null)).toBe("–");
    expect(formatAge(850)).toBe("850 ms");
    expect(formatAge(4_200)).toBe("4.2 s");
    expect(formatAge(180_000)).toBe("3 min");
  });
});
