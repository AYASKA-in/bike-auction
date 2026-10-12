import { Hono } from "hono";
import type { HealthResponse, StatusResponse } from "@bike/contracts";
import { errorFields } from "../lib/logger";
import type { AppEnv } from "../types";

export const systemRoutes = new Hono<AppEnv>();

/** Liveness: no dependencies, never fails if the Worker is up. Used by uptime monitors. */
systemRoutes.get("/health", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json<HealthResponse>({ status: "ok", serverTime: new Date().toISOString() });
});

/** Readiness/diagnostics: version + dependency checks. Non-sensitive by design. */
systemRoutes.get("/status", async (c) => {
  c.header("Cache-Control", "no-store");
  const started = Date.now();
  let d1: StatusResponse["checks"]["d1"];
  try {
    await c.env.DB.prepare("SELECT 1").first();
    d1 = { status: "ok", latencyMs: Date.now() - started };
  } catch (err) {
    c.get("log").warn("status.d1_check_failed", errorFields(err));
    d1 = { status: "down", latencyMs: Date.now() - started };
  }
  const body: StatusResponse = {
    status: d1.status === "ok" ? "ok" : "degraded",
    version: c.env.APP_VERSION,
    environment: c.env.ENVIRONMENT,
    serverTime: new Date().toISOString(),
    checks: { d1 },
  };
  return c.json(body, d1.status === "ok" ? 200 : 503);
});
