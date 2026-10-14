/**
 * Property tests for proxy (automatic) bidding, BLUEPRINT §4.7.
 *
 * The REFERENCE MODEL restates the rules in closed form from the spec: after any command, every
 * bidder still in contention has a commitment (the leader: max(price, own maximum); others: their
 * maximum); the best commitment (tie → earliest) leads at min(best, max(minNext, second +
 * increment(second))), lifted to the reserve when the winner's maximum covers it. It has its own
 * increment table and shares no code with the engine. fast-check drives random interleavings of
 * manual bids, maxima, retries and time; after every step engine and model must agree, and the
 * committed log must satisfy the invariants listed in ADR 004 › Proxy bidding.
 *
 * Reproduce: FC_SEED=<seed> FC_PATH=<path> pnpm --filter @bike/domain test
 */
import { PublicAuctionEvent, PublicAuctionView } from "@bike/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareProxies,
  createAuction,
  DEFAULT_RULES,
  makeMaxIdempotencyRecord,
  maxBidFingerprint,
  minNextBidFor,
  placeBid,
  resolveIdempotency,
  schedule,
  setMaxBid,
  tick,
  toPublicEvent,
  toPublicView,
  type AuctionEvent,
  type AuctionState,
  type DomainErrorCode,
  type IdempotencyRecord,
  type StoredMaxBidResult,
} from "../src";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const CEILING = 1_000_000_000;
const SEED = Number(process.env.FC_SEED ?? 20261013);
const RUNS = Number(process.env.FC_RUNS ?? 300);
const PATH = process.env.FC_PATH;

// ───────────────────────────── reference model ─────────────────────────────

function inc(price: number): number {
  const rupees = price / 100;
  if (rupees < 25_000) return 25_000;
  if (rupees < 1_00_000) return 50_000;
  if (rupees <= 3_00_000) return 100_000;
  return 250_000;
}

type MProxy = { user: string; max: number; order: number };
type Model = {
  status: "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";
  start: number;
  reserve: number | null;
  startsAt: number;
  closesAt: number;
  hardCloseAt: number;
  softClose: boolean;
  price: number | null;
  leader: string | null;
  proxies: Map<string, MProxy>;
  order: number;
};

const mMin = (m: Model) => (m.price === null ? m.start : m.price + inc(m.price));
const mCeiling = (m: Model) => Math.min(CEILING, Math.max(mMin(m), (m.price ?? m.start) * 3));
function mResolve(m: Model, now: number) {
  if (m.status === "SCHEDULED" && now >= m.startsAt) m.status = "LIVE";
  if (m.status === "LIVE" && now >= m.closesAt) m.status = "ENDED";
}
function mSoftClose(m: Model, now: number) {
  if (m.softClose && m.closesAt - now < 2 * MIN)
    m.closesAt = Math.max(m.closesAt, Math.min(now + 2 * MIN, m.hardCloseAt));
}
const better = (a: { value: number; order: number }, b: { value: number; order: number }) =>
  a.value !== b.value ? b.value - a.value : a.order - b.order;

function mSettle(m: Model) {
  const min = mMin(m);
  const lp = m.leader === null ? undefined : m.proxies.get(m.leader);
  const lead =
    m.leader === null
      ? null
      : {
          user: m.leader,
          value: Math.max(m.price!, lp?.max ?? 0),
          // A manual commitment can never lose a tie (no other maximum can equal it and act).
          order: lp && lp.max >= m.price! ? lp.order : -1,
        };
  const cs = lead ? [lead] : [];
  for (const p of m.proxies.values()) {
    if (p.user === m.leader) continue;
    const beats = lead !== null && better({ value: p.max, order: p.order }, lead) < 0;
    if (p.max >= min || beats) cs.push({ user: p.user, value: p.max, order: p.order });
  }
  if (cs.length === 0) return;
  cs.sort(better);
  const [w, s] = [cs[0]!, cs[1]];
  let price = s
    ? Math.min(w.value, Math.max(min, s.value + inc(s.value)))
    : w.user === m.leader
      ? m.price!
      : min;
  const wMax = m.proxies.get(w.user)?.max;
  if (m.reserve !== null && wMax !== undefined && wMax >= m.reserve && price < m.reserve)
    price = m.reserve;
  m.leader = w.user;
  m.price = price;
}

