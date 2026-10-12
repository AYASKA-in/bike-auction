import { Hono } from "hono";
import { onError, onNotFound } from "./middleware/errors";
import { requestContext } from "./middleware/request-context";
import { originGuard, securityHeaders } from "./middleware/security";
import { loadSession } from "./middleware/session";
import { adminRoutes } from "./routes/admin";
import { auctionRoutes } from "./routes/auctions";
import { authRoutes } from "./routes/auth";
import { internalRoutes } from "./routes/internal";
import { configRoutes, meRoutes } from "./routes/me";
import { systemRoutes } from "./routes/system";
import { spikeRoutes } from "./spikes/routes";
import type { AppEnv } from "./types";

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext);
  app.use("*", securityHeaders);
  // Bearer-token operator routes carry no cookies, so they are exempt from the CSRF origin guard.
  app.use("*", async (c, next) =>
    c.req.path.startsWith("/api/v1/internal/") ? next() : originGuard(c, next),
  );

  const v1 = new Hono<AppEnv>();
  v1.route("/", systemRoutes);
  v1.route("/", configRoutes);
  v1.route("/auth", authRoutes);
  v1.route("/internal", internalRoutes);

  // Session-aware routes.
  v1.use("/me", loadSession);
  v1.use("/admin/*", loadSession);
  v1.route("/", meRoutes);
  v1.route("/admin", adminRoutes);
  v1.route("/auctions", auctionRoutes);

  v1.use("/_spike/*", async (c, next) => {
    if (c.env.ENVIRONMENT !== "development") return onNotFound(c);
    await next();
  });
  v1.route("/_spike", spikeRoutes);

  app.route("/api/v1", v1);
  app.onError(onError);
  app.notFound(onNotFound);
  return app;
}
