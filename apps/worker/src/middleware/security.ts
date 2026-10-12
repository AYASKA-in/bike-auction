import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { AppError } from "../lib/problem";
import type { AppEnv } from "../types";

/**
 * Security headers for every Worker response. Static assets are served by the platform
 * before the Worker runs, so the SPA's CSP is also set in apps/web/public/_headers.
 */
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
  },
  strictTransportSecurity: "max-age=63072000; includeSubDomains",
  referrerPolicy: "strict-origin-when-cross-origin",
  xFrameOptions: "DENY",
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
});

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
