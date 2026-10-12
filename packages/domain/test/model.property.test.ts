/**
 * Model-based property tests (BLUEPRINT §12).
 *
 * The REFERENCE MODEL below is an independent, deliberately naive re-statement of the auction rules
 * from the spec. It keeps the full bid list and recomputes everything from it; it shares no code
 * with the engine (its own increment table, its own outcome logic, its own soft-close rule).
 * fast-check generates random command sequences; after every step we compare the engine with the
 * model and check invariants A–L on the committed event log.
 *
 * Reproduce a failure: FC_SEED=<seed> FC_PATH=<path> pnpm --filter @bike/domain test
 * Defaults are fixed (seed 20261012) so CI is deterministic; FC_RUNS raises the run count.
 */
import { PublicAuctionView } from "@bike/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bidFingerprint,
  cancel,
  createAuction,
  DEFAULT_RULES,
  makeIdempotencyRecord,
  placeBid,
  resolveIdempotency,
  schedule,
  tick,
  toPublicView,
  type AuctionEvent,
  type AuctionState,
  type DomainErrorCode,
  type IdempotencyRecord,
  type StoredBidResult,
} from "../src";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const CEILING = 1_000_000_000;

// ───────────────────────────── reference model ─────────────────────────────

type ModelBid = { user: string; amount: number };
type Model = {
  status: "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";
  start: number;
  reserve: number | null;
  startsAt: number;
  closesAt: number;
  hardCloseAt: number;
  softClose: boolean;
  bids: ModelBid[];
};

function modelIncrement(price: number): number {
  // Written from the blueprint table in rupees, independent of DEFAULT_LADDER.
  const rupees = price / 100;
  if (rupees < 25_000) return 250 * 100;
  if (rupees < 1_00_000) return 500 * 100;
  if (rupees <= 3_00_000) return 1_000 * 100;
  return 2_500 * 100;
}
const top = (m: Model) => (m.bids.length ? m.bids[m.bids.length - 1]! : null);
const modelMinNext = (m: Model) =>
  top(m) ? top(m)!.amount + modelIncrement(top(m)!.amount) : m.start;
function modelResolve(m: Model, now: number): void {
  if (m.status === "SCHEDULED" && now >= m.startsAt) m.status = "LIVE";
  if (m.status === "LIVE" && now >= m.closesAt) m.status = "ENDED";
}
function modelOutcome(m: Model) {
  const t = top(m);
  if (!t) return { outcome: "NO_BIDS", winner: null };
  if (m.reserve !== null && t.amount < m.reserve)
    return { outcome: "RESERVE_NOT_MET", winner: null };
  return { outcome: "SOLD", winner: t.user };
}
function modelBid(m: Model, user: string, amount: unknown, now: number): DomainErrorCode | "OK" {
  modelResolve(m, now);
  if (m.status === "CANCELLED") return "AUCTION_CANCELLED";
  if (m.status === "ENDED") return "AUCTION_ENDED";
  if (m.status !== "LIVE") return "AUCTION_NOT_LIVE";
  if (
    typeof amount !== "number" ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > Number.MAX_SAFE_INTEGER
  ) {
    return "BID_INVALID_AMOUNT";
  }
  if (amount > CEILING) return "BID_UNREASONABLE";
  if (top(m)?.user === user) return "ALREADY_LEADING";
  const min = modelMinNext(m);
  if (amount < min) return "BID_TOO_LOW";
  const reference = top(m)?.amount ?? m.start;
  if (amount > Math.min(CEILING, Math.max(min, reference * 3))) return "BID_UNREASONABLE";
  m.bids.push({ user, amount });
  if (m.softClose && m.closesAt - now < 2 * MIN) {
    m.closesAt = Math.max(m.closesAt, Math.min(now + 2 * MIN, m.hardCloseAt));
  }
  return "OK";
}

// ───────────────────────────── generators ─────────────────────────────

const startPrice = fc.oneof(
  fc.constantFrom(
    1,
    25_000,
    2_499_900,
    2_500_000,
    9_999_900,
    10_000_000,
    29_990_000,
    30_000_000,
    30_000_001,
    99_000_000,
  ),
  fc.integer({ min: 1, max: 50_000_000 }),
);

type AmountKind =
  | { k: "min" }
  | { k: "minPlus"; steps: number }
  | { k: "below"; by: number }
  | { k: "huge" }
  | { k: "over3x" }
  | { k: "random"; v: number }
  | { k: "invalid"; v: unknown };

