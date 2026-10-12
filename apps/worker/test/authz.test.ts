import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminRoutes } from "../src/routes/admin";
import { DEMO_ACCOUNTS } from "../src/seed/demo-accounts";
import { BASE, get, mockTurnstile, signIn, signUp } from "./auth-helpers";
import { exports } from "cloudflare:workers";

let spy: ReturnType<typeof mockTurnstile>;
beforeEach(() => {
  spy = mockTurnstile();
});
afterEach(() => spy.mockRestore());

// Every concrete admin endpoint (middleware entries use method "ALL").
const ADMIN_ENDPOINTS = adminRoutes.routes
  .filter((r) => r.method !== "ALL")
  .map((r) => ({ method: r.method, path: `/api/v1/admin${r.path}` }));

let userCookie = "";
let adminCookie = "";

beforeAll(async () => {
  spy = mockTurnstile();
  userCookie = (await signUp()).cookie;
  const admin = await signUp();
  await env.DB.prepare(`UPDATE "user" SET role = 'ADMIN' WHERE email = ?`).bind(admin.email).run();
  adminCookie = (await signIn(admin.email, admin.password)).cookie;
  spy.mockRestore();
});

function call(method: string, path: string, cookie?: string) {
  const headers: Record<string, string> = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  return exports.default.fetch(`${BASE}${path}`, { method, headers });
}

describe("authorization matrix: every /admin route", () => {
  it("has admin endpoints to test", () => {
    expect(ADMIN_ENDPOINTS.length).toBeGreaterThanOrEqual(8);
  });

  it.each(ADMIN_ENDPOINTS)("$method $path → anonymous 401", async ({ method, path }) => {
    expect((await call(method, path)).status).toBe(401);
  });

  it.each(ADMIN_ENDPOINTS)("$method $path → USER 403", async ({ method, path }) => {
    expect((await call(method, path, userCookie)).status).toBe(403);
  });

  // Day 4: parameterised and body-taking admin routes exist, so "allowed" means "not 401/403"
  // (a literal ":id" path or a missing body is a 404/422 from the handler, after authorization).
  it.each(ADMIN_ENDPOINTS)(
    "$method $path → ADMIN passes authorization",
    async ({ method, path }) => {
      expect([401, 403]).not.toContain((await call(method, path, adminCookie)).status);
    },
  );

  it("forged role cookies/headers do not grant access", async () => {
    const res = await call("GET", "/api/v1/admin/overview", `${userCookie}; role=ADMIN`);
    expect(res.status).toBe(403);
  });

  it("/me requires a session", async () => {
    expect((await get("/api/v1/me")).status).toBe(401);
  });
});

describe("operator seed endpoint", () => {
  const seed = (token?: string) =>
    exports.default.fetch(`${BASE}/api/v1/internal/seed`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("rejects missing and wrong tokens", async () => {
    expect((await seed()).status).toBe(401);
    expect((await seed("wrong-token")).status).toBe(401);
  });

  it("creates demo accounts idempotently with correct roles; admin can sign in", async () => {
    const first = (await (await seed(env.SEED_TOKEN)).json()) as {
      accounts: { created: boolean; role: string }[];
    };
    expect(first.accounts.map((a) => a.role)).toEqual(DEMO_ACCOUNTS.map((a) => a.role));
    const second = (await (await seed(env.SEED_TOKEN)).json()) as {
      accounts: { created: boolean }[];
    };
    expect(second.accounts.every((a) => !a.created)).toBe(true);

    const admin = DEMO_ACCOUNTS.find((a) => a.role === "ADMIN")!;
    const { cookie } = await signIn(admin.email, admin.password);
    expect((await get("/api/v1/admin/overview", cookie)).status).toBe(200);
    const buyer = DEMO_ACCOUNTS.find((a) => a.role === "USER")!;
    const buyerCookie = (await signIn(buyer.email, buyer.password)).cookie;
    expect((await get("/api/v1/admin/overview", buyerCookie)).status).toBe(403);
  });
});
