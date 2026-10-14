#!/usr/bin/env node
// One-command deploy to Cloudflare Workers (free plan). Safe to re-run: every step is idempotent.
//
//   node scripts/deploy.mjs --turnstile-site-key 0x... --turnstile-secret-key 0x...   # normal deploy
//   node scripts/deploy.mjs --test-turnstile      # SHORT-LIVED verification deploy with Cloudflare's
//                                                 # always-pass TEST keys (runs the 20x auth gate); re-deploy
//                                                 # with real keys right after. Never leave it running.
//   node scripts/deploy.mjs --demo                # ALSO seed the fictional demo catalogue + demo accounts
//                                                 # and show the demo-account buttons (evaluation only)
//   node scripts/deploy.mjs --skip-gate           # don't run the 20x auth check afterwards
//   node scripts/deploy.mjs --with-r2             # ALSO create/bind the R2 image bucket. Only after you have
//                                                 # approved enabling R2 on the account (it may ask for billing).
// Without --with-r2 the Worker is deployed WITHOUT the image binding: uploads answer 503 and listings
// show placeholders. Nothing here enables R2 or adds a payment method.
//
// What it does: wrangler login (if needed) → D1 database (create if missing, write its id into
// wrangler.jsonc) → build → apply D1 migrations → deploy → set secrets → seed demo accounts →
// health check → 20x register/login gate.
// Generated secrets are kept in apps/worker/.deploy-secrets.json (git-ignored) so re-runs reuse them.
import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(root, "apps", "worker");
const wranglerConfig = join(worker, "wrangler.jsonc");
const secretsFile = join(worker, ".deploy-secrets.json");
const DB_NAME = "bike-auction";
const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const step = (msg) => console.log(`\n▶ ${msg}`);
function wrangler(cmdArgs, { capture = false, input, env = {} } = {}) {
  const r = spawnSync("npx", ["wrangler", ...cmdArgs], {
    cwd: worker,
    shell: process.platform === "win32",
    encoding: "utf8",
    input,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "inherit"] : "inherit",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`wrangler ${cmdArgs.join(" ")} failed (exit ${r.status})`);
  return r.stdout ?? "";
}

// 0. Config. The deploy uses a generated wrangler.deploy.jsonc (git-ignored) built by PARSING
// wrangler.jsonc, so wrangler.jsonc itself is never edited. By default the R2 binding is dropped.
// JSONC → JSON: strips line and block comments and trailing commas (string-aware).
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) throw new Error("Unterminated comment in wrangler.jsonc");
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, "$1"));
}
const withR2 = has("with-r2");
const deployConfig = join(worker, "wrangler.deploy.jsonc");
const writeDeployConfig = (databaseId) => {
  const conf = parseJsonc(readFileSync(wranglerConfig, "utf8"));
  // Only the DB binding the app uses (newer wrangler versions may offer to add their own).
  conf.d1_databases = (conf.d1_databases ?? [])
    .filter((d) => d.binding === "DB")
    .map((d) => ({ ...d, database_id: databaseId }));
  if (!withR2) delete conf.r2_buckets;
  writeFileSync(deployConfig, JSON.stringify(conf, null, 2));
};
const CFG = ["--config", "wrangler.deploy.jsonc"];

// 1. Auth
step("Checking Cloudflare login");
const who = spawnSync("npx", ["wrangler", "whoami"], {
  cwd: worker,
  shell: process.platform === "win32",
  encoding: "utf8",
});
if (
  !/associated with the email/i.test(`${who.stdout}${who.stderr}`) &&
  !/You are logged in/i.test(`${who.stdout}${who.stderr}`)
) {
  console.log("Not logged in. Opening the browser for `wrangler login`...");
  wrangler(["login"]);
}

// 2. D1
step(`Ensuring D1 database "${DB_NAME}"`);
const findDb = () =>
  JSON.parse(wrangler(["d1", "list", "--json"], { capture: true })).find((d) => d.name === DB_NAME);
let db = findDb();
if (!db) {
  // Newer wrangler versions offer to rewrite wrangler.jsonc here; keep the file exactly as it was.
  const before = readFileSync(wranglerConfig, "utf8");
  try {
    wrangler(["d1", "create", DB_NAME], { env: { CI: "true" } });
  } finally {
    writeFileSync(wranglerConfig, before);
  }
  db = findDb();
}
if (!db?.uuid) throw new Error("Could not determine D1 database id");
writeDeployConfig(db.uuid); // wrangler.jsonc keeps its local placeholder id
console.log(`  using D1 database ${db.uuid}`);

// 3. Secrets (generated once, reused on re-runs)
const secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, "utf8")) : {};
secrets.BETTER_AUTH_SECRET ??= randomBytes(32).toString("base64url");
secrets.SEED_TOKEN ??= randomBytes(24).toString("base64url");
secrets.PSEUDONYM_SECRET ??= randomBytes(32).toString("base64url");
const wantTestKeys = has("test-turnstile");
const realSite =
  flag("turnstile-site-key") ??
  (secrets.TURNSTILE_SITE_KEY !== TEST_SITE_KEY ? secrets.TURNSTILE_SITE_KEY : undefined);
