import { SignUpInput, type ErrorCode } from "@bike/contracts";
import { Hono, type Context } from "hono";
import { getAuth } from "../auth/auth";
import { lockedForMs, recordFailure, recordSuccess } from "../auth/login-throttle";
import { passwordProblem } from "../auth/password-policy";
import { recordSecurityEvent } from "../auth/security-events";
import { errorFields } from "../lib/logger";
import { problemBody, problemResponse } from "../lib/problem";
import type { AppEnv } from "../types";

/**
 * Better Auth is mounted at /api/v1/auth/*. This wrapper adds what the library does not:
 * edge rate limiting, per-account login backoff, a password deny-list, security events, and
 * RFC 9457 errors so the client sees one error format across the whole API.
 */
export const authRoutes = new Hono<AppEnv>();

const BETTER_AUTH_CODE_MAP: Record<string, ErrorCode> = {
  INVALID_EMAIL_OR_PASSWORD: "INVALID_CREDENTIALS",
  USER_ALREADY_EXISTS: "ACCOUNT_EXISTS",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "ACCOUNT_EXISTS",
  PASSWORD_TOO_SHORT: "WEAK_PASSWORD",
  PASSWORD_TOO_LONG: "WEAK_PASSWORD",
  MISSING_RESPONSE: "CAPTCHA_FAILED",
  VERIFICATION_FAILED: "CAPTCHA_FAILED",
  INVALID_EMAIL: "VALIDATION_FAILED",
};

const LIMITED_PATHS = new Set(["/sign-in/email", "/sign-up/email", "/request-password-reset"]);

function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header("cf-connecting-ip") ?? null;
}

/**
 * Reads the body exactly once and returns a fresh Request for Better Auth. (Cloning and leaving one
 * tee branch unread wedges subsequent requests in workerd; found by test/auth.test.ts.)
 */
async function readBody(
  req: Request,
): Promise<{ json: Record<string, unknown>; forward: () => Request }> {
  const text = await req.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    // leave empty; validation reports it
  }
  return {
    json,
    forward: () => new Request(req.url, { method: req.method, headers: req.headers, body: text }),
  };
}

/** Converts Better Auth's `{code, message}` errors into problem+json; passes successes through. */
async function normalize(c: Context<AppEnv>, res: Response): Promise<Response> {
  if (res.ok || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string; message?: string };
  const code: ErrorCode =
    (body.code && BETTER_AUTH_CODE_MAP[body.code]) ||
    (res.status === 401 ? "AUTH_REQUIRED" : res.status === 403 ? "FORBIDDEN" : "VALIDATION_FAILED");
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return problemResponse(problemBody(code, c.get("requestId"), body.message), headers);
}

function tooMany(c: Context<AppEnv>, retryAfterMs: number, detail: string) {
  return problemResponse(problemBody("RATE_LIMITED", c.get("requestId"), detail), {
    "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
}

authRoutes.on(["GET", "POST"], "/*", async (c) => {
  const path = c.req.path.replace(/^\/api\/v1\/auth/, "");
  const isPost = c.req.method === "POST";
  const ip = clientIp(c);

  // 1. Coarse edge limit on credential endpoints (per IP; anonymous traffic has no better key).
  if (isPost && LIMITED_PATHS.has(path) && c.env.AUTH_RATE_LIMIT) {
    const { success } = await c.env.AUTH_RATE_LIMIT.limit({ key: `auth:${ip ?? "unknown"}` });
    if (!success) {
      await recordSecurityEvent(c.env, {
        type: "auth.rate_limited",
        requestId: c.get("requestId"),
        ip,
      });
      return tooMany(c, 60_000, "Too many attempts. Try again in a minute.");
    }
  }

  if (isPost && path === "/sign-up/email") {
    const { json: body, forward } = await readBody(c.req.raw);
    const parsed = SignUpInput.safeParse(body);
    if (!parsed.success) {
      return problemResponse(
        problemBody("VALIDATION_FAILED", c.get("requestId"), parsed.error.issues[0]?.message),
      );
    }
    const weak = passwordProblem(parsed.data.password, parsed.data.email, parsed.data.name);
    if (weak) return problemResponse(problemBody("WEAK_PASSWORD", c.get("requestId"), weak));
    const res = await (await getAuth(c.env, c.req.raw)).handler(forward());
    if (res.ok) {
      const json = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { user?: { id?: string } };
      await recordSecurityEvent(c.env, {
        type: "auth.sign_up",
        requestId: c.get("requestId"),
        userId: json.user?.id ?? null,
        ip,
      });
    }
    return normalize(c, res);
  }

  if (isPost && path === "/sign-in/email") {
    const { json: body, forward } = await readBody(c.req.raw);
    const email = String(body.email ?? "");
    const locked = email ? await lockedForMs(c.env, email) : 0;
    if (locked > 0) {
      await recordSecurityEvent(c.env, {
        type: "auth.sign_in.locked",
        requestId: c.get("requestId"),
        subject: email,
        ip,
      });
      return tooMany(c, locked, "Too many failed sign-in attempts. Try again later.");
    }
    const res = await (await getAuth(c.env, c.req.raw)).handler(forward());
    try {
      if (res.ok) {
        const json = (await res
          .clone()
          .json()
          .catch(() => ({}))) as { user?: { id?: string } };
        await recordSuccess(c.env, email);
        await recordSecurityEvent(c.env, {
          type: "auth.sign_in.succeeded",
          requestId: c.get("requestId"),
          userId: json.user?.id ?? null,
          ip,
        });
      } else if (res.status === 401 && email) {
        const failures = await recordFailure(c.env, email);
        await recordSecurityEvent(c.env, {
          type: "auth.sign_in.failed",
          requestId: c.get("requestId"),
          subject: email,
          ip,
        });
        c.get("log").info("auth.sign_in.failed", { failures });
      } else if (res.status === 400) {
        await recordSecurityEvent(c.env, {
          type: "auth.captcha_failed",
          requestId: c.get("requestId"),
          ip,
        });
      }
    } catch (err) {
      // Bookkeeping must never turn a valid sign-in into an error.
      c.get("log").error("auth.bookkeeping_failed", errorFields(err));
    }
    return normalize(c, res);
  }

  return normalize(c, await (await getAuth(c.env, c.req.raw)).handler(c.req.raw));
});
