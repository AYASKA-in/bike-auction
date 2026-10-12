import { createApp } from "./app";

export { AuctionDO } from "./auction/auction-do";
export { PasswordHasherDO } from "./auth/password-hasher-do";
export { SpikeProbeDO } from "./spikes/spike-probe-do";

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
