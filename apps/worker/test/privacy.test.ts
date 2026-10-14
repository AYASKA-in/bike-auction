import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  AccountExport,
  AccountSummary,
  CURRENT_SIGN_UP_CONSENT,
  DeletionBlocker,
  PRIVACY_NOTICE_VERSION,
} from "@bike/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { BATCH, DAY_MS, retentionPeriods, runRetention } from "../src/lib/retention";
import {
  BASE,
  cookieFrom,
  get,
  mockTurnstile,
  post,
  signIn,
  signUp,
  uniqueEmail,
} from "./auth-helpers";
import { call, createAuctionFor, inspectedBike, iso } from "./catalogue-helpers";
import { auctionStub, sleep, waitFor } from "./helpers";

// DPDP features (Day 8): consent at sign-up, export, deletion, retention. docs/privacy.md.

let admin = "";

beforeAll(async () => {
  const spy = mockTurnstile();
  try {
    const ad = await signUp();
    await env.DB.prepare(`UPDATE "user" SET role = 'ADMIN' WHERE email = ?`).bind(ad.email).run();
    admin = (await signIn(ad.email, ad.password)).cookie;
  } finally {
    spy.mockRestore();
  }
});

async function withCaptcha<T>(fn: () => Promise<T>): Promise<T> {
  const spy = mockTurnstile();
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

const newUser = () => withCaptcha(() => signUp());

const userIdOf = async (email: string) =>
  (
    await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
      .bind(email)
      .first<{ id: string }>()
  )?.id ?? null;

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n;

async function auction(over: Record<string, unknown> = {}): Promise<string> {
  const bike = await inspectedBike(admin, { make: "Bajaj", model: "Pulsar 220F" });
  const res = await createAuctionFor(admin, bike, { schedule: true, reserveMinor: null, ...over });
  const body = (await res.json()) as { state?: { auctionId: string } };
  if (!body.state) throw new Error(`auction fixture: ${res.status} ${JSON.stringify(body)}`);
  return body.state.auctionId;
}

async function bid(id: string, cookie: string, amountMinor: number) {
  const res = await exports.default.fetch(`${BASE}/api/v1/auctions/${id}/bids`, {
    method: "POST",
    headers: {
      origin: BASE,
      cookie,
      "content-type": "application/json",
      "idempotency-key": `k-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ amountMinor }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

async function setMax(id: string, cookie: string, maxMinor: number) {
  const res = await exports.default.fetch(`${BASE}/api/v1/auctions/${id}/max-bid`, {
    method: "PUT",
    headers: {
      origin: BASE,
      cookie,
      "content-type": "application/json",
      "idempotency-key": `k-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ maxMinor }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

const project = (id: string) => auctionStub(id).retryProjection();

function deleteMe(cookie: string, confirmEmail: unknown) {
  return call("DELETE", "/me", { cookie, body: { confirmEmail } });
}

const problem = async (res: Response) =>
  (await res.json()) as { code: string; detail?: string; blockers?: unknown };

// ─────────────────────────────── consent ───────────────────────────────

describe("consent at sign-up", () => {
  const base = () => ({
    email: uniqueEmail("consent"),
    password: "Kickstart-Pulsar-220",
    name: "Asha Rao",
  });

  it("refuses sign-up without consent and creates nothing", async () => {
    const body = base();
    const res = await withCaptcha(() => post("/api/v1/auth/sign-up/email", body));
    expect(res.status).toBe(422);
    const p = await problem(res);
    expect(p.code).toBe("VALIDATION_FAILED");
    expect(p.detail).toMatch(/Privacy Notice/);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await userIdOf(body.email)).toBeNull();
  });

  it.each([
    ["not accepted", { accepted: false, version: PRIVACY_NOTICE_VERSION }],
    ["an outdated notice version", { accepted: true, version: "2020-01-01" }],
    ["a malformed value", "yes"],
  ])("refuses consent with %s", async (_label, consent) => {
    const body = { ...base(), consent };
    const res = await withCaptcha(() => post("/api/v1/auth/sign-up/email", body));
    expect(res.status).toBe(422);
    expect(await userIdOf(body.email)).toBeNull();
  });

  it("records the consent (purpose, notice version, time) and shows it on /me/account", async () => {
    const before = Date.now();
    const { email, cookie, res } = await newUser();
    expect(res.status).toBe(200);
    const id = (await userIdOf(email))!;
    const rows = await env.DB.prepare(`SELECT purpose, version, at FROM consents WHERE user_id = ?`)
      .bind(id)
      .all<{ purpose: string; version: string; at: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      purpose: "ACCOUNT_AND_BIDDING",
      version: PRIVACY_NOTICE_VERSION,
    });
    expect(rows.results[0]!.at).toBeGreaterThanOrEqual(before);

    const summary = await call("GET", "/me/account", { cookie });
    expect(summary.status).toBe(200);
    expect(summary.headers.get("cache-control")).toBe("no-store");
    const s = AccountSummary.parse(await summary.json());
    expect(s).toMatchObject({ email, role: "USER", noticeVersion: PRIVACY_NOTICE_VERSION });
    expect(s.consents).toHaveLength(1);
  });

  it("keeps the specific errors for captcha failures and duplicates (checked first)", async () => {
    const body = { ...base(), consent: CURRENT_SIGN_UP_CONSENT };
    expect(
      (
        await problem(
          await withCaptcha(() => post("/api/v1/auth/sign-up/email", body, { captcha: "nope" })),
        )
      ).code,
    ).toBe("CAPTCHA_FAILED");
    const { email } = await newUser();
    const dup = await withCaptcha(() =>
      post("/api/v1/auth/sign-up/email", { ...base(), email, consent: CURRENT_SIGN_UP_CONSENT }),
    );
    expect((await problem(dup)).code).toBe("ACCOUNT_EXISTS");
  });
});

// ─────────────────────────────── export ───────────────────────────────

describe("GET /me/export", () => {
  let alice: Awaited<ReturnType<typeof newUser>>;
  let bob: Awaited<ReturnType<typeof newUser>>;
  let auctionId = "";

  beforeAll(async () => {
    alice = await newUser();
    bob = await newUser();
    auctionId = await auction();
    await bid(auctionId, alice.cookie, 5_000_000);
    await setMax(auctionId, bob.cookie, 5_432_100); // bob's hidden maximum: must never leak
    await setMax(auctionId, alice.cookie, 6_000_000); // alice's own: must be in HER export
    expect((await call("PUT", `/me/watchlist/${auctionId}`, { cookie: alice.cookie })).status).toBe(
      204,
    );
    expect((await call("PUT", `/me/watchlist/${auctionId}`, { cookie: bob.cookie })).status).toBe(
      204,
    );
    await project(auctionId);
  }, 30_000);

  it("requires a session", async () => {
    expect((await get("/api/v1/me/export")).status).toBe(401);
  });

  it("returns the caller's data as a strict JSON attachment", async () => {
    const res = await call("GET", "/me/export", { cookie: alice.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="bike-auction-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = AccountExport.parse(await res.json()); // strict: no unexpected fields
    expect(data.account.email).toBe(alice.email);
    expect(data.consents).toEqual([
      expect.objectContaining({ purpose: "ACCOUNT_AND_BIDDING", version: PRIVACY_NOTICE_VERSION }),
    ]);
    expect(data.watchlist.map((w) => w.auctionId)).toEqual([auctionId]);
    expect(data.bids).toEqual([expect.objectContaining({ auctionId, youWon: false })]);
    expect(data.maxBids).toEqual([
      {
        auctionId,
        title: expect.any(String),
        maxMinor: 6_000_000,
        auctionStatus: "LIVE",
        youAreLeading: true,
      },
    ]);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
    expect(data.securityEvents.map((e) => e.type)).toContain("auth.sign_up");
  });

  it("contains no other user's data and no secrets", async () => {
    const raw = await (await call("GET", "/me/export", { cookie: alice.cookie })).text();
    const bobId = (await userIdOf(bob.email))!;
    expect(raw).not.toContain(bob.email);
    expect(raw).not.toContain(bobId);
    expect(raw).not.toContain("5432100"); // bob's hidden maximum
    const bobRaw = await (await call("GET", "/me/export", { cookie: bob.cookie })).text();
    expect(bobRaw).not.toContain("6000000"); // and alice's is not in bob's export
    expect(bobRaw).not.toContain(alice.email);
    expect(raw).not.toContain("Bidder "); // no pseudonyms
    const aliceId = (await userIdOf(alice.email))!;
    const secrets = await env.DB.batch([
      env.DB.prepare(`SELECT token FROM "session" WHERE "userId" = ?`).bind(aliceId),
      env.DB.prepare(`SELECT password FROM "account" WHERE "userId" = ?`).bind(aliceId),
      env.DB.prepare(`SELECT subject_hash, ip_hash FROM security_events WHERE user_id = ?`).bind(
        aliceId,
      ),
    ]);
    for (const r of secrets.flatMap((s) => s.results as Record<string, string | null>[])) {
      for (const v of Object.values(r)) if (v) expect(raw).not.toContain(v);
    }
    expect(raw).not.toMatch(/"password"|"token"/);
  });

  it("is logged as a security event for the user", async () => {
    const id = (await userIdOf(alice.email))!;
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM security_events WHERE user_id = ? AND type = 'account.exported'`,
        id,
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it("is rate limited per user (20 / minute)", async () => {
    const u = await newUser();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push((await call("GET", "/me/export", { cookie: u.cookie })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    // Another user's budget is unaffected.
    expect((await call("GET", "/me/export", { cookie: bob.cookie })).status).toBe(200);
  });
});

// ─────────────────────────────── deletion ───────────────────────────────

describe("DELETE /me", () => {
  it("requires a session and the exact email as confirmation", async () => {
    expect((await call("DELETE", "/me", { body: { confirmEmail: "x@example.org" } })).status).toBe(
      401,
    );
    const u = await newUser();
    for (const confirm of ["someone.else@example.org", "", 42, undefined]) {
      const res = await deleteMe(u.cookie, confirm);
      expect(res.status).toBe(422);
    }
    expect(await userIdOf(u.email)).not.toBeNull();
    expect((await get("/api/v1/me", u.cookie)).status).toBe(200);
  });

  it("refuses administrators (403) and leaves them intact", async () => {
    const me = (await (await get("/api/v1/me", admin)).json()) as { email: string };
    expect((await deleteMe(admin, me.email)).status).toBe(403);
    expect((await get("/api/v1/me", admin)).status).toBe(200);
  });

  it("refuses with 409 while the user leads a LIVE auction, then succeeds once outbid", async () => {
    const lead = await newUser();
    const rival = await newUser();
    const id = await auction();
    await bid(id, lead.cookie, 5_000_000);
    await project(id);

    const refused = await deleteMe(lead.cookie, lead.email.toUpperCase()); // case-insensitive
    expect(refused.status).toBe(409);
    const p = await problem(refused);
    expect(p.code).toBe("CONFLICT");
    expect(p.detail).toMatch(/highest bid or an active maximum bid in a live auction/);
    expect(DeletionBlocker.array().parse(p.blockers)).toEqual([
      { auctionId: id, title: expect.any(String), reason: "LEADING_LIVE_AUCTION" },
    ]);
    const leadId = (await userIdOf(lead.email))!;
    expect((await get("/api/v1/me", lead.cookie)).status).toBe(200);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM security_events WHERE user_id = ? AND type = 'account.delete_refused'`,
        leadId,
      ),
    ).toBe(1);

    await bid(id, rival.cookie, 5_050_000);
    await project(id);
    const ok = await deleteMe(lead.cookie, lead.email);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ deleted: true });
  }, 30_000);

  it("refuses right after a max-bid even before D1 has the projection (review HIGH-1)", async () => {
    const u = await newUser();
    const id = await auction();
    // No project(): the D1 read model doesn't know this user bid yet. The DO is asked anyway.
    await setMax(id, u.cookie, 6_000_000);
    const refused = await deleteMe(u.cookie, u.email);
    expect(refused.status).toBe(409);
    expect((await problem(refused)).blockers).toEqual([expect.objectContaining({ auctionId: id })]);
    // Rolled back: the user can still act there (raising the maximum is accepted, 200).
    await setMax(id, u.cookie, 7_000_000);
  }, 30_000);

  it("a deleted account is retired in every open auction: no further bids or maxima", async () => {
    const u = await newUser();
    const id = await auction();
    const userId = (await userIdOf(u.email))!;
    expect((await deleteMe(u.cookie, u.email)).status).toBe(200);
    // An in-flight command that already passed authentication reaches the DO after deletion.
    const stub = auctionStub(id);
    const r = await stub.placeBid({
      userId,
      amountMinor: 5_000_000,
      idempotencyKey: "late-request-key-0001",
      requestId: "req_late",
    });
    expect(r.kind).toBe("account_closed");
    const m = await stub.setMaxBid({
      userId,
      maxMinor: 6_000_000,
      idempotencyKey: "late-request-key-0002",
      requestId: "req_late2",
    });
    expect(m.kind).toBe("account_closed");
  }, 30_000);

  it("refuses while the user won an auction inside the settlement window", async () => {
    const winner = await newUser();
    const bike = await inspectedBike(admin, { make: "Hero", model: "Splendor Plus" });
    const created = (await (
      await createAuctionFor(admin, bike, {
        schedule: true,
        reserveMinor: null,
        startsAt: iso(-61_000),
        closesAt: iso(2_500),
        antiSniping: false,
      })
    ).json()) as { state: { auctionId: string } };
    const id = created.state.auctionId;
    await bid(id, winner.cookie, 5_000_000);
    await sleep(2_800);
    await auctionStub(id).getView(null); // resolves the due close
    await project(id);
    const res = await deleteMe(winner.cookie, winner.email);
    expect(res.status).toBe(409);
    const p = await problem(res);
    expect(DeletionBlocker.array().parse(p.blockers)[0]).toMatchObject({
      auctionId: id,
      reason: "WON_UNSETTLED_AUCTION",
    });
    expect(p.detail).toMatch(/settlement window/);
  }, 30_000);

  describe("a successful deletion", () => {
    let u: Awaited<ReturnType<typeof newUser>>;
    let otherSession = "";
    let id = "";
    let auctionId = "";
    let res: Response;

    beforeAll(async () => {
      u = await newUser();
      otherSession = (await withCaptcha(() => signIn(u.email, u.password))).cookie; // 2nd device
      id = (await userIdOf(u.email))!;
      const rival = await newUser();
      auctionId = await auction();
      await bid(auctionId, u.cookie, 5_000_000);
      await bid(auctionId, rival.cookie, 5_050_000); // u is outbid → deletion allowed
      expect((await call("PUT", `/me/watchlist/${auctionId}`, { cookie: u.cookie })).status).toBe(
        204,
      );
      await project(auctionId);
      await waitFor(
        async () =>
          (await count(`SELECT COUNT(*) AS n FROM user_bids_rm WHERE user_id = ?`, id)) === 1,
      );
      res = await deleteMe(u.cookie, u.email);
    }, 30_000);

    it("answers 200 and expires the session cookies", () => {
      expect(res.status).toBe(200);
      const cleared = res.headers.getSetCookie();
      expect(cleared.length).toBeGreaterThanOrEqual(1);
      expect(cleared.every((c) => /Max-Age=0/.test(c) && /HttpOnly/.test(c))).toBe(true);
      expect(cleared.some((c) => c.startsWith("ba.session_token="))).toBe(true);
    });

    it("revokes every session, on every device", async () => {
      expect((await get("/api/v1/me", u.cookie)).status).toBe(401);
      expect((await get("/api/v1/me", otherSession)).status).toBe(401);
      expect(await count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`, id)).toBe(0);
    });

    it("erases the account, credentials, watchlist and consents", async () => {
      expect(await userIdOf(u.email)).toBeNull();
      expect(await count(`SELECT COUNT(*) AS n FROM "account" WHERE "userId" = ?`, id)).toBe(0);
      expect(await count(`SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?`, id)).toBe(0);
      expect(await count(`SELECT COUNT(*) AS n FROM consents WHERE user_id = ?`, id)).toBe(0);
      const signin = await withCaptcha(() => signIn(u.email, u.password));
      expect(signin.res.status).toBe(401);
    });

    it("anonymises 'My bids' rows and keeps the pseudonymous auction ledger", async () => {
      expect(await count(`SELECT COUNT(*) AS n FROM user_bids_rm WHERE user_id = ?`, id)).toBe(0);
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM user_bids_rm WHERE auction_id = ? AND user_id LIKE 'deleted_%'`,
          auctionId,
        ),
      ).toBe(1);
      const view = await auctionStub(auctionId).getView(null);
      expect(view?.bidCount).toBe(2); // the auction's record is intact for the other bidder
      expect(
        await count(`SELECT COUNT(*) AS n FROM auction_bids_rm WHERE auction_id = ?`, auctionId),
      ).toBe(2);
    });

    it("leaves a minimal deletion record, an audit entry and a security event", async () => {
      const rec = await env.DB.prepare(`SELECT * FROM account_deletions WHERE user_id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      expect(rec).toMatchObject({ user_id: id, bid_rows_anonymised: 1 });
      expect(Object.keys(rec!).sort()).toEqual(
        ["bid_rows_anonymised", "deleted_at", "request_id", "user_id"].sort(),
      );
      expect(JSON.stringify(rec)).not.toContain(u.email);
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ACCOUNT_DELETED' AND resource_id = ? AND actor_user_id = ?`,
          id,
          id,
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM security_events WHERE user_id = ? AND type = 'account.deleted'`,
          id,
        ),
      ).toBe(1);
    });

    it("is idempotent: a retry is 401 and changes nothing", async () => {
      const again = await deleteMe(u.cookie, u.email);
      expect(again.status).toBe(401);
      expect(await count(`SELECT COUNT(*) AS n FROM account_deletions WHERE user_id = ?`, id)).toBe(
        1,
      );
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ACCOUNT_DELETED' AND resource_id = ?`,
          id,
        ),
      ).toBe(1);
    });

    it("lets the same email register again as a brand-new account", async () => {
      const again = await withCaptcha(() => signUp(u.email));
      expect(again.res.status).toBe(200);
      expect(await userIdOf(u.email)).not.toBe(id);
      expect(cookieFrom(again.res)).toContain("ba.session_token=");
    });
  });
});

