// The Worker's assets binding points at ../web/dist. Tests and `wrangler types` need the
// directory to exist even if the web app has not been built yet.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (!existsSync(resolve(dist, "index.html"))) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(resolve(dist, "index.html"), "<!doctype html><title>placeholder</title>");
  console.log(`[ensure-assets] created placeholder ${dist}/index.html`);
}