const realSecret =
  flag("turnstile-secret-key") ??
  (secrets.TURNSTILE_SECRET_KEY !== TEST_SECRET_KEY ? secrets.TURNSTILE_SECRET_KEY : undefined);
if (!wantTestKeys && (!realSite || !realSecret)) {
  console.error(
    "\nReal Turnstile keys are required (the TEST keys let anyone pass the bot check).\n" +
      "Create a free Turnstile widget for your workers.dev hostname in the Cloudflare dashboard, then run:\n" +
      "  node scripts/deploy.mjs --turnstile-site-key <site key> --turnstile-secret-key <secret key>\n" +
      "Or, for a short-lived verification deploy only: node scripts/deploy.mjs --test-turnstile",
  );
  process.exit(2);
}
const siteKey = wantTestKeys ? TEST_SITE_KEY : realSite;
secrets.TURNSTILE_SECRET_KEY = wantTestKeys ? TEST_SECRET_KEY : realSecret;
secrets.TURNSTILE_SITE_KEY = siteKey;
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
const usingTestKeys = secrets.TURNSTILE_SECRET_KEY === TEST_SECRET_KEY;

// 4. Build + migrate + deploy
step("Building web app and Worker");
execSync("pnpm build", { cwd: root, stdio: "inherit" });

step("Applying D1 migrations (remote)");
wrangler(["d1", "migrations", "apply", "DB", "--remote", ...CFG], { env: { CI: "true" } });

let version = "unversioned";
try {
  version = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim();
} catch {}

step(`Deploying Worker (version ${version})`);
const out = wrangler(
  [
    "deploy",
    "--var",
    `APP_VERSION:${version}`,
    "--var",
    `TURNSTILE_SITE_KEY:${siteKey}`,
    // Demo-account buttons on the sign-in page only for an explicit evaluation deploy.
    "--var",
    `DEMO_MODE:${has("demo") ? "true" : "false"}`,
  ],
  {
    capture: true,
  },
);
process.stdout.write(out);
const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
if (!url) throw new Error("Could not find the workers.dev URL in deploy output");

step("Setting secrets");
const tmp = join(tmpdir(), `bike-auction-secrets-${process.pid}.json`);
writeFileSync(
  tmp,
  JSON.stringify({
    BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
    SEED_TOKEN: secrets.SEED_TOKEN,
    PSEUDONYM_SECRET: secrets.PSEUDONYM_SECRET,
    TURNSTILE_SECRET_KEY: secrets.TURNSTILE_SECRET_KEY,
  }),
);
try {
  wrangler(["secret", "bulk", tmp, ...CFG]);
} finally {
  unlinkSync(tmp);
}

// 5. Verify
step("Waiting for the new version to serve");
let healthy = false;
for (let i = 0; i < 30 && !healthy; i++) {
  try {
    const s = await (
      await fetch(`${url}/api/v1/status`, { signal: AbortSignal.timeout(5000) })
    ).json();
    healthy = s.status === "ok" && s.version === version;
  } catch {}
  if (!healthy) await new Promise((r) => setTimeout(r, 2000));
}
if (!healthy) throw new Error(`${url}/api/v1/status did not report version ${version}`);

// Demo accounts + fictional catalogue only for an explicit evaluation deploy (--demo). Their passwords
// are public (README), so never seed them on a site real users rely on.
if (has("demo")) {
  step("Seeding demo accounts and the fictional demo catalogue");
  const seed = await fetch(`${url}/api/v1/internal/seed`, {
    method: "POST",
    headers: { authorization: `Bearer ${secrets.SEED_TOKEN}` },
  });
  console.log(" ", seed.status, (await seed.text()).slice(0, 300));
  if (!seed.ok) throw new Error("Seeding failed");
}

if (!has("skip-gate")) {
  if (usingTestKeys) {
    step("Running the 20x register/login gate");
    const gate = spawnSync(process.execPath, [join(root, "scripts", "auth-gate.mjs"), url], {
      stdio: "inherit",
    });
    if (gate.status !== 0) process.exitCode = 1;
  } else {
    console.log(
      "\n(Real Turnstile keys are active, so the automated gate is skipped: bots can't pass it, by design.)",
    );
  }
}

console.log(`\n✔ Deployed: ${url}`);
if (usingTestKeys) {
  console.log(
    "⚠ Turnstile TEST keys are active (they let anyone pass the bot check). After the gate passes, create a free\n" +
      "  Turnstile widget for this hostname in the Cloudflare dashboard and re-run with\n" +
      "  --turnstile-site-key <site key> --turnstile-secret-key <secret key>",
  );
}
