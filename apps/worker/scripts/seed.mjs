// Seeds the reviewer demo accounts and the fictional demo catalogue (idempotent).
// Usage: node scripts/seed.mjs <baseUrl> <SEED_TOKEN> [--reset]
//   --reset  removes ONLY demo-seed data (created_by = 'seed': its auctions are cancelled, its
//            listings/bikes/read models deleted) and reseeds with times relative to NOW. Real users,
//            real listings and their bids are never touched.
const [base, token, mode] = process.argv.slice(2);
if (!base || !token || (mode && mode !== "--reset")) {
  console.error("Usage: node scripts/seed.mjs <baseUrl> <SEED_TOKEN> [--reset]");
  process.exit(2);
}
const post = (path) =>
  fetch(new URL(`/api/v1/internal/${path}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });

if (mode === "--reset") {
  const accounts = await post("seed?catalogue=false"); // make sure the demo accounts exist
  if (!accounts.ok) {
    console.log(accounts.status, await accounts.text());
    process.exit(1);
  }
}
const res = await post(mode === "--reset" ? "demo/reset" : "seed");
const body = await res.text();
console.log(res.status, body);
process.exit(res.ok ? 0 : 1);
