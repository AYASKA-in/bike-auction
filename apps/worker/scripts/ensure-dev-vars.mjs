// Creates apps/worker/.dev.vars from .dev.vars.example, or appends keys that newer versions added
// (existing values are never changed).
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(dir, ".dev.vars");
const example = resolve(dir, ".dev.vars.example");
const keys = (text) =>
  new Map(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.split("=")[0], l]),
  );
if (!existsSync(target)) {
  copyFileSync(example, target);
  console.log("[ensure-dev-vars] created apps/worker/.dev.vars from .dev.vars.example");
} else {
  const have = keys(readFileSync(target, "utf8"));
  const missing = [...keys(readFileSync(example, "utf8"))]
    .filter(([k]) => !have.has(k))
    .map(([, line]) => line);
  if (missing.length) {
    appendFileSync(target, `\n# added by ensure-dev-vars\n${missing.join("\n")}\n`);
    console.log(
      `[ensure-dev-vars] added ${missing.map((l) => l.split("=")[0]).join(", ")} to .dev.vars`,
    );
  }
}
