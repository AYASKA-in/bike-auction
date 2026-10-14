import { PROBLEM_CONTENT_TYPE } from "@bike/contracts";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import { newId } from "../lib/ids";
import { createLogger } from "../lib/logger";
import { writeMetric, type MetricsSink } from "../lib/metrics";
import type { AppEnv } from "../types";

const INBOUND_ID = /^[A-Za-z0-9_-]{8,64}$/;
const AUCTION_ID = /^\/api\/v1\/(?:admin\/)?auctions\/([A-Za-z0-9_-]{3,64})(?:\/|$)/;

/** The metrics dataset if bound (optional at runtime: unbound in tests/local → no-op). */
export const metricsOf = (env: Env): MetricsSink | undefined =>
  (env as { METRICS?: MetricsSink }).METRICS;

/**
 * Route PATTERN of the handler that matched (e.g. "/api/v1/auctions/:id/bids"), never the raw URL,
 * so logs and metric blobs have bounded cardinality and carry no ids. Middleware entries use
 * method "ALL"; a request no handler matched is "unmatched".
 */
export function routePattern(c: Context<AppEnv>): string {
  const handlers = matchedRoutes(c).filter((r) => r.method !== "ALL");
  return handlers.at(-1)?.path ?? "unmatched";
}

/** Problem code of an error response (bounded ErrorCode enum), read from a clone of the body. */
async function problemCode(res: Response): Promise<string | undefined> {
  if (res.status < 400 || !res.headers.get("content-type")?.includes(PROBLEM_CONTENT_TYPE))
    return undefined;
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assigns a request id (honouring a well-formed inbound X-Request-Id), attaches a child
 * logger, and emits exactly one completion log line + one `http_request` metric per request.
 * The line has: ts, level, event "http.request", requestId, version, environment, method, route
 * (pattern), status, durationMs, colo, code (problem code on errors), auctionId (when in the path).
 * Never: raw URL/query, IP, cookies, user agent, e-mail.
 */
export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const inbound = c.req.header("x-request-id");
  const requestId = inbound && INBOUND_ID.test(inbound) ? inbound : newId("req");
  const colo = (c.req.raw as { cf?: { colo?: unknown } }).cf?.colo;
  const log = createLogger({
    requestId,
    version: c.env.APP_VERSION,
    environment: c.env.ENVIRONMENT,
    ...(typeof colo === "string" ? { colo } : {}),
  });
  c.set("requestId", requestId);
  c.set("log", log);

  const started = Date.now();
  try {
    await next();
  } finally {
    c.header("X-Request-Id", requestId);
    // Note: in production Workers, Date.now() only advances across I/O, so durationMs measures
    // I/O-bound time, not CPU. CPU time is reported separately by Workers Logs.
    const durationMs = Date.now() - started;
    const route = routePattern(c);
    const status = c.res.status;
    const code = await problemCode(c.res);
    const auctionId = AUCTION_ID.exec(c.req.path)?.[1];
    const fields = {
      method: c.req.method,
      route,
      status,
      durationMs,
      ...(code ? { code } : {}),
      ...(auctionId && route !== "unmatched" ? { auctionId } : {}),
    };
    if (status >= 500) log.error("http.request", fields);
    else log.info("http.request", fields);
    const metrics = metricsOf(c.env);
    const point = {
      route: `${c.req.method} ${route}`,
      status,
      outcome: code ?? (status < 400 ? "ok" : "error"),
      colo: typeof colo === "string" ? colo : undefined,
      version: c.env.APP_VERSION,
      durationMs,
      count: 1,
    };
    writeMetric(metrics, { event: "http_request", ...point });
    // Auth security signal: failed/locked/throttled/captcha-failed auth calls, by problem code
    // (INVALID_CREDENTIALS, RATE_LIMITED, CAPTCHA_FAILED …). Successful auth calls are not counted
    // here (they are in http_request). Detailed records stay in D1 security_events (hashed).
    if (route.startsWith("/api/v1/auth/") && status >= 400)
      writeMetric(metrics, { event: "auth_security", ...point });
  }
});