// ─────────────────────────────── retention ───────────────────────────────

describe("retention job", () => {
  const now = Date.now();
  const old = now - 366 * DAY_MS;
  let userId = "";
  let staleAuction = "";
  let freshAuction = "";

  async function listing(status: string, closesAt: number) {
    const bike = await inspectedBike(admin, { make: "TVS", model: "Apache RTR 160" });
    const auctionId = `ret-${crypto.randomUUID().slice(0, 12)}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO auction_listings (auction_id, bike_id, title, active, created_by, created_at) VALUES (?, ?, 'Retention fixture', 0, 'test', ?)`,
      ).bind(auctionId, bike, now),
      env.DB.prepare(
        `INSERT INTO auctions_rm (id, status, closes_at, starts_at, start_price_minor, updated_at) VALUES (?, ?, ?, ?, 100, ?)`,
      ).bind(auctionId, status, closesAt, closesAt - DAY_MS, closesAt),
    ]);
    return auctionId;
  }

  beforeAll(async () => {
    const u = await newUser();
    userId = (await userIdOf(u.email))!;
    staleAuction = await listing("ENDED", now - 91 * DAY_MS);
    freshAuction = await listing("ENDED", now - 10 * DAY_MS);
    const iso = (t: number) => new Date(t).toISOString();
    const stmts = [
      // security_events: BATCH + 5 old rows (needs two rounds) and one recent row.
      ...Array.from({ length: BATCH + 5 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO security_events (id, type, user_id, request_id, created_at) VALUES (?, 'test.old', ?, 'req_t', ?)`,
        ).bind(`sev_old_${i}_${crypto.randomUUID()}`, userId, old - i),
      ),
      env.DB.prepare(
        `INSERT INTO security_events (id, type, user_id, request_id, created_at) VALUES (?, 'test.recent', ?, 'req_t', ?)`,
      ).bind(`sev_recent_${crypto.randomUUID()}`, userId, now - 300 * DAY_MS),
      // sessions: one expired, one live (the user's own sign-up session is live too).
      env.DB.prepare(
        `INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        "ses_expired_ret",
        iso(now - 1000),
        `tok_${crypto.randomUUID()}`,
        iso(old),
        iso(old),
        userId,
      ),
      env.DB.prepare(
        `INSERT INTO "verification" (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind("ver_expired_ret", "reset-password:x", userId, iso(now - 1000), iso(old), iso(old)),
      env.DB.prepare(
        `INSERT INTO "verification" (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind("ver_live_ret", "reset-password:y", userId, iso(now + DAY_MS), iso(now), iso(now)),
      // login_throttle: stale, recent, and an old-but-still-locked row.
      env.DB.prepare(
        `INSERT INTO login_throttle (key, failures, locked_until, updated_at) VALUES (?, 3, 0, ?)`,
      ).bind("ret_stale", now - 2 * DAY_MS),
      env.DB.prepare(
        `INSERT INTO login_throttle (key, failures, locked_until, updated_at) VALUES (?, 3, 0, ?)`,
      ).bind("ret_recent", now - 60_000),
      env.DB.prepare(
        `INSERT INTO login_throttle (key, failures, locked_until, updated_at) VALUES (?, 9, ?, ?)`,
      ).bind("ret_locked", now + 60_000, now - 2 * DAY_MS),
      // watchlist: one stale (ended 91 days ago), one recent.
      env.DB.prepare(
        `INSERT INTO watchlist (user_id, auction_id, created_at) VALUES (?, ?, ?)`,
      ).bind(userId, staleAuction, old),
      env.DB.prepare(
        `INSERT INTO watchlist (user_id, auction_id, created_at) VALUES (?, ?, ?)`,
      ).bind(userId, freshAuction, old),
      // A "My bids" row re-created for an already-deleted account (late projection replay).
      env.DB.prepare(
        `INSERT INTO account_deletions (user_id, deleted_at, request_id) VALUES ('usr_gone_ret', ?, 'req_t')`,
      ).bind(now - DAY_MS),
      env.DB.prepare(
        `INSERT INTO user_bids_rm (user_id, auction_id, highest_amount_minor, last_bid_seq, updated_at) VALUES ('usr_gone_ret', ?, 100, 1, ?)`,
      ).bind(freshAuction, now),
      env.DB.prepare(
        `INSERT INTO account_deletions (user_id, deleted_at, request_id) VALUES ('usr_ancient_ret', ?, 'req_t')`,
      ).bind(old),
    ];
    await env.DB.batch(stmts);
  }, 30_000);

  it("purges exactly what the retention schedule says, in bounded batches", async () => {
    const report = await runRetention(env, now);
    expect(report.security_events).toBeGreaterThanOrEqual(BATCH + 5);
    expect(await count(`SELECT COUNT(*) AS n FROM security_events WHERE type = 'test.old'`)).toBe(
      0,
    );
    expect(
      await count(`SELECT COUNT(*) AS n FROM security_events WHERE type = 'test.recent'`),
    ).toBe(1);

    expect(await count(`SELECT COUNT(*) AS n FROM "session" WHERE id = 'ses_expired_ret'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`, userId)).toBe(1); // live one kept
    expect(
      await count(`SELECT COUNT(*) AS n FROM "verification" WHERE id = 'ver_expired_ret'`),
    ).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "verification" WHERE id = 'ver_live_ret'`)).toBe(
      1,
    );

    const keys = await env.DB.prepare(
      `SELECT key FROM login_throttle WHERE key LIKE 'ret_%' ORDER BY key`,
    ).all<{
      key: string;
    }>();
    expect(keys.results.map((r) => r.key)).toEqual(["ret_locked", "ret_recent"]);

    const watched = await env.DB.prepare(`SELECT auction_id FROM watchlist WHERE user_id = ?`)
      .bind(userId)
      .all<{ auction_id: string }>();
    expect(watched.results.map((r) => r.auction_id)).toEqual([freshAuction]);

    expect(
      await count(`SELECT COUNT(*) AS n FROM user_bids_rm WHERE user_id = 'usr_gone_ret'`),
    ).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM account_deletions WHERE user_id = 'usr_ancient_ret'`),
    ).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM account_deletions WHERE user_id = 'usr_gone_ret'`),
    ).toBe(1);
    expect(Object.values(report)).not.toContain("failed");
  });

  it("is idempotent: a second run deletes nothing", async () => {
    const report = await runRetention(env, now);
    expect(Object.values(report).every((n) => n === 0)).toBe(true);
  });

  it("reads its periods from vars, clamped (security logs never below one year)", () => {
    const p = (vars: Record<string, string>) => retentionPeriods({ ...env, ...vars } as Env);
    expect(p({}).securityEvents).toBe(365 * DAY_MS);
    expect(p({ RETENTION_SECURITY_EVENTS_DAYS: "400" }).securityEvents).toBe(400 * DAY_MS);
    expect(p({ RETENTION_SECURITY_EVENTS_DAYS: "30" }).securityEvents).toBe(365 * DAY_MS);
    expect(p({ RETENTION_WATCHLIST_AFTER_END_DAYS: "abc" }).watchlistAfterEnd).toBe(90 * DAY_MS);
    expect(p({ RETENTION_WATCHLIST_AFTER_END_DAYS: "7" }).watchlistAfterEnd).toBe(7 * DAY_MS);
    expect(p({ RETENTION_ORPHAN_UPLOAD_HOURS: "2" }).orphanUploads).toBe(2 * 60 * 60 * 1000);
  });

  it("removes failed uploads (R2 objects without a D1 row) after the grace period only", async () => {
    const bike = await inspectedBike(admin, { make: "Yamaha", model: "FZ-S" });
    const orphan = `bikes/${bike}/${crypto.randomUUID()}.png`;
    const kept = `bikes/${bike}/${crypto.randomUUID()}.png`;
    await env.IMAGES.put(orphan, new Uint8Array([1, 2, 3]));
    await env.IMAGES.put(kept, new Uint8Array([1, 2, 3]));
    await env.DB.prepare(
      `INSERT INTO bike_images (id, bike_id, r2_key, content_type, bytes, width, height, alt, position, created_at)
       VALUES (?, ?, ?, 'image/png', 3, 800, 600, 'Fixture', 0, ?)`,
    )
      .bind(`img_${crypto.randomUUID().replaceAll("-", "")}`, bike, kept, Date.now())
      .run();
    // Within the grace period (in-flight upload): untouched.
    await runRetention(env, Date.now());
    expect(await env.IMAGES.head(orphan)).not.toBeNull();
    // A day later: the orphan goes, the registered image stays. Auction data is never touched.
    const before = await count(`SELECT COUNT(*) AS n FROM auctions_rm`);
    const report = await runRetention(env, Date.now() + 25 * 60 * 60 * 1000);
    expect(report.orphan_uploads).toBeGreaterThanOrEqual(1);
    expect(await env.IMAGES.head(orphan)).toBeNull();
    expect(await env.IMAGES.head(kept)).not.toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM auctions_rm`)).toBe(before);
  });

  it("runs from the Worker's scheduled handler", async () => {
    await env.DB.prepare(
      `INSERT INTO security_events (id, type, request_id, created_at) VALUES (?, 'test.cron', 'req_t', ?)`,
    )
      .bind(`sev_cron_${crypto.randomUUID()}`, old)
      .run();
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: now, cron: "47 21 * * *" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await count(`SELECT COUNT(*) AS n FROM security_events WHERE type = 'test.cron'`)).toBe(
      0,
    );
  });
});
