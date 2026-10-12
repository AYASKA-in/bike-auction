import { describe, expect, it } from "vitest";
import {
  cancel,
  createAuction,
  DomainInvariantError,
  isTerminal,
  schedule,
  tick,
  updateTerms,
} from "../src";
import { bid, CLOSE, draft, expectOk, live, MIN, START, T0 } from "./helpers";

describe("creation and validation", () => {
  it("creates a DRAFT with seq 1 and an auction.created event", () => {
    const r = expectOk(
      createAuction({
        auctionId: "auc-1",
        startPriceMinor: 100,
        startsAt: START,
        closesAt: CLOSE,
        now: T0,
      }),
    );
    expect(r.state).toMatchObject({
      status: "DRAFT",
      seq: 1,
      closesAt: CLOSE,
      hardCloseAt: CLOSE + 30 * MIN,
    });
    expect(r.events.map((e) => [e.type, e.seq])).toEqual([["auction.created", 1]]);
  });

  it.each([
    ["bad id", { auctionId: "a:b" }],
    ["zero start price", { startPriceMinor: 0 }],
    ["fractional start price", { startPriceMinor: 10.5 }],
    ["reserve below start", { startPriceMinor: 1000, reserveMinor: 999 }],
    ["closes before it starts", { closesAt: START - 1 }],
    ["shorter than a minute", { closesAt: START + MIN - 1 }],
    ["longer than 30 days", { closesAt: START + 31 * 24 * 60 * MIN }],
    ["non-integer time", { startsAt: START + 0.5 }],
  ])("rejects %s", (_label, override) => {
    const r = createAuction({
      auctionId: "auc-1",
      startPriceMinor: 100,
      startsAt: START,
      closesAt: CLOSE,
      now: T0,
      ...override,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION_FAILED");
    expect(r.events).toEqual([]);
  });

  it("treats a non-integer `now` as a programming error, not a business rejection", () => {
    expect(() => tick(draft(), Number.NaN)).toThrow(DomainInvariantError);
    expect(() => tick(draft(), 1.5)).toThrow(DomainInvariantError);
  });
});

describe("scheduling and start", () => {
  it("DRAFT → SCHEDULED, then starts exactly at startsAt (boundary −1 / 0 / +1 ms)", () => {
    const s = expectOk(schedule(draft(), T0)).state;
    expect(s.status).toBe("SCHEDULED");
    expect(tick(s, START - 1).events).toEqual([]);
    const at = tick(s, START);
    expect(at.state.status).toBe("LIVE");
    expect(at.events).toMatchObject([{ type: "auction.started", startedAt: START, seq: 3 }]);
    expect(tick(s, START + 1).state.status).toBe("LIVE");
  });

  it("scheduling after startsAt starts immediately in the same transition", () => {
    const r = expectOk(schedule(draft(), START + 5));
    expect(r.events.map((e) => e.type)).toEqual(["auction.scheduled", "auction.started"]);
    expect(r.state.status).toBe("LIVE");
  });

  it("cannot schedule twice or after the close time has passed", () => {
    const s = expectOk(schedule(draft(), T0)).state;
    expect(schedule(s, T0)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    expect(schedule(draft(), CLOSE)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("a delayed alarm: first observation long after close yields started then ended, in order", () => {
    const s = expectOk(schedule(draft(), T0)).state;
    const r = tick(s, CLOSE + 10 * MIN);
    expect(r.events.map((e) => [e.type, e.seq])).toEqual([
      ["auction.started", 3],
      ["auction.ended", 4],
    ]);
    expect(r.state).toMatchObject({ status: "ENDED", outcome: "NO_BIDS", endedAt: CLOSE });
  });
});

describe("closing", () => {
  it("closes exactly at closesAt (boundary −1 / 0 / +1 ms) and records the authoritative end time", () => {
    const s = live();
    expect(tick(s, CLOSE - 1).state.status).toBe("LIVE");
    const at = tick(s, CLOSE);
    expect(at.state).toMatchObject({ status: "ENDED", endedAt: CLOSE });
    expect(tick(s, CLOSE + 1).state.endedAt).toBe(CLOSE);
  });

  it("repeated ticks never emit a second terminal event (invariant L)", () => {
    const ended = tick(live(), CLOSE).state;
    for (const t of [CLOSE, CLOSE + 1, CLOSE + 10 * MIN, CLOSE + 365 * 24 * 60 * MIN]) {
      expect(tick(ended, t)).toEqual({ state: ended, events: [] });
    }
  });
});

describe("cancellation", () => {
  it.each(["DRAFT", "SCHEDULED", "LIVE"] as const)("cancels from %s with a reason", (from) => {
    const s =
      from === "DRAFT"
        ? draft()
        : from === "SCHEDULED"
          ? expectOk(schedule(draft(), T0)).state
          : live();
    const now = from === "LIVE" ? START + 1 : T0;
    const r = expectOk(cancel(s, { reason: "  Wrong odometer reading  ", now }));
    expect(r.state).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Wrong odometer reading",
      winnerUserId: null,
    });
    expect(r.events.at(-1)).toMatchObject({ type: "auction.cancelled", previousStatus: from });
  });

  it("requires a meaningful reason", () => {
    expect(cancel(draft(), { reason: "  x ", now: T0 })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(cancel(draft(), { reason: "y".repeat(501), now: T0 }).ok).toBe(false);
  });

  it("cannot cancel an auction whose close time has passed, even if nobody closed it yet", () => {
    const r = cancel(live(), { reason: "Too late", now: CLOSE });
    expect(r).toMatchObject({ ok: false, error: { code: "AUCTION_ENDED" } });
    expect(r.state.status).toBe("ENDED"); // the lifecycle event is still returned for commit
    expect(r.events.map((e) => e.type)).toEqual(["auction.ended"]);
  });

  it("ENDED and CANCELLED are terminal (invariant F)", () => {
    const ended = tick(live(), CLOSE).state;
    const cancelled = expectOk(cancel(live(), { reason: "Duplicate listing", now: START })).state;
    for (const s of [ended, cancelled]) {
      expect(isTerminal(s)).toBe(true);
      expect(schedule(s, T0).ok).toBe(false);
      expect(cancel(s, { reason: "again please", now: CLOSE + 1 }).ok).toBe(false);
      expect(updateTerms(s, { startPriceMinor: 200 }, CLOSE + 1).ok).toBe(false);
      expect(bid(s, "u1", 9_000_000, CLOSE + 1).ok).toBe(false);
      expect(tick(s, CLOSE + 99 * MIN).events).toEqual([]);
    }
    expect(bid(cancelled, "u1", 9_000_000, START + 1)).toMatchObject({
      error: { code: "AUCTION_CANCELLED" },
    });
    expect(bid(ended, "u1", 9_000_000, CLOSE + 1)).toMatchObject({
      error: { code: "AUCTION_ENDED" },
    });
  });
});

describe("editing terms", () => {
  it("allows reserve and price changes before the auction is live", () => {
    const r = expectOk(
      updateTerms(draft(), { reserveMinor: 8_000_000, startPriceMinor: 6_000_000 }, T0),
    );
    expect(r.state).toMatchObject({ reserveMinor: 8_000_000, startPriceMinor: 6_000_000 });
    expect(r.events).toMatchObject([
      { type: "auction.updated", fields: ["reserveMinor", "startPriceMinor"] },
    ]);
    expect(
      expectOk(updateTerms(r.state, { reserveMinor: null }, T0)).state.reserveMinor,
    ).toBeNull();
  });

  it("recomputes hardCloseAt when the close time changes", () => {
    const r = expectOk(updateTerms(draft(), { closesAt: CLOSE + 10 * MIN }, T0));
    expect(r.state.hardCloseAt).toBe(CLOSE + 40 * MIN);
  });

  it("rejects edits once the start time has passed, even without an alarm", () => {
    const scheduled = expectOk(schedule(draft(), T0)).state;
    const r = updateTerms(scheduled, { reserveMinor: 9_000_000 }, START);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    expect(r.state.status).toBe("LIVE");
  });

  it("an empty patch is a no-op", () => {
    expect(expectOk(updateTerms(draft(), {}, T0)).events).toEqual([]);
  });

  it("moving startsAt into the past on a scheduled auction starts it", () => {
    const scheduled = expectOk(schedule(draft(), T0)).state;
    const r = expectOk(updateTerms(scheduled, { startsAt: T0 - MIN }, T0));
    expect(r.events.map((e) => e.type)).toEqual(["auction.updated", "auction.started"]);
  });

  it("rejects invalid edits", () => {
    expect(updateTerms(draft(), { reserveMinor: 1 }, T0)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    const scheduled = expectOk(
      schedule(draft({ startsAt: T0 + 2 * MIN, closesAt: T0 + 5 * MIN }), T0 + MIN),
    ).state;
    expect(
      updateTerms(scheduled, { startsAt: T0 - 10 * MIN, closesAt: T0 - 5 * MIN }, T0 + MIN).ok,
    ).toBe(false);
  });
});
