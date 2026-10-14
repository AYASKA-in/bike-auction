import { createApp } from "./app";
import { runRetention } from "./lib/retention";
import { sweep } from "./settlement/service";

export { AuctionDO } from "./auction/auction-do";
export { PasswordHasherDO } from "./auth/password-hasher-do";
export { SpikeProbeDO } from "./spikes/spike-probe-do";

const app = createApp();

export default {
  fetch: app.fetch,
  /** Daily data-retention purge (wrangler.jsonc `triggers.crons`; docs/privacy.md). */
  scheduled(controller, env, ctx) {
    // Every 5 minutes: settlement deadlines. Daily 21:47 UTC: retention (+ a sweep).
    if (controller.cron === "*/5 * * * *") ctx.waitUntil(sweep(env).then(() => undefined));
    else ctx.waitUntil(Promise.all([runRetention(env), sweep(env)]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
