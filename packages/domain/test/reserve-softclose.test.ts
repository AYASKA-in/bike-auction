import { PublicAuctionView } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, tick, toPublicView } from "../src";
import { bid, CLOSE, expectOk, live, MIN, START } from "./helpers";

describe("hidden reserve", () => {
  const RESERVE = 8_123_457; // distinctive digits so a substring search cannot false-positive

  it("NO_BIDS when nobody bid: no winner (invariant K)", () => {
    const ended = tick(live({ reserveMinor: RESERVE }), CLOSE).state;
    expect(ended).toMatchObject({ outcome: "NO_BIDS", winnerUserId: null });
  });

  it("RESERVE_NOT_MET when the top bid is below the reserve: no winner", () => {
    const s = expectOk(bid(live({ reserveMinor: RESERVE }), "u1", 7_999_900, START + 1)).state;
    const r = tick(s, CLOSE);
    expect(r.state).toMatchObject({ outcome: "RESERVE_NOT_MET", winnerUserId: null });
    expect(r.events).toMatchObject([
      { type: "auction.ended", outcome: "RESERVE_NOT_MET", winnerUserId: null },
    ]);
  });

  it("SOLD when the top bid meets the reserve exactly", () => {
    let s = expectOk(bid(live({ reserveMinor: RESERVE }), "u1", 5_000_000, START + 1)).state;
    const r = expectOk(bid(s, "u2", RESERVE, START + 2));
    expect(r.events.at(-1)).toMatchObject({ type: "bid.accepted", reserveMet: true });
    s = tick(r.state, CLOSE).state;
    expect(s).toMatchObject({ outcome: "SOLD", winnerUserId: "u2" });
  });

  it("SOLD with no reserve configured", () => {
    const s = expectOk(bid(live(), "u1", 5_000_000, START + 1)).state;
    expect(tick(s, CLOSE).state).toMatchObject({ outcome: "SOLD", winnerUserId: "u1" });
  });

  it("the public view never contains the reserve amount or user ids (invariant I)", () => {
    const s = expectOk(
      bid(live({ reserveMinor: RESERVE }), "user-secret-id", 5_000_000, START + 1),
    ).state;
    const view = toPublicView(s, {
      leaderPseudonym: "Bidder K7Q2",
      viewerUserId: "user-secret-id",
    });
    expect(PublicAuctionView.parse(view)).toEqual(view); // strict schema: unknown keys fail
    const json = JSON.stringify(view);
    expect(json).not.toContain(String(RESERVE));
    expect(json).not.toContain("user-secret-id");
    expect(
      Object.keys(view)
        .filter((k) => /reserve/i.test(k))
        .sort(),
    ).toEqual(["hasReserve", "reserveMet"]);
    expect(view).toMatchObject({
      hasReserve: true,
      reserveMet: false,
      viewer: { isLeading: true, isWinner: false },
    });
  });

  it("strict contract rejects a view that leaks a reserve field", () => {
    const view = toPublicView(live({ reserveMinor: RESERVE }), {
      leaderPseudonym: null,
      viewerUserId: null,
    });
    expect(PublicAuctionView.safeParse({ ...view, reserveMinor: RESERVE }).success).toBe(false);
  });
});

describe("bounded soft close (BLUEPRINT §4.5)", () => {
  // Window 2 min, extension 2 min, cap 30 min after the original close.
  const remaining = (ms: number) => CLOSE - ms;
  const cases: [string, number, number | null][] = [
    ["more than two minutes before close", remaining(2 * MIN + 1), null],
    ["exactly two minutes before close (window is exclusive)", remaining(2 * MIN), null],
    ["1 ms inside the window", remaining(2 * MIN - 1), remaining(2 * MIN - 1) + 2 * MIN],
    ["1 ms before close", CLOSE - 1, CLOSE - 1 + 2 * MIN],
  ];
  it.each(cases)("bid %s", (_label, now, expectedClose) => {
    const r = expectOk(bid(live(), "u1", 5_000_000, now));
    if (expectedClose === null) {
      expect(r.state.closesAt).toBe(CLOSE);
      expect(r.events.map((e) => e.type)).toEqual(["bid.accepted"]);
    } else {
      expect(r.state).toMatchObject({ closesAt: expectedClose, extensionCount: 1 });
      expect(r.events.map((e) => [e.type, e.seq])).toEqual([
        ["bid.accepted", 4],
        ["auction.extended", 5],
      ]);
    }
  });

  it("a bid exactly at close is rejected and never extends", () => {
    expect(bid(live(), "u1", 5_000_000, CLOSE)).toMatchObject({
      ok: false,
      error: { code: "AUCTION_ENDED" },
    });
  });

  it("successive extensions approach and stop at hardCloseAt; then the auction must end", () => {
    let s = live();
    const hard = s.hardCloseAt;
    expect(hard).toBe(CLOSE + 30 * MIN);
    let users = 0;
    let extensions = 0;
    // Each bid lands 1 s before the current close.
    while (s.closesAt - 1000 >= START) {
      const now = s.closesAt - 1000;
      const r = bid(
        s,
        `u${users++ % 2}`,
        s.currentPriceMinor === null ? s.startPriceMinor : s.currentPriceMinor + 100_000,
        now,
      );
      if (!r.ok) throw new Error(r.error.code);
      if (r.events.some((e) => e.type === "auction.extended")) extensions++;
      expect(r.state.closesAt).toBeLessThanOrEqual(hard); // invariant G
      s = r.state;
      if (s.closesAt === hard) break; // cap reached
    }
    expect(s.closesAt).toBe(hard);
    expect(extensions).toBe(s.extensionCount);
    // Each bid lands 1 s before close, so each extension adds 119 s; the last is clipped to the cap.
    expect(extensions).toBe(Math.ceil((30 * MIN) / (2 * MIN - 1000)));
    // At the cap, a bid inside the window is accepted but does not extend.
    const next = s.leaderUserId === "u0" ? "u1" : "u0";
    const atCap = expectOk(bid(s, next, s.currentPriceMinor! + 100_000, hard - 1000));
    expect(atCap.events.map((e) => e.type)).toEqual(["bid.accepted"]);
    // After the hard close: rejected, auction ends (termination).
    expect(bid(atCap.state, "uX", 999_000_000, hard)).toMatchObject({
      ok: false,
      error: { code: "AUCTION_ENDED" },
    });
    expect(tick(atCap.state, hard).state.status).toBe("ENDED");
  });

  it("the final extension is clipped to hardCloseAt", () => {
    let s = live();
    s = { ...s, closesAt: s.hardCloseAt - 30_000 }; // 30 s left before the cap
    const r = expectOk(bid(s, "u1", 5_000_000, s.closesAt - 1000));
    expect(r.state.closesAt).toBe(s.hardCloseAt);
  });

  it("soft close can be disabled per auction", () => {
    const r = expectOk(
      bid(live({ rules: { ...DEFAULT_RULES, softClose: null } }), "u1", 5_000_000, CLOSE - 1),
    );
    expect(r.state.closesAt).toBe(CLOSE);
    expect(r.state.hardCloseAt).toBe(CLOSE);
  });
});
