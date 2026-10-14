import { env, exports } from "cloudflare:workers";
import {
  AdminHealth,
  AdminLedgerPage,
  AuditFacets,
  AuditPage,
  OPS_SUMMARY_MAX_AUCTIONS,
  OpsSummary,
  ProblemDetails,
} from "@bike/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpsSnapshot } from "../src/auction/auction-do";
import { createLogger, redact, REDACTED, type LogLevel } from "../src/lib/logger";
import { statusClass, toDataPoint, writeMetric, type MetricsSink } from "../src/lib/metrics";
import { collectOps, rowWarnings, settleWithin, type LiveListing } from "../src/routes/admin-ops";
import { BASE } from "./auth-helpers";
import { adminAndBuyer, call, createAuctionFor, inspectedBike } from "./catalogue-helpers";
import { auctionStub, bid, createAuction, key, sleep } from "./helpers";
import { connect, until } from "./ws-helpers";

// ───────────────────────────── logger ─────────────────────────────

function captureLogger() {
  const lines: { level: LogLevel; obj: Record<string, unknown>; raw: string }[] = [];
  const log = createLogger({ requestId: "req_1" }, (level, raw) =>
    lines.push({ level, raw, obj: JSON.parse(raw) as Record<string, unknown> }),
  );
  return { log, lines };
}

describe("logger: schema and redaction", () => {
  it("every line is one JSON object with ts, level, event and the base fields", () => {
    const { log, lines } = captureLogger();
    log.child({ auctionId: "auc_1" }).warn("auction.projection.failed", { durationMs: 12 });
    expect(lines).toHaveLength(1);
    const l = lines[0]!.obj;
    expect(l).toMatchObject({
      level: "warn",
      event: "auction.projection.failed",
      requestId: "req_1",
      auctionId: "auc_1",
      durationMs: 12,
    });
    expect(Date.parse(String(l.ts))).toBeGreaterThan(0);
  });

  it("redacts sensitive keys recursively (any depth, arrays, any casing)", () => {
    const input = {
      password: "hunter2",
      newPassword: "x",
      Authorization: "Bearer abc",
      cookie: "s=1",
      "set-cookie": ["a=1"],
      sessionToken: "t",
      apiSecret: "s",
      userEmail: "a@b.co",
      reserveMinor: 7_777_777,
      maxMinor: 9_000_000,
      myMaxMinor: 1,
      ip: "198.51.100.7",
      "cf-connecting-ip": "198.51.100.7",
      "x-forwarded-for": "198.51.100.7",
      nested: {
        deeper: [{ token: "abc", ok: 1 }, { list: [{ EMAIL: "x@y.io", amountMinor: 5 }] }],
        reserve: { anything: 1 },
      },
      amountMinor: 5_000_000,
      auctionId: "auc_1",
    };
    const out = redact(input) as Record<string, unknown>;
    for (const k of [
      "password",
      "newPassword",
      "Authorization",
      "cookie",
      "set-cookie",
      "sessionToken",
      "apiSecret",
      "userEmail",
      "reserveMinor",
      "maxMinor",
      "myMaxMinor",
      "ip",
      "cf-connecting-ip",
      "x-forwarded-for",
    ]) {
      expect(out[k], k).toBe(REDACTED);
    }
    const nested = out.nested as {
      deeper: [{ token: string; ok: number }, { list: [{ EMAIL: string; amountMinor: number }] }];
      reserve: unknown;
    };
    expect(nested.deeper[0]).toEqual({ token: REDACTED, ok: 1 });
    expect(nested.deeper[1].list[0]).toEqual({ EMAIL: REDACTED, amountMinor: 5 });
    expect(nested.reserve).toBe(REDACTED);
    expect(out.amountMinor).toBe(5_000_000);
    expect(out.auctionId).toBe("auc_1");
    const json = JSON.stringify(out);
    for (const secret of ["hunter2", "Bearer", "198.51", "a@b.co", "x@y.io", "7777777", "9000000"])
      expect(json).not.toContain(secret);
  });

  it("masks e-mail addresses inside free text and bounds depth", () => {
    expect(redact("D1 failed for rider.one@example.org today")).toBe("D1 failed for [email] today");
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[TRUNCATED]");
  });

  it("the logger itself applies redaction", () => {
    const { log, lines } = captureLogger();
    log.info("auth.login.failed", { email: "a@b.co", detail: { password: "p" } });
    expect(lines[0]!.raw).not.toContain("a@b.co");
    expect(lines[0]!.raw).not.toMatch(/"p"/);
  });
});