function mStatusError(m: Model): DomainErrorCode | null {
  if (m.status === "CANCELLED") return "AUCTION_CANCELLED";
  if (m.status === "ENDED") return "AUCTION_ENDED";
  if (m.status !== "LIVE") return "AUCTION_NOT_LIVE";
  return null;
}
const isAmount = (a: unknown): a is number =>
  typeof a === "number" && Number.isSafeInteger(a) && a > 0;

function mBid(m: Model, user: string, a: unknown, now: number): DomainErrorCode | "OK" {
  mResolve(m, now);
  const st = mStatusError(m);
  if (st) return st;
  if (!isAmount(a)) return "BID_INVALID_AMOUNT";
  if (a > CEILING) return "BID_UNREASONABLE";
  if (m.leader === user) return "ALREADY_LEADING";
  if (a < mMin(m)) return "BID_TOO_LOW";
  if (a > mCeiling(m)) return "BID_UNREASONABLE";
  const rival = [...m.proxies.values()]
    .filter((p) => p.user !== user && p.max >= a)
    .sort((x, y) => better({ value: x.max, order: x.order }, { value: y.max, order: y.order }))[0];
  if (rival && rival.max === a) {
    m.price = a;
    m.leader = rival.user;
    mSettle(m);
    mSoftClose(m, now);
    return "BID_TOO_LOW";
  }
  m.price = a;
  m.leader = user;
  mSettle(m);
  mSoftClose(m, now);
  return "OK";
}

function mSetMax(m: Model, user: string, max: unknown, now: number): DomainErrorCode | "OK" {
  mResolve(m, now);
  const st = mStatusError(m);
  if (st) return st;
  if (!isAmount(max)) return "BID_INVALID_AMOUNT";
  if (max > CEILING) return "BID_UNREASONABLE";
  if (max < mMin(m)) return "BID_TOO_LOW";
  if (max > mCeiling(m)) return "BID_UNREASONABLE";
  if (m.proxies.get(user)?.max === max) return "OK";
  m.proxies.set(user, { user, max, order: ++m.order });
  const before = m.price;
  mSettle(m);
  if (m.price !== before) mSoftClose(m, now);
  return "OK";
}

// ───────────────────────────── generators ─────────────────────────────

/** Each user's maxima end in a distinct paise suffix, so a max is recognisable in any JSON. */
const SUFFIX = [11, 33, 55, 77];
const userIx = fc.integer({ min: 0, max: 3 });

type MaxKind =
  | { k: "min" }
  | { k: "plus"; steps: number }
  | { k: "tieTop" }
  | { k: "own" }
  | { k: "below"; by: number }
  | { k: "over3x" }
  | { k: "invalid"; v: unknown };
type BidKindGen =
  | { k: "min" }
  | { k: "plus"; steps: number }
  | { k: "atTopMax" }
  | { k: "underTopMax"; by: number }
  | { k: "below"; by: number }
  | { k: "over3x" };