const amountKind: fc.Arbitrary<AmountKind> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ k: "min" as const }) },
  {
    weight: 4,
    arbitrary: fc.integer({ min: 1, max: 40 }).map((steps) => ({ k: "minPlus" as const, steps })),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 1, max: 100_000 }).map((by) => ({ k: "below" as const, by })),
  },
  { weight: 1, arbitrary: fc.constant({ k: "huge" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "over3x" as const }) },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: -10, max: 2_000_000_000 })
      .map((v) => ({ k: "random" as const, v })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom<unknown>(
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "5000",
        null,
        Number.MAX_SAFE_INTEGER + 2,
      )
      .map((v) => ({ k: "invalid" as const, v })),
  },
);

type Op =
  | { op: "advance"; ms: number }
  | { op: "bid"; user: number; amount: AmountKind }
  | { op: "retry"; sameAmount: boolean; delta: number }
  | { op: "tick" }
  | { op: "cancel" }
  | { op: "pastHard" }
  | { op: "nearClose"; before: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.integer({ min: 0, max: 10 * MIN }).map((ms) => ({ op: "advance" as const, ms })),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 0, max: 3 * MIN }).map((ms) => ({ op: "advance" as const, ms })),
  },
  {
    weight: 10,
    arbitrary: fc.record({
      op: fc.constant("bid" as const),
      user: fc.integer({ min: 0, max: 3 }),
      amount: amountKind,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant("retry" as const),
      sameAmount: fc.boolean(),
      delta: fc.integer({ min: 1, max: 1_000_000 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ op: "tick" as const }) },
  { weight: 1, arbitrary: fc.constant({ op: "cancel" as const }) },
  { weight: 1, arbitrary: fc.constant({ op: "pastHard" as const }) },
  // Jump to just before the CURRENT close (inside or near the soft-close window) to exercise
  // extensions, the exclusive window boundary, and the hard cap.
  {
    weight: 3,
    arbitrary: fc
      .integer({ min: 1, max: 3 * MIN })
      .map((before) => ({ op: "nearClose" as const, before })),
  },
);

const scenarioArb = fc.record({
  start: startPrice,
  reserveFactor: fc.option(fc.integer({ min: 100, max: 400 }), { nil: null }), // % of start
  startDelay: fc.integer({ min: 0, max: 5 * MIN }),
  duration: fc.integer({ min: MIN, max: 90 * MIN }),
  softClose: fc.boolean(),
  ops: fc.array(opArb, { minLength: 1, maxLength: 60 }),
});

// ───────────────────────────── harness ─────────────────────────────

/**
 * Test-only harness standing in for the Durable Object: holds state, a COMMITTED event log and an
 * idempotency map. The map is in-memory and NOT durable; the real store is the DO's SQLite (Day 4).
 */
class Harness {
  log: AuctionEvent[] = [];
  idem = new Map<string, IdempotencyRecord>();
  lastCmd: { userId: string; key: string; amount: unknown } | null = null;
  replies: { key: string; result: StoredBidResult }[] = [];
  constructor(public state: AuctionState) {}
  commit(events: readonly AuctionEvent[], next: AuctionState) {
    this.log.push(...events);
    this.state = next;
  }
}

function amountFor(kind: AmountKind, s: AuctionState, m: Model): unknown {
  const min = modelMinNext(m);
  switch (kind.k) {
    case "min":
      return min;
    case "minPlus":
      return min + kind.steps * modelIncrement(top(m)?.amount ?? s.startPriceMinor);
    case "below":
      return Math.max(1, min - kind.by);
    case "huge":
      return CEILING + 1;
    case "over3x":
      return Math.max(min, (top(m)?.amount ?? m.start) * 3) + 1;
    case "random":
      return kind.v;
    case "invalid":
      return kind.v;
  }
}

/** Scenario coverage counters: proves the generators reach every interesting path (non-vacuity). */
const seen = new Map<string, number>();
const hit = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);

const SEED = Number(process.env.FC_SEED ?? 20261012);
const RUNS = Number(process.env.FC_RUNS ?? 400);
const PATH = process.env.FC_PATH;