// ───────────────────────────── metrics ─────────────────────────────

describe("metrics: Analytics Engine datapoints", () => {
  it("is a no-op without a binding", () => {
    expect(() => writeMetric(undefined, { event: "http_request" })).not.toThrow();
    expect(() => writeMetric(null, { event: "bid_accepted" })).not.toThrow();
  });

  it("writes the documented shape to a binding", () => {
    const points: unknown[] = [];
    const sink: MetricsSink = { writeDataPoint: (p) => points.push(p) };
    writeMetric(sink, {
      event: "bid_rejected",
      outcome: "BID_TOO_LOW",
      index: "auc_123",
      count: 0,
    });
    writeMetric(sink, {
      event: "http_request",
      route: "POST /api/v1/auctions/:id/bids",
      status: 429,
      outcome: "RATE_LIMITED",
      colo: "BOM",
      version: "abc1234",
      durationMs: 12.5,
      count: 1,
    });
    expect(points).toEqual([
      {
        indexes: ["auc_123"],
        blobs: ["bid_rejected", "", "", "BID_TOO_LOW", "", "", ""],
        doubles: [0, 0, 0],
      },
      {
        indexes: ["POST /api/v1/auctions/:id/bids"],
        blobs: [
          "http_request",
          "POST /api/v1/auctions/:id/bids",
          "4xx",
          "RATE_LIMITED",
          "429",
          "BOM",
          "abc1234",
        ],
        doubles: [12.5, 1, 0],
      },
    ]);
  });

  it("never throws even if the binding does; sanitises and bounds blobs", () => {
    const sink: MetricsSink = {
      writeDataPoint: () => {
        throw new Error("buffer full");
      },
    };
    expect(() => writeMetric(sink, { event: "alarm_run" })).not.toThrow();
    const p = toDataPoint({
      event: "http_request",
      route: `/x/${"a".repeat(500)}?email=a@b.co`,
      index: "i".repeat(200),
      durationMs: Number.NaN,
      count: -1,
    });
    expect(p.blobs[1]!.length).toBeLessThanOrEqual(96);
    expect(p.blobs[1]).not.toContain("@");
    expect(p.blobs[1]).not.toContain("?");
    expect(p.indexes[0]!.length).toBeLessThanOrEqual(96);
    expect(p.doubles).toEqual([0, -1, 0]);
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(undefined)).toBe("");
  });
});

// ───────────────────────── request completion log ─────────────────────────

describe("request completion log", () => {
  it("logs the route pattern (no raw URL/query), status, duration, problem code and auctionId", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await exports.default.fetch(
        `${BASE}/api/v1/auctions/auc_missing_123/bids?limit=5&email=rider@example.org`,
        { headers: { "cf-connecting-ip": "198.51.100.9" } },
      );
      expect(res.status).toBe(404);
      const lines = spy.mock.calls
        .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
        .filter((l) => l.event === "http.request");
      expect(lines).toHaveLength(1);
      const l = lines[0]!;
      expect(l).toMatchObject({
        level: "info",
        method: "GET",
        route: "/api/v1/auctions/:id/bids",
        status: 404,
        code: "NOT_FOUND",
        auctionId: "auc_missing_123",
        requestId: res.headers.get("x-request-id"),
      });
      expect(typeof l.durationMs).toBe("number");
      expect(typeof l.ts).toBe("string");
      const raw = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(raw).not.toContain("limit=5");
      expect(raw).not.toContain("rider@example.org");
      expect(raw).not.toContain("198.51.100.9");
    } finally {
      spy.mockRestore();
    }
  });

  it("an unmatched path is logged as 'unmatched', never the raw path", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await exports.default.fetch(`${BASE}/api/v1/no/such/thing-abc`);
      const raw = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(raw).toContain('"route":"unmatched"');
      expect(raw).not.toContain("thing-abc");
    } finally {
      spy.mockRestore();
    }
  });
});

// ───────────────────────────── ops aggregation (pure) ─────────────────────────────

