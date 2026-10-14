import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { AppError, problemBody, problemResponse } from "../lib/problem";
import type { AppEnv } from "../types";

// ─────────────────────────────── response headers ───────────────────────────────
//
// Two policies, one source of truth (test/security-headers.test.ts asserts both, and that
// apps/web/public/_headers carries SPA_CSP verbatim):
//
// - SPA_CSP: the HTML app. Static assets are served by the platform BEFORE the Worker runs
//   (wrangler.jsonc `assets`, run_worker_first only for /api/*), so the SPA gets its headers from
//   apps/web/public/_headers, which Workers Static Assets applies to asset and SPA-fallback responses.
// - API_CSP: every Worker response (/api/*: JSON, problem+json, images, WebSocket upgrades). Nothing
//   the API returns should ever execute or embed anything, so it denies everything.
//
// connect-src 'self' covers the same-origin WebSocket: CSP Level 3 matches 'self' against ws:/wss:
// for an http:/https: page of the same host and port (https pages → wss only). See docs/threat-model.md.

const TURNSTILE = "https://challenges.cloudflare.com";

export const SPA_CSP = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE}`,
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  `frame-src ${TURNSTILE}`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

/** Two years. No `preload`: the deployment hostname (workers.dev) is not ours to preload. */
export const HSTS = "max-age=63072000; includeSubDomains";

/** Headers on every Worker response, in addition to HSTS (HTTPS only). */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": API_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": PERMISSIONS_POLICY,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

/**
 * Sets the security headers after the handler (and the error handler) ran, so every response,
 * including problem+json errors and 404s, carries them. HSTS only over HTTPS: browsers ignore it on
 * plain HTTP anyway (RFC 6797 §8.1), and sending it from local http://localhost is just noise.
 */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const https = new URL(c.req.url).protocol === "https:";
  const apply = (h: Headers) => {
    for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) h.set(k, v);
    if (https) h.set("Strict-Transport-Security", HSTS);
    h.delete("X-Powered-By");
  };
  try {
    apply(c.res.headers);
  } catch {
    // Immutable headers (e.g. a Response passed through from a binding). Re-wrap, except a 101,
    // whose webSocket would be lost (routes/auctions.ts already re-wraps upgrades).
    if (c.res.status !== 101) {
      const res = new Response(c.res.body, c.res);
      apply(res.headers);
      c.res = res;
    }
  }
});

// ─────────────────────────────── CSRF / origin ───────────────────────────────

export function allowedOrigins(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Same-origin requests are always allowed; cross-origin ones must be allow-listed. */
export function isOriginAllowed(origin: string | undefined, requestUrl: string, env: Env): boolean {
  if (!origin) return false;
  if (origin === new URL(requestUrl).origin) return true;
  return allowedOrigins(env).has(origin);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated, state-changing requests: require an allowed Origin.
 * Browsers always send Origin on cross-site POST/PUT/PATCH/DELETE.
 */
export const originGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (
    !SAFE_METHODS.has(c.req.method) &&
    !isOriginAllowed(c.req.header("origin"), c.req.url, c.env)
  ) {
    throw new AppError("FORBIDDEN", "Cross-origin request rejected");
  }
  await next();
});

// ─────────────────────────────── edge rate limits ───────────────────────────────
//
// Workers Rate Limiting bindings (free; per Cloudflare location, eventually consistent). Only two
// namespaces exist (wrangler.jsonc); each use gets its own key prefix so budgets never mix:
//   AUTH_RATE_LIMIT 20 / 60 s: auth:<ip> · export:<userId> · account:<userId>
//   BID_RATE_LIMIT  30 / 10 s: bid:<userId> · watch:<userId> · ws:<ip>
// Admin writes are counted exactly in D1 (audit_log), see adminWriteLimit.
// The full per-endpoint table is in docs/threat-model.md.

/** Returns true when the request must be refused. A missing binding (unit tests of other modules) allows. */
export async function overLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

export function rateLimited(c: Context<AppEnv>, detail: string, retryAfterSeconds: number) {
  return problemResponse(problemBody("RATE_LIMITED", c.get("requestId"), detail), {
    "retry-after": String(retryAfterSeconds),
  });
}

/** Cloudflare sets CF-Connecting-IP at the edge and overwrites any client-supplied value. */
export function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header("cf-connecting-ip") ?? null;
}

const IMAGE_UPLOAD = /^\/api\/v1\/admin\/bikes\/[^/]+\/images$/;

/** Audited admin changes per admin account per rolling minute (humans manage ~1 change / 2 s). */
export const ADMIN_WRITES_PER_MINUTE = 120;
/** Image uploads per admin account per rolling minute (≈ 5 bikes × 12 photos; each ≤ 5 MB to R2). */
export const ADMIN_UPLOADS_PER_MINUTE = 60;

/**
 * Admin mutations (runs after loadSession, before the admin router's requireAdmin). Every admin
 * change is written to the append-only audit_log, so the budget is counted there: exact, global
 * (not per edge location), persistent (no restart or reconnect resets it) and free. The fixed edge
 * bindings (30 / 10 s, 20 / min) are too tight for a real listing session (create, inspect, 12
 * photos, schedule), so they are not used here. Caps what a stolen admin session or a runaway
 * script can write; rejected requests write nothing.
 */
export const adminWriteLimit = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user?.role === "ADMIN" && !SAFE_METHODS.has(c.req.method)) {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(action = 'IMAGE_UPLOADED'), 0) AS uploads
       FROM audit_log WHERE actor_user_id = ? AND created_at > ?`,
    )
      .bind(user.id, Date.now() - 60_000)
      .first<{ n: number; uploads: number }>();
    const upload = c.req.method === "POST" && IMAGE_UPLOAD.test(c.req.path);
    if ((row?.n ?? 0) >= ADMIN_WRITES_PER_MINUTE) {
      c.get("log").warn("ratelimit.admin", { userId: user.id });
      return rateLimited(c, "Too many changes in a short time. Wait a minute.", 60);
    }
    if (upload && (row?.uploads ?? 0) >= ADMIN_UPLOADS_PER_MINUTE) {
      c.get("log").warn("ratelimit.upload", { userId: user.id });
      return rateLimited(c, "Too many uploads. Wait a minute and try again.", 60);
    }
  }
  await next();
});

/**
 * WebSocket connects, per client IP (viewers may be anonymous, so there is no better key). Limits a
 * reconnect storm or a socket-opening script; a normal tab opens one socket per auction page and
 * reconnects with back-off. Requests without CF-Connecting-IP (never the case behind Cloudflare)
 * are not keyed, rather than sharing one global bucket.
 */
export const wsConnectLimit = createMiddleware<AppEnv>(async (c, next) => {
  const ip = clientIp(c);
  if (ip && c.req.header("upgrade")?.toLowerCase() === "websocket") {
    if (await overLimit(c.env.BID_RATE_LIMIT, `ws:${ip}`)) {
      c.get("log").warn("ratelimit.ws_connect", {});
      return rateLimited(c, "Too many live connections from your network. Retry shortly.", 10);
    }
  }
  await next();
});
