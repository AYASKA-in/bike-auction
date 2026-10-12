// Seeds the reviewer demo accounts (idempotent).
// Usage: node scripts/seed.mjs <baseUrl> <SEED_TOKEN>
const [base, token] = process.argv.slice(2);
if (!base || !token) {
  console.error("Usage: node scripts/seed.mjs <baseUrl> <SEED_TOKEN>");
  process.exit(2);
}
const res = await fetch(new URL("/api/v1/internal/seed", base), {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(60_000),
});
const body = await res.text();
console.log(res.status, body);
process.exit(res.ok ? 0 : 1);
