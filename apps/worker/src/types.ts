import type { Me } from "@bike/contracts";
import type { Logger } from "./lib/logger";

export type AppVariables = {
  requestId: string;
  log: Logger;
  /** Set by loadSession on routes that use it; null when anonymous. */
  user: Me | null;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
