import { Hono } from "hono";
import { onError, onNotFound } from "./middleware/errors";
import { requestContext } from "./middleware/request-context";
import {
  adminWriteLimit,
  originGuard,
  securityHeaders,
  wsConnectLimit,
} from "./middleware/security";
import { loadSession } from "./middleware/session";
import { accountRoutes } from "./routes/account";
import { adminRoutes } from "./routes/admin";
import { auctionRoutes } from "./routes/auctions";
import { catalogueRoutes } from "./routes/catalogue";
import { authRoutes } from "./routes/auth";
import { internalRoutes } from "./routes/internal";
import { configRoutes, meRoutes } from "./routes/me";
import { settlementRoutes } from "./routes/settlement";
import { systemRoutes } from "./routes/system";
import { spikeRoutes } from "./spikes/routes";
import type { AppEnv } from "./types";

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext);
  // Applied after the handler and the error handler, so every response carries them.
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
  v1.use("/me/*", loadSession); // matches /me itself too; Day 7 adds /me/bids, /me/watchlist
  v1.use("/admin/*", loadSession);
  // Edge limits for routes that had none (table: docs/threat-model.md → Rate limits).
  v1.use("/admin/*", adminWriteLimit);
  v1.use("/auctions/:id/stream", wsConnectLimit);
  v1.route("/", accountRoutes); // GET /me/account, GET /me/export, DELETE /me (DPDP rights)
  v1.route("/", settlementRoutes); // /me/purchases, /me/deposit, /me/eligibility
  v1.route("/", meRoutes);
  v1.route("/admin", adminRoutes);
  v1.route("/", catalogueRoutes); // GET /auctions (list), /auctions/:id/details, /images/*, /catalogue/facets
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
