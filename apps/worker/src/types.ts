import type { Logger } from "./lib/logger";

export type AppVariables = {
  requestId: string;
  log: Logger;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
