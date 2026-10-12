// Spike A: how expensive is password hashing in the Workers runtime?
//
// Starts `wrangler dev` (local workerd), then measures wall-clock latency of the dev-only
// /api/v1/_spike/hash endpoint for several modes, minus a no-op baseline. Inside workerd,
// performance.now() does not advance during pure computation (Spectre mitigation), so timing
// must be taken from outside the runtime.
//
// IMPORTANT: this measures local hardware, not Cloudflare's edge, and local workerd does not
// enforce the Free plan's 10 ms CPU limit. Results bound the *order of magnitude* only.
//
// Usage: node scripts/spike-auth-cpu.mjs [--port 8799] [--runs 15]
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Never send loopback traffic through a corporate/agent HTTP proxy.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc),
      [],
    ),
);
const PORT = Number(args.port ?? 8799);
const RUNS = Number(args.runs ?? 15);
const BASE = `http://127.0.0.1:${PORT}`;

const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`wrangler dev did not start:\n${devLog.slice(-2000)}`);
}

async function call(body) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/v1/_spike/hash`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json();
  return { ms: performance.now() - t0, json, status: res.status };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function measure(label, body) {
  await call(body); // warm-up (module init, DO creation)
  const samples = [];
  let failures = 0;
  let lastError;
  for (let i = 0; i < RUNS; i++) {
    const r = await call(body);
    if (r.status !== 200 || r.json.ok === false) {
      failures++;
      lastError = r.json.error ?? r.status;
    }
    samples.push(r.ms);
  }
  return { label, p50: pct(samples, 50), p95: pct(samples, 95), failures, lastError };
}

try {
  await waitReady();
  const rows = [];
  rows.push(await measure("baseline (noop)", { mode: "noop" }));
  rows.push(await measure("Better Auth scrypt in Worker (hash+verify)", { mode: "worker-scrypt" }));
  rows.push(await measure("Better Auth scrypt in DO via RPC (hash+verify)", { mode: "do-scrypt" }));
  for (const it of [100_000, 100_001, 600_000]) {
    rows.push(
      await measure(`WebCrypto PBKDF2-SHA256 ${it.toLocaleString()} it (1 derive)`, {
        mode: "worker-pbkdf2",
        iterations: it,
      }),
    );
  }
  const base = rows[0].p50;
  console.log(
    `\nRuns per mode: ${RUNS}. Host: ${process.platform}/${process.arch}, node ${process.version}`,
  );
  console.log("| Mode | p50 ms | p95 ms | p50 minus baseline | failures |");
  console.log("|---|---:|---:|---:|---|");
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${(r.p50 - base).toFixed(1)} | ${r.failures}${r.lastError ? ` (${r.lastError})` : ""} |`,
    );
  }
} finally {
  dev.kill("SIGTERM");
}
