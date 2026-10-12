import { Hono } from "hono";
import { onError, onNotFound } from "./middleware/errors";
import { requestContext } from "./middleware/request-context";
import { originGuard, securityHeaders } from "./middleware/security";
import { auctionRoutes } from "./routes/auctions";
import { systemRoutes } from "./routes/system";
import { spikeRoutes } from "./spikes/routes";
import type { AppEnv } from "./types";

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext);
  app.use("*", securityHeaders);
  app.use("*", originGuard);

  const v1 = new Hono<AppEnv>();
  v1.route("/", systemRoutes);
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
