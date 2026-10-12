import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(dir, ".dev.vars"))) {
  copyFileSync(resolve(dir, ".dev.vars.example"), resolve(dir, ".dev.vars"));
  console.log("[ensure-dev-vars] created apps/worker/.dev.vars from .dev.vars.example");
}