describe("model-based: engine vs independent reference model", () => {
  it("agrees with the model and preserves invariants A–L for random command sequences", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const startsAt = T0 + sc.startDelay;
        const closesAt = startsAt + sc.duration;
        const reserve =
          sc.reserveFactor === null
            ? null
            : Math.min(CEILING, Math.floor((sc.start * sc.reserveFactor) / 100));
        const rules = sc.softClose ? DEFAULT_RULES : { ...DEFAULT_RULES, softClose: null };
        const created = createAuction({
          auctionId: "auc-prop",
          startPriceMinor: sc.start,
          reserveMinor: reserve,
          startsAt,
          closesAt,
          rules,
          now: T0,
        });
        if (!created.ok) throw new Error(`setup failed: ${created.error.message}`);
        const scheduled = schedule(created.state, T0);
        if (!scheduled.ok) throw new Error("schedule failed");
        const h = new Harness(scheduled.state);
        h.log.push(...created.events, ...scheduled.events);

        const m: Model = {
          status: "SCHEDULED",
          start: sc.start,
          reserve,
          startsAt,
          closesAt,
          hardCloseAt: sc.softClose ? closesAt + 30 * MIN : closesAt,
          softClose: sc.softClose,
          bids: [],
        };
        let now = T0;
        modelResolve(m, now); // schedule() starts immediately when startsAt ≤ now
        let n = 0;

        const runBid = (userId: string, key: string, amount: unknown) => {
          const fingerprint = bidFingerprint({ auctionId: "auc-prop", amountMinor: amount });
          const resolution = resolveIdempotency(
            h.idem.get(`${userId}|${key}`),
            { userId, key, fingerprint },
            now,
          );
          if (resolution.kind !== "new") hit(`idem.${resolution.kind}`);
          if (resolution.kind === "replay") {
            h.replies.push({ key: `${userId}|${key}`, result: resolution.result });
            return; // no effects, no events (invariant C)
          }
          if (resolution.kind === "conflict") return; // rejected, no effects
          const before = h.state;
          const minBefore = modelMinNext(m);
          const modelResult = modelBid(m, userId, amount, now);
          const d = placeBid(before, { bidId: `b${++n}`, userId, amountMinor: amount, now });
          expect(d.ok ? "OK" : d.error.code).toBe(modelResult);
          hit(`bid.${d.ok ? "accepted" : d.error.code}`);
          if (d.events.some((e) => e.type === "auction.extended")) hit("extended");
          if (d.ok) {
            // B: accepted amount satisfied the minimum at commit time. A: before close.
            expect(d.bid.amountMinor).toBeGreaterThanOrEqual(minBefore);
            expect(now).toBeLessThan(tick(before, now).state.closesAt);
          } else {
            expect(d.state.currentPriceMinor).toBe(before.currentPriceMinor);
            expect(d.state.bidCount).toBe(before.bidCount);
          }
          h.commit(d.events, d.state);
          const record = makeIdempotencyRecord({ userId, key, fingerprint }, d, now);
          h.idem.set(`${userId}|${key}`, record);
          h.replies.push({ key: `${userId}|${key}`, result: record.result });
          h.lastCmd = { userId, key, amount };
        };

        for (const op of sc.ops) {
          switch (op.op) {
            case "advance":
              now += op.ms;
              break;
            case "pastHard":
              now = Math.max(now, m.hardCloseAt + 1);
              break;
            case "nearClose":
              now = Math.max(now, m.closesAt - op.before); // time never goes backwards
              break;
            case "tick": {
              const t = tick(h.state, now);
              modelResolve(m, now);
              h.commit(t.events, t.state);
              break;
            }
            case "cancel": {
              const r = cancel(h.state, { reason: "Listing withdrawn", now });
              modelResolve(m, now);
              const modelCan = m.status === "SCHEDULED" || m.status === "LIVE";
              expect(r.ok).toBe(modelCan);
              if (modelCan) m.status = "CANCELLED";
              hit(modelCan ? "cancel.ok" : "cancel.rejected");
              h.commit(r.events, r.state);
              break;
            }
            case "bid":
              runBid(
                `user-${op.user}`,
                `key-${String(++n).padStart(16, "0")}`,
                amountFor(op.amount, h.state, m),
              );
              break;
            case "retry": {
              if (!h.lastCmd) break;
              const { userId, key, amount } = h.lastCmd;
              const prevAccepted = h.log.filter((e) => e.type === "bid.accepted").length;
              const changed = typeof amount === "number" ? amount + op.delta : 5_000_000;
              runBid(userId, key, op.sameAmount ? amount : changed);
              // C: a retry never creates a second accepted bid.
              expect(h.log.filter((e) => e.type === "bid.accepted").length).toBe(prevAccepted);
              break;
            }
          }

          // ── per-step invariants ──
          const s = h.state;
          // Engine == model on observable state.
          const t = top(m);
          expect(s.status).toBe(m.status);
          expect(s.currentPriceMinor).toBe(t?.amount ?? null);
          expect(s.leaderUserId).toBe(t?.user ?? null);
          expect(s.bidCount).toBe(m.bids.length);
          expect(s.closesAt).toBe(m.closesAt);
          if (s.status === "ENDED") {
            const o = modelOutcome(m);
            hit(`outcome.${o.outcome}`);
            expect(s.outcome).toBe(o.outcome);
            expect(s.winnerUserId).toBe(o.winner); // J (vs model) and K
          }
          // G: bounded close.
          expect(s.closesAt).toBeLessThanOrEqual(s.hardCloseAt);
          // E: committed seq is contiguous and matches state.
          h.log.forEach((e, i) => expect(e.seq).toBe(i + 1));
          expect(s.seq).toBe(h.log.length);
          // F, L: at most one terminal event, and it is the last event.
          const terminal = h.log.filter(
            (e) => e.type === "auction.ended" || e.type === "auction.cancelled",
          );
          expect(terminal.length).toBeLessThanOrEqual(1);
          if (terminal.length) expect(h.log.at(-1)).toBe(terminal[0]);
          // I: public view is strict and never carries the reserve or user ids.
          const view = toPublicView(s, {
            leaderPseudonym: s.leaderUserId ? "Bidder TEST" : null,
            viewerUserId: "user-0",
          });
          PublicAuctionView.parse(view);
          expect(JSON.stringify(view)).not.toMatch(/user-\d|reserveMinor/);
        }

        // H + D across the whole committed ledger.
        const accepted = h.log.filter(
          (e): e is Extract<AuctionEvent, { type: "bid.accepted" }> => e.type === "bid.accepted",
        );
        for (let i = 1; i < accepted.length; i++)
          expect(accepted[i]!.amountMinor).toBeGreaterThan(accepted[i - 1]!.amountMinor);
        expect(h.state.currentPriceMinor).toBe(accepted.at(-1)?.amountMinor ?? null);
        expect(h.state.leaderBidSeq).toBe(accepted.at(-1)?.seq ?? null);
        // A over the ledger: every acceptance happened before the close in force at that moment.
        for (const e of accepted) expect(e.at).toBeLessThan(e.closesAt);
        // C: replays returned exactly the first stored result for that key.
        const first = new Map<string, StoredBidResult>();
        for (const r of h.replies) {
          if (!first.has(r.key)) first.set(r.key, r.result);
          else expect(r.result).toEqual(first.get(r.key));
        }
        // L: after the sequence, time can only add at most the remaining terminal transition, once.
        const late = tick(h.state, Math.max(now, h.state.hardCloseAt) + 1);
        const again = tick(late.state, Math.max(now, h.state.hardCloseAt) + 1_000_000);
        expect(again.events).toEqual([]);
        expect(["ENDED", "CANCELLED"]).toContain(late.state.status); // termination
      }),
      { seed: SEED, numRuns: RUNS, ...(PATH ? { path: PATH } : {}), verbose: 1 },
    );
    if (!PATH) {
      for (const k of [
        "bid.accepted",
        "bid.BID_TOO_LOW",
        "bid.BID_UNREASONABLE",
        "bid.BID_INVALID_AMOUNT",
        "bid.ALREADY_LEADING",
        "bid.AUCTION_ENDED",
        "bid.AUCTION_CANCELLED",
        "bid.AUCTION_NOT_LIVE",
        "extended",
        "idem.replay",
        "idem.conflict",
        "outcome.SOLD",
        "outcome.NO_BIDS",
        "outcome.RESERVE_NOT_MET",
        "cancel.ok",
        "cancel.rejected",
      ]) {
        expect(seen.get(k) ?? 0, `scenario never generated: ${k}`).toBeGreaterThan(0);
      }
      console.info(
        `[model] seed=${SEED} runs=${RUNS} coverage=${JSON.stringify(Object.fromEntries([...seen].sort()))}`,
      );
    }
  });

  it("winner determination is deterministic: replaying the same commands yields identical state (J)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            user: fc.integer({ min: 0, max: 4 }),
            dt: fc.integer({ min: 0, max: 4 * MIN }),
            steps: fc.integer({ min: 0, max: 5 }),
          }),
          {
            maxLength: 40,
          },
        ),
        (cmds) => {
          const run = () => {
            const c = createAuction({
              auctionId: "auc-det",
              startPriceMinor: 1_000_000,
              reserveMinor: 2_000_000,
              startsAt: T0,
              closesAt: T0 + 30 * MIN,
              now: T0,
            });
            if (!c.ok) throw new Error("setup");
            let s = schedule(c.state, T0).state;
            let now = T0;
            const events: AuctionEvent[] = [];
            cmds.forEach((cmd, i) => {
              now += cmd.dt;
              const min =
                s.currentPriceMinor === null ? s.startPriceMinor : s.currentPriceMinor + 100_000;
              const d = placeBid(s, {
                bidId: `b${i}`,
                userId: `u${cmd.user}`,
                amountMinor: min + cmd.steps * 50_000,
                now,
              });
              events.push(...d.events);
              s = d.state;
            });
            const end = tick(s, now + 2 * 60 * MIN);
            return { state: end.state, events: [...events, ...end.events] };
          };
          expect(run()).toEqual(run());
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });
});
