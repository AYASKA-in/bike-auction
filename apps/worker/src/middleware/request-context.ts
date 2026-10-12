import { createMiddleware } from "hono/factory";
import { newId } from "../lib/ids";
import { createLogger } from "../lib/logger";
import type { AppEnv } from "../types";

const INBOUND_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Assigns a request id (honouring a well-formed inbound X-Request-Id), attaches a child
 * logger, and emits exactly one access-log line per request.
 */
export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const inbound = c.req.header("x-request-id");
  const requestId = inbound && INBOUND_ID.test(inbound) ? inbound : newId("req");
  const log = createLogger({
    requestId,
    version: c.env.APP_VERSION,
    environment: c.env.ENVIRONMENT,
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
    log.info("http.request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - started,
    });
  }
});