const listing = (auctionId: string): LiveListing => ({
  auctionId,
  title: `Bike ${auctionId}`,
  status: "LIVE",
  bidCount: 3,
  currentPriceMinor: 5_100_000,
  closesAt: 1_900_000_000_000,
});
const snap = (over: Partial<OpsSnapshot> = {}): OpsSnapshot => ({
  status: "LIVE",
  seq: 10,
  projectedSeq: 10,
  pendingOutbox: 0,
  oldestPendingAgeMs: null,
  viewers: 2,
  bidCount: 4,
  currentPriceMinor: 5_200_000,
  startsAt: 1_800_000_000_000,
  closesAt: 1_900_000_000_000,
  extensionCount: 1,
  lastSyncError: null,
  consecutiveFailures: 0,
  lastSyncSuccessAt: 1_850_000_000_000,
  lastSyncAttemptAt: 1_850_000_000_000,
  bidsLast5m: 2,
  lastBidAt: 1_849_000_000_000,
  overdueTimers: 0,
  deadlineOverdue: false,
  lastAlarmError: null,
  ...over,
});

describe("ops aggregation: per-auction timeout and failure isolation", () => {
  it("settleWithin resolves value / timeout / unavailable, never rejects", async () => {
    expect(await settleWithin(Promise.resolve(1), 50)).toEqual({ ok: true, value: 1 });
    expect(await settleWithin(new Promise(() => {}), 20)).toEqual({
      ok: false,
      error: "timeout",
    });
    expect(await settleWithin(Promise.reject(new Error("boom")), 50)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("a hanging or throwing object is reported on its row; the others still answer, in parallel", async () => {
    const started = Date.now();
    const rows = await collectOps(
      [listing("a"), listing("hang1"), listing("throw"), listing("gone"), listing("hang2")],
      async (id) => {
        if (id.startsWith("hang")) return new Promise<never>(() => {});
        if (id === "throw") throw new Error("DO reset");
        if (id === "gone") return null;
        return snap({ seq: 12, projectedSeq: 9, pendingOutbox: 3, oldestPendingAgeMs: 9_000 });
      },
      100,
    );
    // Two hanging objects cost one timeout, not two (parallel).
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(rows.map((r) => [r.auctionId, r.health, r.error])).toEqual([
      ["a", "lagging", null],
      ["hang1", "unreachable", "timeout"],
      ["throw", "unreachable", "unavailable"],
      ["gone", "unreachable", "not_found"],
      ["hang2", "unreachable", "timeout"],
    ]);
    expect(rows[0]).toMatchObject({ projectionLagSeq: 3, viewers: 2, bidCount: 4 });
    expect(rows[1]).toMatchObject({ seq: null, viewers: null, bidCount: 3 });
  });

  it("health: failing beats lagging; under the SLO is ok; sync errors are e-mail-masked", async () => {
    const rows = await collectOps(
      [listing("f"), listing("ok")],
      async (id) =>
        id === "f"
          ? snap({ consecutiveFailures: 2, lastSyncError: "D1 down for ops@example.org" })
          : snap({ seq: 11, pendingOutbox: 1, oldestPendingAgeMs: 800 }),
      100,
    );
    expect(rows[0]).toMatchObject({ health: "failing", lastSyncError: "D1 down for [email]" });
    expect(rows[1]).toMatchObject({ health: "ok", projectionLagSeq: 1 });
  });

  it("warnings come only from reported data: overdue deadline/timers, alarm failure, unreachable", async () => {
    const rows = await collectOps(
      [listing("late"), listing("fine"), listing("hang")],
      async (id) =>
        id === "late"
          ? snap({
              deadlineOverdue: true,
              overdueTimers: 1,
              lastAlarmError: { at: 1, message: "boom for a@b.co" },
            })
          : id === "fine"
            ? snap()
            : new Promise<never>(() => {}),
      50,
    );
    expect(rows[0]!.lastAlarmError).toEqual({ at: 1, message: "boom for [email]" });
    const codes = rowWarnings(rows).map((w) => [w.auctionId, w.code, w.severity]);
    expect(codes).toEqual([
      ["late", "DEADLINE_OVERDUE", "critical"],
      ["late", "TIMER_OVERDUE", "warn"],
      ["late", "ALARM_FAILED", "warn"],
      ["hang", "AUCTION_UNREACHABLE", "critical"],
    ]);
    // Unreachable rows carry no invented numbers.
    expect(rows[2]).toMatchObject({ viewers: null, bidsLast5m: null, deadlineOverdue: null });
  });
});

// ───────────────────────────── HTTP: ops, ledger, audit ─────────────────────────────

let admin = "";
let buyer = "";
let adminEmail = "";
let auctionId = "";
const RESERVE = 7_777_777;
const HIDDEN_MAX = 6_543_200;
const USER_A = "user-secret-A-0001";
const USER_B = "user-secret-B-0002";

beforeAll(async () => {
  ({ admin, buyer } = await adminAndBuyer());
  adminEmail =
    (
      await env.DB.prepare(`SELECT email FROM "user" WHERE role = 'ADMIN' LIMIT 1`).first<{
        email: string;
      }>()
    )?.email ?? "";
  expect(adminEmail).toContain("@");
  const bikeId = await inspectedBike(admin);
  const res = await createAuctionFor(admin, bikeId, { reserveMinor: RESERVE, schedule: true });
  expect(res.status).toBe(201);
  auctionId = ((await res.json()) as { state: { auctionId: string } }).state.auctionId;

  // Ledger: A's maximum opens (PROXY), B bids manually and is countered (PROXY), B jumps past A.
  const stub = auctionStub(auctionId);
  const setMax = await stub.setMaxBid({
    userId: USER_A,
    maxMinor: HIDDEN_MAX,
    idempotencyKey: key(),
    requestId: "req_test",
  });
  expect(setMax.kind).toBe("evaluated");
  for (let i = 0; i < 2; i++) {
    const view = (await stub.getView(null))!;
    const r = await bid(stub, USER_B, view.minNextBidMinor!);
    expect(r).toMatchObject({ kind: "evaluated", result: { ok: true } });
  }
  const jump = await bid(stub, USER_B, 7_000_000);
  expect(jump).toMatchObject({ kind: "evaluated", result: { ok: true } });
  await stub.retryProjection();
});

describe("metrics end to end (local Analytics Engine binding)", () => {
  it("http_request per request and bid_rejected/bid_accepted from the auction object; no user ids", async () => {
    const sink = (env as unknown as { METRICS: MetricsSink }).METRICS;
    const spy = vi.spyOn(sink, "writeDataPoint");
    try {
      await exports.default.fetch(`${BASE}/api/v1/auctions/${auctionId}`);
      const stub = auctionStub(auctionId);
      await bid(stub, USER_A, 100); // far below the minimum
      const view = (await stub.getView(null))!;
      await bid(stub, USER_A, view.minNextBidMinor!);
      const points = spy.mock.calls.map((c) => c[0]);
      expect(points).toContainEqual({
        indexes: ["GET /api/v1/auctions/:id"],
        blobs: [
          "http_request",
          "GET /api/v1/auctions/:id",
          "2xx",
          "ok",
          "200",
          "",
          expect.any(String),
        ],
        doubles: [expect.any(Number), 1, 0],
      });
      expect(points).toContainEqual(
        expect.objectContaining({
          indexes: [auctionId],
          blobs: expect.arrayContaining(["bid_rejected", "BID_TOO_LOW"]),
        }),
      );
      expect(points).toContainEqual(
        expect.objectContaining({
          indexes: [auctionId],
          blobs: expect.arrayContaining(["bid_accepted", "MANUAL"]),
        }),
      );
      const all = JSON.stringify(points);
      expect(all).not.toContain(USER_A);
      expect(all).not.toContain(String(RESERVE));
    } finally {
      spy.mockRestore();
    }
  });

  it("auction lifecycle and auth security signals are recorded", async () => {
    const sink = (env as unknown as { METRICS: MetricsSink }).METRICS;
    const spy = vi.spyOn(sink, "writeDataPoint");
    try {
      const { stub } = await createAuction();
      await stub.cancel("Withdrawn by the seller");
      await call("POST", "/auth/sign-in/email", {
        body: { email: "nobody@example.org", password: "wrong-password-123" },
      });
      const points = spy.mock.calls.map((c) => c[0]);
      expect(points).toContainEqual(
        expect.objectContaining({
          blobs: expect.arrayContaining(["auction_lifecycle", "cancelled"]),
        }),
      );
      const auth = points.find((p) => p.blobs?.[0] === "auth_security");
      expect(auth?.blobs?.[1]).toMatch(/^POST \/api\/v1\/auth\//);
      expect(auth?.blobs?.[2]).toBe("4xx");
      expect(JSON.stringify(points)).not.toContain("nobody@example.org");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /admin/ops/summary", () => {
  it("anonymous 401, buyer 403", async () => {
    expect((await call("GET", "/admin/ops/summary")).status).toBe(401);
    expect((await call("GET", "/admin/ops/summary", { cookie: buyer })).status).toBe(403);
  });

  it("returns live auctions with ops numbers and viewers (strict contract), no PII", async () => {
    await auctionStub(auctionId).retryProjection();
    const sock = await connect(auctionId);
    try {
      await until(() => sock.messages.some((m) => m.type === "auction.snapshot"));
      const res = await call("GET", "/admin/ops/summary", { cookie: admin });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      const body = OpsSummary.parse(JSON.parse(text));
      const row = body.auctions.find((a) => a.auctionId === auctionId)!;
      expect(row).toMatchObject({
        status: "LIVE",
        health: "ok",
        error: null,
        title: expect.stringContaining("Royal Enfield"),
        projectionLagSeq: 0,
        pendingOutbox: 0,
        currentPriceMinor: (await auctionStub(auctionId).getView(null))!.currentPriceMinor,
      });
      expect(row.viewers).toBeGreaterThanOrEqual(1);
      expect(row.bidCount).toBeGreaterThanOrEqual(4);
      expect(row.bidsLast5m).toBeGreaterThanOrEqual(4);
      expect(row.lastSyncSuccessAt).toBeGreaterThan(0);
      expect(row.deadlineOverdue).toBe(false);
      expect(row.extensionCount).toBe(0);
      expect(body.global.totalViewers).toBeGreaterThanOrEqual(1);
      expect(body.global.liveCount ?? 0).toBeGreaterThanOrEqual(1);
      expect(body.global.d1.status).toBe("ok");
      expect(body.global.metricsBound).toBe(true);
      expect(body.global.bidsLast5m).toBeGreaterThanOrEqual(4);
      expect(body.global.lastSuccessfulSyncAt).toBeGreaterThan(0);
      expect(body.warnings.filter((w) => w.auctionId === auctionId)).toEqual([]);
      for (const leak of [USER_A, USER_B, String(RESERVE), String(HIDDEN_MAX), "@", adminEmail])
        if (leak) expect(text).not.toContain(leak);
    } finally {
      sock.ws?.close();
    }
  });

  it("a live read-model row with no auction object is reported per row, not a failed call", async () => {
    const ghost = `auc_ghost_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO auctions_rm (id, status, bid_count, closes_at, starts_at, projection_seq, updated_at)
       VALUES (?, 'LIVE', 0, ?, ?, 1, ?)`,
    )
      .bind(ghost, now + 3_600_000, now - 60_000, now)
      .run();
    try {
      const res = await call("GET", "/admin/ops/summary", { cookie: admin });
      expect(res.status).toBe(200);
      const body = OpsSummary.parse(await res.json());
      expect(body.auctions.find((a) => a.auctionId === ghost)).toMatchObject({
        health: "unreachable",
        error: "not_found",
        title: ghost,
        seq: null,
      });
      expect(body.global.auctionsUnreachable).toBeGreaterThanOrEqual(1);
      expect(body.global.status).toBe("degraded");
      expect(body.warnings).toContainEqual(
        expect.objectContaining({ code: "AUCTION_UNREACHABLE", auctionId: ghost }),
      );
      expect(body.auctions.find((a) => a.auctionId === auctionId)?.health).toBe("ok");
    } finally {
      await env.DB.prepare(`DELETE FROM auctions_rm WHERE id = ?`).bind(ghost).run();
    }
  });

  it("detects a stuck read model (stored LIVE long after close / SCHEDULED after start)", async () => {
    const now = Date.now();
    const [late, notStarted] = [`auc_stale_${Date.now()}`, `auc_unstarted_${Date.now()}`];
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO auctions_rm (id, status, bid_count, closes_at, starts_at, projection_seq, updated_at)
         VALUES (?, 'LIVE', 0, ?, ?, 1, ?)`,
      ).bind(late, now - 10 * 60_000, now - 3_600_000, now),
      env.DB.prepare(
        `INSERT INTO auctions_rm (id, status, bid_count, closes_at, starts_at, projection_seq, updated_at)
         VALUES (?, 'SCHEDULED', 0, ?, ?, 1, ?)`,
      ).bind(notStarted, now + 3_600_000, now - 5 * 60_000, now),
    ]);
    try {
      const health = await call("GET", "/admin/ops/health", { cookie: admin });
      expect(health.status).toBe(200);
      const h = AdminHealth.parse(await health.json());
      expect(h).toMatchObject({ status: "degraded", checks: { d1: { status: "ok" } } });
      const stale = h.warnings.filter((w) => w.code === "READ_MODEL_STALE").map((w) => w.auctionId);
      expect(stale).toEqual(expect.arrayContaining([late, notStarted]));

      const summary = OpsSummary.parse(
        await (await call("GET", "/admin/ops/summary", { cookie: admin })).json(),
      );
      expect(summary.warnings.map((w) => w.auctionId)).toEqual(
        expect.arrayContaining([late, notStarted]),
      );
    } finally {
      await env.DB.batch(
        [late, notStarted].map((id) =>
          env.DB.prepare(`DELETE FROM auctions_rm WHERE id = ?`).bind(id),
        ),
      );
    }
  });

  it("admin health is admin-only; the public /status stays minimal", async () => {
    expect((await call("GET", "/admin/ops/health")).status).toBe(401);
    expect((await call("GET", "/admin/ops/health", { cookie: buyer })).status).toBe(403);
    const pub = (await (await call("GET", "/status")).json()) as Record<string, unknown>;
    expect(Object.keys(pub).sort()).toEqual(
      ["checks", "environment", "serverTime", "status", "version"].sort(),
    );
    expect(JSON.stringify(pub)).not.toContain("warnings");
  });

  it(`is bounded: at most ${OPS_SUMMARY_MAX_AUCTIONS} objects per call, truncation reported`, async () => {
    const now = Date.now();
    const ids = Array.from({ length: OPS_SUMMARY_MAX_AUCTIONS + 3 }, (_, i) => `auc_bulk_${i}`);
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare(
          `INSERT INTO auctions_rm (id, status, bid_count, closes_at, starts_at, projection_seq, updated_at)
           VALUES (?, 'LIVE', 0, ?, ?, 1, ?)`,
        ).bind(id, now + 60_000, now - 60_000, now),
      ),
    );
    try {
      const body = OpsSummary.parse(
        await (await call("GET", "/admin/ops/summary", { cookie: admin })).json(),
      );
      expect(body.auctions.length).toBe(OPS_SUMMARY_MAX_AUCTIONS);
      expect(body.global.shown).toBe(OPS_SUMMARY_MAX_AUCTIONS);
      expect(body.global.liveCount ?? 0).toBeGreaterThan(OPS_SUMMARY_MAX_AUCTIONS);
      expect(body.global.truncated).toBe(true);
      expect(body.warnings.map((w) => w.code)).toContain("TRUNCATED");
    } finally {
      await env.DB.batch(
        ids.map((id) => env.DB.prepare(`DELETE FROM auctions_rm WHERE id = ?`).bind(id)),
      );
    }
  });
});

describe("GET /admin/auctions/:id/ledger", () => {
  it("anonymous 401, buyer 403, unknown 404, bad query 422", async () => {
    const p = `/admin/auctions/${auctionId}/ledger`;
    expect((await call("GET", p)).status).toBe(401);
    expect((await call("GET", p, { cookie: buyer })).status).toBe(403);
    expect((await call("GET", "/admin/auctions/auc_nope_1/ledger", { cookie: admin })).status).toBe(
      404,
    );
    const bad = await call("GET", `${p}?limit=500`, { cookie: admin });
    expect(bad.status).toBe(422);
    expect(ProblemDetails.parse(await bad.json()).code).toBe("VALIDATION_FAILED");
  });

  it("pages newest first by seq, with kinds; pseudonymous; no user ids, maxima or reserve", async () => {
    const seen: number[] = [];
    const kinds = new Set<string>();
    let cursor: number | null = null;
    let pages = 0;
    const texts: string[] = [];
    do {
      const q: string = cursor ? `?limit=2&beforeSeq=${cursor}` : "?limit=2";
      const res = await call("GET", `/admin/auctions/${auctionId}/ledger${q}`, { cookie: admin });
      expect(res.status).toBe(200);
      const text = await res.text();
      texts.push(text);
      const page = AdminLedgerPage.parse(JSON.parse(text));
      expect(page.items.length).toBeLessThanOrEqual(2);
      page.items.forEach((b, i) => {
        seen.push(b.seq);
        kinds.add(b.kind);
        expect(b.isLeading).toBe(pages === 0 && i === 0);
        expect(b.bidder).toMatch(/^Bidder /);
      });
      cursor = page.nextBeforeSeq;
      pages++;
    } while (cursor !== null && pages < 20);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen).toEqual([...seen].sort((a, b) => b - a)); // strictly newest first
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
    expect(kinds).toEqual(new Set(["MANUAL", "PROXY"]));
    const all = texts.join("\n");
    for (const leak of [USER_A, USER_B, String(HIDDEN_MAX), String(RESERVE), "userId", "maxMinor"])
      expect(all).not.toContain(leak);
  });
});

describe("GET /admin/audit (+ facets)", () => {
  it("anonymous 401, buyer 403", async () => {
    expect((await call("GET", "/admin/audit")).status).toBe(401);
    expect((await call("GET", "/admin/audit", { cookie: buyer })).status).toBe(403);
    expect((await call("GET", "/admin/audit/facets", { cookie: buyer })).status).toBe(403);
  });

  it("lists newest first with actor name; filters by action, resource and date", async () => {
    const all = AuditPage.parse(
      await (await call("GET", "/admin/audit", { cookie: admin })).json(),
    );
    expect(all.items.length).toBeGreaterThanOrEqual(3); // bike, inspection, auction created
    const times = all.items.map((i) => i.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all.items[0]!.actor.name).toBe("Test Rider");

    const created = AuditPage.parse(
      await (await call("GET", "/admin/audit?action=AUCTION_CREATED", { cookie: admin })).json(),
    );
    expect(created.items.length).toBeGreaterThanOrEqual(1);
    expect(created.items.every((i) => i.action === "AUCTION_CREATED")).toBe(true);

    const forAuction = AuditPage.parse(
      await (
        await call("GET", `/admin/audit?resourceType=auction&resourceId=${auctionId}`, {
          cookie: admin,
        })
      ).json(),
    );
    expect(forAuction.items.map((i) => i.action)).toContain("AUCTION_CREATED");

    const future = AuditPage.parse(
      await (
        await call("GET", `/admin/audit?from=${Date.now() + 60_000}`, { cookie: admin })
      ).json(),
    );
    expect(future.items).toEqual([]);

    const actorId = all.items[0]!.actor.id;
    const byActor = AuditPage.parse(
      await (await call("GET", `/admin/audit?actorId=${actorId}`, { cookie: admin })).json(),
    );
    expect(byActor.items.every((i) => i.actor.id === actorId)).toBe(true);
    const none = AuditPage.parse(
      await (await call("GET", `/admin/audit?actorId=nobody_123`, { cookie: admin })).json(),
    );
    expect(none.items).toEqual([]);
  });

  it("keyset pagination is complete and stable; bad params are 422", async () => {
    const full = AuditPage.parse(
      await (await call("GET", "/admin/audit?limit=100", { cookie: admin })).json(),
    );
    const ids: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const res = await call("GET", `/admin/audit?limit=2${cursor ? `&cursor=${cursor}` : ""}`, {
        cookie: admin,
      });
      const page = AuditPage.parse(await res.json());
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor && ++guard < 100);
    expect(ids).toEqual(full.items.map((i) => i.id));

    for (const q of ["cursor=nope", "action=lower_case", "limit=0", "from=abc", "extra=1"]) {
      const res = await call("GET", `/admin/audit?${q}`, { cookie: admin });
      expect(res.status, q).toBe(422);
    }
  });

  it("facets list actions and admin names only (no e-mails)", async () => {
    const res = await call("GET", "/admin/audit/facets", { cookie: admin });
    const text = await res.text();
    const f = AuditFacets.parse(JSON.parse(text));
    expect(f.actions).toContain("AUCTION_CREATED");
    expect(f.actors.length).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain("@");
  });
});

afterAll(async () => {
  // Let post-commit waitUntil drains settle before the isolate is torn down.
  await sleep(50);
});
