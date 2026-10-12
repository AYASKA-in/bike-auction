import { env } from "cloudflare:workers";
import { ProblemDetails } from "@bike/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockDurationMs } from "../src/auth/login-throttle";
import { passwordProblem } from "../src/auth/password-policy";
import { freshIp, get, mockTurnstile, post, signIn, signUp, uniqueEmail } from "./auth-helpers";

let spy: ReturnType<typeof mockTurnstile>;
beforeEach(() => {
  spy = mockTurnstile();
});
afterEach(() => spy.mockRestore());

async function problem(res: Response) {
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  return ProblemDetails.parse(await res.json());
}

describe("registration", () => {
  it("creates a USER, sets an HttpOnly SameSite=Lax session cookie, and /me reflects it", async () => {
    const { res, cookie, email } = await signUp();
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/ba\.session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const me = await get("/api/v1/me", cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email, role: "USER" });
  });

  it("stores Better Auth's scrypt hash (via PasswordHasherDO), never the password", async () => {
    const { email, password } = await signUp();
    const row = await env.DB.prepare(
      `SELECT a.password FROM account a JOIN "user" u ON u.id = a.userId WHERE u.email = ?`,
    )
      .bind(email)
      .first<{ password: string }>();
    expect(row?.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(row?.password).not.toContain(password);
  });

  it("cannot self-assign the ADMIN role", async () => {
    const email = uniqueEmail("sneaky");
    const res = await post("/api/v1/auth/sign-up/email", {
      email,
      password: "Kickstart-Pulsar-220",
      name: "Sneaky",
      role: "ADMIN",
    });
    if (res.ok) {
      const me = await get(
        "/api/v1/me",
        res.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; "),
      );
      expect((await me.json()) as object).toMatchObject({ role: "USER" });
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const row = await env.DB.prepare(`SELECT role FROM "user" WHERE email = ?`).bind(email).first();
    expect(row === null || (row as { role: string }).role === "USER").toBe(true);
  });

  it("requires a Turnstile token and rejects a failing one", async () => {
    const body = { email: uniqueEmail(), password: "Kickstart-Pulsar-220", name: "Bot" };
    expect(
      (await problem(await post("/api/v1/auth/sign-up/email", body, { captcha: null }))).code,
    ).toBe("CAPTCHA_FAILED");
    expect(
      (await problem(await post("/api/v1/auth/sign-up/email", body, { captcha: "nope" }))).code,
    ).toBe("CAPTCHA_FAILED");
  });

  it("rejects short, common and personal passwords", async () => {
    const base = { email: "riya.sharma@example.org", name: "Riya Sharma" };
    const short = await problem(
      await post("/api/v1/auth/sign-up/email", { ...base, password: "short" }),
    );
    expect(short.code).toBe("VALIDATION_FAILED");
    const common = await problem(
      await post("/api/v1/auth/sign-up/email", { ...base, password: "password@123" }),
    );
    expect(common.code).toBe("WEAK_PASSWORD");
    expect(passwordProblem("riya.sharma-2026!", base.email, base.name)).not.toBeNull();
    expect(passwordProblem("Kickstart-Pulsar-220", base.email, base.name)).toBeNull();
  });

  it("reports duplicate accounts as ACCOUNT_EXISTS", async () => {
    const { email } = await signUp();
    const again = await post("/api/v1/auth/sign-up/email", {
      email,
      password: "Another-Long-Pass-9",
      name: "Dup",
    });
    expect((await problem(again)).code).toBe("ACCOUNT_EXISTS");
  });
});

describe("sign-in and sessions", () => {
  it("signs in, and sign-out revokes the session server-side", async () => {
    const { email, password } = await signUp();
    const { res, cookie } = await signIn(email, password);
    expect(res.status).toBe(200);
    expect((await get("/api/v1/me", cookie)).status).toBe(200);
    const out = await post("/api/v1/auth/sign-out", {}, { cookie });
    expect(out.status).toBe(200);
    expect((await get("/api/v1/me", cookie)).status).toBe(401); // old cookie no longer valid
  });

  it("gives identical errors for a wrong password and an unknown account (no enumeration)", async () => {
    const { email } = await signUp();
    const wrong = await problem((await signIn(email, "Definitely-Wrong-1")).res);
    const unknown = await problem((await signIn(uniqueEmail("ghost"), "Definitely-Wrong-1")).res);
    expect(wrong.status).toBe(401);
    expect({ ...wrong, requestId: "", type: "" }).toEqual({ ...unknown, requestId: "", type: "" });
  });

  it("locks an account after 5 failures, before any hashing, even for the right password", async () => {
    const { email, password } = await signUp();
    for (let i = 0; i < 5; i++)
      expect((await signIn(email, "Wrong-Password-000")).res.status).toBe(401);
    const locked = (await signIn(email, password)).res;
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThanOrEqual(30);
    expect((await problem(locked)).code).toBe("RATE_LIMITED");
  });

  it("locks unknown accounts the same way (no enumeration via lockout)", async () => {
    const ghost = uniqueEmail("ghost");
    for (let i = 0; i < 5; i++) await signIn(ghost, "Wrong-Password-000");
    expect((await signIn(ghost, "Wrong-Password-000")).res.status).toBe(429);
  });

  it("backoff grows exponentially and is capped", () => {
    expect([4, 5, 6, 7, 20].map(lockDurationMs)).toEqual([0, 30_000, 60_000, 120_000, 15 * 60_000]);
  });

  it("records security events without raw emails", async () => {
    const { email } = await signUp();
    await signIn(email, "Wrong-Password-000");
    const rows = await env.DB.prepare(
      `SELECT * FROM security_events WHERE type = 'auth.sign_in.failed'`,
    ).all();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.results)).not.toContain("@");
  });
});

describe("edge rate limit", () => {
  it("returns 429 after 20 auth mutations per minute from one IP", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      // Invalid body: rejected after the rate-limit check, without spending hashing CPU.
      statuses.push((await post("/api/v1/auth/sign-up/email", { email: "x" }, { ip })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("public config", () => {
  it("exposes the Turnstile site key only when Turnstile is enforced", async () => {
    const res = await get("/api/v1/config");
    expect(await res.json()).toEqual({
      environment: "test",
      turnstileSiteKey: "1x00000000000000000000AA",
      demoMode: true,
    });
  });
});
