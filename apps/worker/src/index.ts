import { createApp } from "./app";
import { runRetention } from "./lib/retention";

export { AuctionDO } from "./auction/auction-do";
export { PasswordHasherDO } from "./auth/password-hasher-do";
export { SpikeProbeDO } from "./spikes/spike-probe-do";

const app = createApp();

export default {
  fetch: app.fetch,
  /** Daily data-retention purge (wrangler.jsonc `triggers.crons`; docs/privacy.md). */
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runRetention(env));
  },
} satisfies ExportedHandler<Env>;
