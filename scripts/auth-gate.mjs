#!/usr/bin/env node
// Auth gate for ADR 002: on the deployed Free plan, do register → sign in → /me → sign out 20 times
// and fail if any request errors. A Worker that exceeds its CPU limit returns 503/1102, which this
// counts. Requires Turnstile TEST keys (the dummy token below only passes those).
//
//   node scripts/auth-gate.mjs https://bike-auction.<you>.workers.dev [--runs 20]
const base = process.argv[2];
if (!base) {
  console.error("Usage: node scripts/auth-gate.mjs <baseUrl> [--runs 20]");
  process.exit(2);
}
const runsIdx = process.argv.indexOf("--runs");
const RUNS = runsIdx > 0 ? Number(process.argv[runsIdx + 1]) : 20;
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
// The edge limit allows 20 credential requests/min per IP; 2 per iteration → pace at ~6.5 s.
const PACE_MS = 6500;
const origin = new URL(base).origin;

const lat = { signUp: [], signIn: [], me: [] };
const failures = [];

async function call(path, { method = "GET", body, cookie } = {}) {
  const headers = { origin };
  if (body) headers["content-type"] = "application/json";
  if (path.includes("/sign-")) headers["x-captcha-response"] = DUMMY_TOKEN;
  if (cookie) headers.cookie = cookie;
  const t0 = performance.now();
  const res = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  return { res, ms, text };
}

const cookieOf = (res) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const pct = (xs, p) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? NaN;

console.log(
  `Auth gate against ${origin}: ${RUNS} runs (≈${Math.round((RUNS * PACE_MS) / 1000)} s)`,
);
for (let i = 1; i <= RUNS; i++) {
  const started = Date.now();
  const email = `gate.${Date.now().toString(36)}.${i}@example.org`;
  const password = `Pw-${crypto.randomUUID()}`;
  try {
    const up = await call("/auth/sign-up/email", {
      method: "POST",
      body: { email, password, name: "Release Check" },
    });
    lat.signUp.push(up.ms);
    if (!up.res.ok) throw new Error(`sign-up ${up.res.status}: ${up.text.slice(0, 160)}`);
    const inn = await call("/auth/sign-in/email", { method: "POST", body: { email, password } });
    lat.signIn.push(inn.ms);
    if (!inn.res.ok) throw new Error(`sign-in ${inn.res.status}: ${inn.text.slice(0, 160)}`);
    const cookie = cookieOf(inn.res);
    const me = await call("/me", { cookie });
    lat.me.push(me.ms);
    if (!me.res.ok || !me.text.includes(email)) throw new Error(`/me ${me.res.status}`);
    await call("/auth/sign-out", { method: "POST", body: {}, cookie });
    process.stdout.write(
      `  run ${String(i).padStart(2)} ok  sign-up ${up.ms.toFixed(0)} ms, sign-in ${inn.ms.toFixed(0)} ms\n`,
    );
  } catch (err) {
    failures.push(`run ${i}: ${err.message}`);
    process.stdout.write(`  run ${String(i).padStart(2)} FAIL ${err.message}\n`);
  }
  const wait = PACE_MS - (Date.now() - started);
  if (i < RUNS && wait > 0) await new Promise((r) => setTimeout(r, wait));
}

console.log("\n| step | p50 ms | p95 ms |\n|---|---:|---:|");
for (const [k, xs] of Object.entries(lat))
  console.log(`| ${k} | ${pct(xs, 50).toFixed(0)} | ${pct(xs, 95).toFixed(0)} |`);
console.log(`\nFailures: ${failures.length}/${RUNS}`);
failures.forEach((f) => console.log(`  ${f}`));
console.log(
  failures.length === 0
    ? "\nGATE PASSED: password hashing in PasswordHasherDO works on this plan. Record this in docs/spike-results.md."
    : "\nGATE FAILED: check Workers Logs (dashboard → Workers → bike-auction → Logs) for 'exceededCpu'.\n" +
        "If CPU limits are the cause, switch to Plan B (ADR 002).",
);
process.exit(failures.length === 0 ? 0 : 1);
