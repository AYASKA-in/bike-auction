import type { Me, PublicConfig } from "@bike/contracts";
import { Hono } from "hono";
import { requireUser } from "../middleware/session";
import type { AppEnv } from "../types";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", requireUser, (c) => {
  c.header("Cache-Control", "no-store");
  return c.json<Me>(c.get("user")!);
});

/** Public, non-secret runtime config so one SPA build serves every environment. */
export const configRoutes = new Hono<AppEnv>();
configRoutes.get("/config", (c) =>
  c.json<PublicConfig>({
    environment: c.env.ENVIRONMENT,
    turnstileSiteKey: c.env.TURNSTILE_SECRET_KEY ? (c.env.TURNSTILE_SITE_KEY ?? null) : null,
    demoMode: c.env.DEMO_MODE === "true",
  }),
);