const maxKind: fc.Arbitrary<MaxKind> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ k: "min" as const }) },
  {
    weight: 8,
    arbitrary: fc.integer({ min: 0, max: 30 }).map((steps) => ({ k: "plus" as const, steps })),
  },
  { weight: 3, arbitrary: fc.constant({ k: "tieTop" as const }) },
  { weight: 2, arbitrary: fc.constant({ k: "own" as const }) },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 1, max: 60_000 }).map((by) => ({ k: "below" as const, by })),
  },
  { weight: 1, arbitrary: fc.constant({ k: "over3x" as const }) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom<unknown>(0, -5, 2.5, "9000000", null, CEILING + 1)
      .map((v) => ({ k: "invalid" as const, v })),
  },
);
const bidKind: fc.Arbitrary<BidKindGen> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ k: "min" as const }) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 20 }).map((steps) => ({ k: "plus" as const, steps })),
  },
  { weight: 3, arbitrary: fc.constant({ k: "atTopMax" as const }) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 60_000 }).map((by) => ({ k: "underTopMax" as const, by })),
  },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 1, max: 60_000 }).map((by) => ({ k: "below" as const, by })),
  },
  { weight: 1, arbitrary: fc.constant({ k: "over3x" as const }) },
);

type Op =
  | { op: "advance"; ms: number }
  | { op: "nearClose"; before: number }
  | { op: "bid"; user: number; amount: BidKindGen }
  | { op: "max"; user: number; max: MaxKind }
  | { op: "retryMax"; same: boolean }
  | { op: "tick" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.integer({ min: 0, max: 8 * MIN }).map((ms) => ({ op: "advance" as const, ms })),
  },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 1, max: 3 * MIN })
      .map((before) => ({ op: "nearClose" as const, before })),
  },
  {
    weight: 8,
    arbitrary: fc.record({ op: fc.constant("bid" as const), user: userIx, amount: bidKind }),
  },
  {
    weight: 10,
    arbitrary: fc.record({ op: fc.constant("max" as const), user: userIx, max: maxKind }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("retryMax" as const), same: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ op: "tick" as const }) },
);

const startArb = fc.oneof(
  fc.constantFrom(2_400_000, 2_500_000, 9_900_000, 10_000_000, 29_900_000, 30_000_000),
  fc.integer({ min: 100, max: 400_000 }).map((r) => r * 100),
);

const scenarioArb = fc.record({
  start: startArb,
  reserveFactor: fc.option(fc.integer({ min: 100, max: 300 }), { nil: null }),
  duration: fc.integer({ min: 5 * MIN, max: 60 * MIN }),
  softClose: fc.boolean(),
  ops: fc.array(opArb, { minLength: 1, maxLength: 50 }),
});

// ───────────────────────────── helpers ─────────────────────────────

type BidEvent = Extract<AuctionEvent, { type: "bid.accepted" }>;
const isBid = (e: AuctionEvent): e is BidEvent => e.type === "bid.accepted";

function setup(sc: {
  start: number;
  reserveFactor: number | null;
  duration: number;
  softClose: boolean;
}) {
  const reserve =
    sc.reserveFactor === null ? null : Math.floor((sc.start * sc.reserveFactor) / 10_000) * 100;
  const rules = sc.softClose ? DEFAULT_RULES : { ...DEFAULT_RULES, softClose: null };
  const created = createAuction({
    auctionId: "auc-proxy",
    startPriceMinor: sc.start,
    reserveMinor: reserve !== null && reserve >= sc.start ? reserve : null,
    startsAt: T0,
    closesAt: T0 + sc.duration,
    rules,
    now: T0,
  });
  if (!created.ok) throw new Error(`setup: ${created.error.message}`);
  const sched = schedule(created.state, T0);
  if (!sched.ok) throw new Error("schedule");
  const s = sched.state;
  const m: Model = {
    status: "LIVE",
    start: s.startPriceMinor,
    reserve: s.reserveMinor,
    startsAt: s.startsAt,
    closesAt: s.closesAt,
    hardCloseAt: s.hardCloseAt,
    softClose: sc.softClose,
    price: null,
    leader: null,
    proxies: new Map(),
    order: 0,
  };
  return { state: s, log: [...created.events, ...sched.events], m };
}

const seen = new Map<string, number>();
const hit = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);

