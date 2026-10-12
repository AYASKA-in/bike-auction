import { Hono } from "hono";
import { getAuth } from "../auth/auth";
import { recordSecurityEvent } from "../auth/security-events";
import { timingSafeEqual } from "../lib/crypto";
import { AppError } from "../lib/problem";
import { DEMO_ACCOUNTS } from "../seed/demo-accounts";
import { seedCatalogue } from "../seed/demo-catalogue";
import type { AppEnv } from "../types";

/**
 * Operator endpoints authenticated by a bearer secret (no cookies, so CSRF does not apply).
 * Disabled entirely unless SEED_TOKEN is configured.
 */
export const internalRoutes = new Hono<AppEnv>();

internalRoutes.use("*", async (c, next) => {
  const token = c.env.SEED_TOKEN;
  const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) throw new AppError("NOT_FOUND");
  if (!timingSafeEqual(given, token)) throw new AppError("AUTH_REQUIRED", "Invalid operator token");
  await next();
});

/** Idempotent: creates missing demo accounts and (re)asserts their roles. */
internalRoutes.post("/seed", async (c) => {
  const auth = await getAuth(c.env, c.req.raw);
  const results: { email: string; created: boolean; role: string }[] = [];
  for (const acct of DEMO_ACCOUNTS) {
    const existing = await c.env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
      .bind(acct.email)
      .first();
    if (!existing) {
      // Server-side API call: bypasses the HTTP captcha hook by design (operator action).
      await auth.api.signUpEmail({
        body: { email: acct.email, password: acct.password, name: acct.name },
      });
    }
    await c.env.DB.prepare(`UPDATE "user" SET role = ? WHERE email = ?`)
      .bind(acct.role, acct.email)
      .run();
    results.push({ email: acct.email, created: !existing, role: acct.role });
  }
  const ids = await c.env.DB.prepare(`SELECT email, id FROM "user" WHERE email IN (?, ?)`)
    .bind(DEMO_ACCOUNTS[1]!.email, DEMO_ACCOUNTS[2]!.email)
    .all<{ email: string; id: string }>();
  const byEmail = new Map(ids.results.map((r) => [r.email, r.id]));
  const catalogue =
    c.req.query("catalogue") === "false"
      ? { bikes: 0, auctions: [] }
      : await seedCatalogue(c.env, {
          a: byEmail.get(DEMO_ACCOUNTS[1]!.email)!,
          b: byEmail.get(DEMO_ACCOUNTS[2]!.email)!,
        });
  await recordSecurityEvent(c.env, { type: "admin.seed", requestId: c.get("requestId") });
  return c.json({ accounts: results, catalogue });
});