function checkStable(s: AuctionState) {
  if (s.status !== "LIVE" || s.leaderUserId === null || s.currentPriceMinor === null) return;
  const min = minNextBidFor(s);
  const lp = s.proxies.find((p) => p.userId === s.leaderUserId);
  const commit = Math.max(s.currentPriceMinor, lp?.maxMinor ?? 0);
  for (const p of s.proxies) {
    if (p.userId === s.leaderUserId) continue;
    expect(p.maxMinor).toBeLessThan(min); // no other maximum can still act
    expect(p.maxMinor).toBeLessThanOrEqual(commit);
  }
}

// ───────────────────────────── properties ─────────────────────────────

describe("proxy bidding: engine vs closed-form reference model", () => {
  it("agrees with the model and keeps every proxy invariant over random interleavings", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const init = setup(sc);
        let s = init.state;
        const log: AuctionEvent[] = [...init.log];
        const m = init.m;
        let now = T0;
        let n = 0;
        const idem = new Map<string, IdempotencyRecord<StoredMaxBidResult>>();
        let lastMax: { userId: string; key: string; max: unknown } | null = null;
        const firstReply = new Map<string, StoredMaxBidResult>();
        let highestManual = 0;

        const commit = (events: readonly AuctionEvent[], next: AuctionState) => {
          const minBefore = minNextBidFor(s);
          const priceBefore = s.currentPriceMinor;
          let prev = priceBefore;
          let prevMin = minBefore;
          for (const e of events) {
            expect(e.seq).toBe(log.length + 1); // E: contiguous
            log.push(e);
            if (!isBid(e)) continue;
            if (prev !== null) expect(e.amountMinor).toBeGreaterThan(prev); // strictly increasing
            if (e.kind === "MANUAL") {
              expect(e.amountMinor).toBeGreaterThanOrEqual(prevMin); // B for manual bids
              highestManual = Math.max(highestManual, e.amountMinor);
            } else {
              const owner = next.proxies.find((p) => p.userId === e.userId);
              expect(owner).toBeDefined();
              expect(e.amountMinor).toBeLessThanOrEqual(owner!.maxMinor); // never above own max
              const capped = e.amountMinor === owner!.maxMinor;
              const reserveJump = e.amountMinor === next.reserveMinor;
              expect(e.amountMinor >= prevMin || capped || reserveJump).toBe(true);
              if (capped && e.amountMinor < prevMin) hit("proxy.capped");
              if (reserveJump) hit("reserve.jump");
            }
            prev = e.amountMinor;
            prevMin = e.minNextBidMinor;
          }
          if (events.some(isBid)) {
            // B per command: the resulting price is at least the minimum at the command's start,
            // except a lift to exactly the reserve (the leader's maximum newly covers it).
            if (next.currentPriceMinor !== next.reserveMinor)
              expect(next.currentPriceMinor!).toBeGreaterThanOrEqual(minBefore);
            else hit("reserve.lift");
            if (
              events.some((e) => e.type === "auction.extended") &&
              events.filter(isBid).some((e) => e.kind === "PROXY")
            )
              hit("extended.withProxy");
            expect(events.filter((e) => e.type === "auction.extended").length).toBeLessThanOrEqual(
              1,
            );
          }
          s = next;
        };

        const topMax = (exclude: string) =>
          [...s.proxies].filter((p) => p.userId !== exclude).sort(compareProxies)[0]?.maxMinor;

        const runMax = (userId: string, key: string, max: unknown) => {
          const fingerprint = maxBidFingerprint({ auctionId: "auc-proxy", maxMinor: max });
          const res = resolveIdempotency(
            idem.get(`${userId}|${key}`),
            { userId, key, fingerprint },
            now,
          );
          if (res.kind === "replay") {
            hit("idem.replay");
            expect(res.result).toEqual(firstReply.get(`${userId}|${key}`)); // C
            return;
          }
          if (res.kind === "conflict") return hit("idem.conflict");
          const was = s.leaderUserId;
          const expected = mSetMax(m, userId, max, now);
          const d = setMaxBid(s, { bidId: `m${++n}`, userId, maxMinor: max, now });
          expect(d.ok ? "OK" : d.error.code).toBe(expected);
          hit(`max.${d.ok ? "ok" : d.error.code}`);
          if (d.ok && was === userId) hit("max.byLeader");
          if (d.ok) {
            expect(d.outcome.isLeading).toBe(d.state.leaderUserId === userId);
            expect(d.outcome.seq).toBe(d.state.seq);
          } else {
            expect(d.state.proxies).toEqual(s.proxies); // a rejection never stores a maximum
          }
          commit(d.events, d.state);
          const rec = makeMaxIdempotencyRecord({ userId, key, fingerprint }, d, now);
          idem.set(`${userId}|${key}`, rec);
          firstReply.set(`${userId}|${key}`, rec.result);
          lastMax = { userId, key, max };
        };

        for (const op of sc.ops) {
          switch (op.op) {
            case "advance":
              now += op.ms;
              break;
            case "nearClose":
              now = Math.max(now, m.closesAt - op.before);
              break;
            case "tick": {
              const t = tick(s, now);
              mResolve(m, now);
              commit(t.events, t.state);
              break;
            }
            case "max": {
              const userId = `user-${op.user}`;
              const min = mMin(m);
              const base = m.price ?? m.start;
              const own = s.proxies.find((p) => p.userId === userId)?.maxMinor;
              let max: unknown;
              switch (op.max.k) {
                case "min":
                  max = min;
                  break;
                case "plus":
                  max = Math.ceil((min + op.max.steps * inc(base)) / 100) * 100 + SUFFIX[op.user]!;
                  break;
                case "tieTop":
                  max = topMax(userId) ?? min;
                  break;
                case "own":
                  max = own ?? min;
                  break;
                case "below":
                  max = Math.max(1, min - op.max.by);
                  break;
                case "over3x":
                  max = mCeiling(m) + 1;
                  break;
                case "invalid":
                  max = op.max.v;
                  break;
              }
              runMax(userId, `key-${String(++n).padStart(16, "0")}`, max);
              break;
            }
            case "retryMax": {
              if (!lastMax) break;
              const { userId, key, max } = lastMax;
              const bids = log.filter(isBid).length;
              const changed = typeof max === "number" ? max + 100 : 7_000_000;
              runMax(userId, key, op.same ? max : changed);
              expect(log.filter(isBid).length).toBe(bids); // a retry never bids again
              break;
            }
            case "bid": {
              const userId = `user-${op.user}`;
              const min = mMin(m);
              const top = topMax(userId);
              let a: number;
              switch (op.amount.k) {
                case "min":
                  a = min;
                  break;
                case "plus":
                  a = min + op.amount.steps * inc(m.price ?? m.start);
                  break;
                case "atTopMax":
                  a = top !== undefined && top >= min ? top : min;
                  if (top !== undefined && top >= min) hit("bid.atTopMax");
                  break;
                case "underTopMax":
                  a = top !== undefined ? Math.max(min, top - op.amount.by) : min;
                  break;
                case "below":
                  a = Math.max(1, min - op.amount.by);
                  break;
                case "over3x":
                  a = mCeiling(m) + 1;
                  break;
              }
              const expected = mBid(m, userId, a, now);
              const d = placeBid(s, { bidId: `b${++n}`, userId, amountMinor: a, now });
              expect(d.ok ? "OK" : d.error.code).toBe(expected);
              hit(`bid.${d.ok ? "ok" : d.error.code}`);
              if (!d.ok && d.events.some(isBid)) hit("tie.manualLoses");
              if (d.ok && d.events.filter(isBid).some((e) => e.kind === "PROXY"))
                hit("proxy.defends");
              commit(d.events, d.state);
              break;
            }
          }

          // ── per-step: engine == model ──
          expect(s.status).toBe(m.status);
          expect(s.currentPriceMinor).toBe(m.price);
          expect(s.leaderUserId).toBe(m.leader);
          expect(s.closesAt).toBe(m.closesAt);
          expect(s.closesAt).toBeLessThanOrEqual(s.hardCloseAt);
          expect(s.seq).toBe(log.length);
          checkStable(s);
          const price = s.currentPriceMinor;
          if (price !== null) {
            expect(price).toBeGreaterThanOrEqual(s.startPriceMinor); // price ≥ start
            const ranked = [...s.proxies].sort(compareProxies);
            const top = ranked[0];
            // Price never exceeds the highest commitment (highest max or highest manual bid).
            expect(price).toBeLessThanOrEqual(Math.max(top?.maxMinor ?? 0, highestManual));
            // D: the holder of the highest max (tie → earliest) leads whenever it covers the price.
            if (top && top.maxMinor >= price) expect(s.leaderUserId).toBe(top.userId);
            // Reserve rule: a leader whose maximum covers the reserve is at or above it.
            const lp = s.proxies.find((p) => p.userId === s.leaderUserId);
            if (lp && s.reserveMinor !== null && lp.maxMinor >= s.reserveMinor)
              expect(price).toBeGreaterThanOrEqual(s.reserveMinor);
          }
          // Privacy: views are strict; a viewer sees only their own max; unrevealed maxima appear
          // nowhere in public output.
          const pubEvents = log
            .map((e) => toPublicEvent(e, (u) => `Bidder ${u.slice(-1)}AAA`))
            .filter((e) => e !== null);
          for (const e of pubEvents) PublicAuctionEvent.parse(e);
          const publicAmounts = new Set<number>(
            pubEvents.flatMap((e) =>
              e.type === "bid.accepted" ? [e.amountMinor, e.minNextBidMinor] : [],
            ),
          );
          const outsiderViews = [null, "user-9"].map((v) =>
            toPublicView(s, {
              leaderPseudonym: s.leaderUserId ? "Bidder 0AAA" : null,
              viewerUserId: v,
            }),
          );
          for (const p of s.proxies) {
            const own = toPublicView(s, { leaderPseudonym: null, viewerUserId: p.userId });
            PublicAuctionView.parse(own);
            expect(own.viewer!.myMaxMinor).toBe(p.maxMinor);
            const others = s.proxies
              .filter((q) => q.userId !== p.userId)
              .map((q) => toPublicView(s, { leaderPseudonym: null, viewerUserId: q.userId }));
            if (publicAmounts.has(p.maxMinor)) continue; // revealed by design (a step at the max)
            const json = JSON.stringify([pubEvents, outsiderViews, others]);
            expect(json).not.toMatch(new RegExp(`\\b${p.maxMinor}\\b`));
            hit("privacy.checked");
          }
          for (const v of outsiderViews) {
            PublicAuctionView.parse(v);
            if (v.viewer) expect(v.viewer.myMaxMinor).toBeNull();
          }
        }

        // Termination and outcome: the leader at close wins iff the price meets the reserve.
        const end = tick(s, s.hardCloseAt + 1).state;
        mResolve(m, s.hardCloseAt + 1);
        if (end.status === "ENDED") {
          const expected =
            m.price === null
              ? "NO_BIDS"
              : m.reserve !== null && m.price < m.reserve
                ? "RESERVE_NOT_MET"
                : "SOLD";
          expect(end.outcome).toBe(expected);
          hit(`outcome.${expected}`);
          if (expected === "SOLD") expect(end.winnerUserId).toBe(m.leader);
        }
      }),
      { seed: SEED, numRuns: RUNS, ...(PATH ? { path: PATH } : {}), verbose: 1 },
    );
    if (!PATH) {
      for (const k of [
        "max.ok",
        "max.BID_TOO_LOW",
        "max.BID_UNREASONABLE",
        "max.BID_INVALID_AMOUNT",
        "max.AUCTION_ENDED",
        "max.byLeader",
        "bid.ok",
        "bid.BID_TOO_LOW",
        "bid.ALREADY_LEADING",
        "bid.atTopMax",
        "tie.manualLoses",
        "proxy.defends",
        "proxy.capped",
        "reserve.jump",
        "extended.withProxy",
        "idem.replay",
        "idem.conflict",
        "privacy.checked",
        "outcome.SOLD",
        "outcome.RESERVE_NOT_MET",
      ]) {
        expect(seen.get(k) ?? 0, `scenario never generated: ${k}`).toBeGreaterThan(0);
      }
      console.info(
        `[proxy] seed=${SEED} runs=${RUNS} coverage=${JSON.stringify(Object.fromEntries([...seen].sort()))}`,
      );
    }
  });

  it("with only maxima (each set once), final price = min(highest, second + inc(second)), reserve-lifted", () => {
    fc.assert(
      fc.property(
        startArb,
        fc.option(fc.integer({ min: 100, max: 250 }), { nil: null }),
        fc.array(
          fc.record({
            user: fc.integer({ min: 0, max: 5 }),
            extra: fc.integer({ min: 0, max: 2_000_000 }),
          }),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        (start, reserveFactor, sets) => {
          const { state } = setup({ start, reserveFactor, duration: 60 * MIN, softClose: true });
          let s = state;
          const accepted: { user: string; max: number }[] = [];
          let now = T0;
          for (const { user, extra } of sets) {
            const userId = `u${user}`;
            if (s.proxies.some((p) => p.userId === userId)) continue; // set once
            now += 1000;
            const max = minNextBidFor(s) + extra;
            const d = setMaxBid(s, { bidId: `x${now}`, userId, maxMinor: max, now });
            if (!d.ok) {
              expect(d.error.code).toBe("BID_UNREASONABLE"); // only the fat-finger guard can refuse
              continue;
            }
            accepted.push({ user: userId, max });
            s = d.state;
          }
          if (accepted.length === 0) return;
          // Highest max wins; on equal maxima the one set first.
          const ranked = accepted
            .map((a, i) => ({ ...a, i }))
            .sort((a, b) => b.max - a.max || a.i - b.i);
          const [w, second] = [ranked[0]!, ranked[1]];
          let expected = second ? Math.min(w.max, second.max + inc(second.max)) : s.startPriceMinor;
          if (s.reserveMinor !== null && w.max >= s.reserveMinor)
            expected = Math.max(expected, s.reserveMinor);
          expect(s.leaderUserId).toBe(w.user);
          expect(s.currentPriceMinor).toBe(expected);
          expect(s.currentPriceMinor!).toBeLessThanOrEqual(w.max);
        },
      ),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("setMaxBid is idempotent per key: a replay never changes state, a new key with the same max is a no-op", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (x, y) => {
          const { state } = setup({
            start: 5_000_000,
            reserveFactor: null,
            duration: 60 * MIN,
            softClose: true,
          });
          const a = setMaxBid(state, {
            bidId: "a",
            userId: "A",
            maxMinor: 5_000_000 + x,
            now: T0 + 1,
          });
          if (!a.ok) throw new Error("a");
          const b = setMaxBid(a.state, {
            bidId: "b",
            userId: "B",
            maxMinor: a.outcome.minNextBidMinor + y,
            now: T0 + 2,
          });
          const s = b.state;
          for (const userId of ["A", "B"]) {
            const own = s.proxies.find((p) => p.userId === userId);
            if (!own || own.maxMinor < minNextBidFor(s)) continue;
            const again = setMaxBid(s, { bidId: "c", userId, maxMinor: own.maxMinor, now: T0 + 3 });
            expect(again.ok).toBe(true);
            expect(again.events).toEqual([]);
            expect(again.state.proxies).toEqual(s.proxies);
            expect(again.state.seq).toBe(s.seq);
          }
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });
});
