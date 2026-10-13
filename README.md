# Bike Auction Platform

Real-time auctions for used and repossessed two-wheelers. Each auction is run by one authoritative
Cloudflare Durable Object, so concurrent bids get a single, provable order. Built on free Cloudflare
infrastructure. Design: [`BLUEPRINT.md`](BLUEPRINT.md) · Status: [`docs/progress.md`](docs/progress.md).

> **Status: Day 6 of 10.** Accounts, roles, the auction rules engine, the real-time bidding backend, the
> motorcycle catalogue and admin desk, and a reliable live auction page (reconnecting WebSocket feed, live
> price/leader/outbid, bid history, anti-sniping countdown, server-confirmed results) are in place and
> verified locally with two buyers bidding against each other. API: [`docs/api.md`](docs/api.md).
> Screenshots: [`docs/screenshots/day6`](docs/screenshots/day6), [`day5`](docs/screenshots/day5).
> Not yet verified on real Cloudflare (deploy pending your approval).

## Demo accounts

Created by the seed step (demo-only passwords, used nowhere else):

| Role    | Email                    | Password          |
| ------- | ------------------------ | ----------------- |
| Admin   | admin@bikeauction.demo   | Demo-Admin-2026!  |
| Buyer A | buyer.a@bikeauction.demo | Demo-BuyerA-2026! |
| Buyer B | buyer.b@bikeauction.demo | Demo-BuyerB-2026! |

## Stack

React 19 · Vite 8 · Tailwind CSS 4 · TanStack Router/Query · Hono on Cloudflare Workers · Durable Objects
(SQLite, RPC, alarms, WebSocket hibernation) · D1 · R2 · Zod · Vitest + `@cloudflare/vitest-plugin` · fast-check · pnpm.

## Layout

```
apps/web          React SPA (served as Workers static assets, same origin as the API)
apps/worker       Hono API, AuctionDO, PasswordHasherDO, D1 migrations, Worker tests
packages/domain   Pure auction engine: lifecycle, bids, reserve, soft close, idempotency, pseudonyms (ADR 004)
packages/contracts Zod schemas shared by API, WebSocket protocol and UI
docs/             architecture, ADRs, spike results, assumptions, progress
```

## Prerequisites

Node 22+, pnpm 10 (`corepack enable`). No Cloudflare account is needed for local work.

## Local development

```bash
pnpm install
pnpm dev            # builds the SPA, applies local D1 migrations, runs the Worker on http://localhost:8787
pnpm --filter @bike/worker seed:local   # in a second terminal: demo accounts + 8 demo bikes/auctions
# for frontend hot-reload, in a second terminal:
pnpm dev:web        # http://localhost:5173, proxies /api (incl. WebSockets) to :8787
```

Try: `curl http://localhost:8787/api/v1/health` and `curl http://localhost:8787/api/v1/status`.

## Checks

```bash
pnpm check          # format, lint, typecheck, build, all tests
pnpm test           # unit, property-based and Worker integration tests (inside workerd)
pnpm --filter @bike/domain test:coverage   # domain coverage report (90% thresholds)
FC_SEED=42 FC_RUNS=3000 pnpm --filter @bike/domain test   # longer property-test run
pnpm --filter @bike/worker spike:auth   # optional: password-hashing latency spike against wrangler dev
```

### End-to-end journey (real local app, Playwright)

```bash
pip install playwright pillow    # browser: a local Chromium
python3 tests/e2e/journey.py http://127.0.0.1:8787 /tmp/e2e   # needs a seeded local `wrangler dev`
```

Admin signs in → creates a bike → records an inspection → uploads a photo with GPS EXIF (checks the stored
copy has none and is ≤2000 px) → creates a draft auction → schedules it → buyer finds it via search → opens the
detail page (reserve not leaked) → bids → mobile filters. Screenshots go to the output folder.

### Multi-user live test (two buyers + admin, real server restart)

```bash
python3 tests/e2e/live.py 8799 /tmp/e2e-live   # starts/stops its own `wrangler dev` on that port
```

Buyer A (desktop) and Buyer B (mobile) bid against each other while the admin watches: live price,
outbid notice to the right user, anti-sniping deadline seen by all, refresh, offline → recovery, a killed and
restarted server → automatic recovery, no duplicate bids, simultaneous bids, server-confirmed close, expired session.

### Demo catalogue

Seeding adds 8 fictional, clearly labelled Indian listings (Classic 350, Activa 6G, Pulsar NS200 repossessed
with an active loan, Jupiter, Splendor Plus, Apache RTR 160 4V, Access 125, FZ-S): 3 live with real bids,
2 upcoming, 2 ending right after seeding (one sold, one reserve not met), 1 draft. Idempotent per listing.
No photos are bundled (no authorised images); cards show an original placeholder until an admin uploads one.

## Environment

Non-secret config lives in `apps/worker/wrangler.jsonc` (`vars`). Secrets go in `apps/worker/.dev.vars`
locally (see `.dev.vars.example`) and `wrangler secret put` in production. Never commit `.dev.vars`.
After changing bindings, run `pnpm --filter @bike/worker cf-typegen`.

## Deployment

Run this in your own terminal (Windows PowerShell, macOS or Linux), from the repo root:

```bash
corepack enable          # or: npm i -g pnpm
pnpm install
pnpm deploy              # opens the browser for `wrangler login` the first time
```

`scripts/deploy.mjs` is idempotent. It creates the D1 database (and writes its id into `wrangler.jsonc`),
builds, applies migrations, deploys, sets generated secrets (kept in `apps/worker/.deploy-secrets.json`,
git-ignored), seeds the demo accounts, waits for the new version, and runs the 20× auth gate.

The first deploy uses Cloudflare's **Turnstile test keys** so the gate can run. Afterwards, create a free
Turnstile widget for your `*.workers.dev` hostname (dashboard → Turnstile) and run:

```bash
pnpm deploy --turnstile-site-key <site key> --turnstile-secret-key <secret key>
```

Rollback: `npx wrangler rollback` (in `apps/worker`).

**Photos / R2:** by default the deploy runs **without** the R2 binding (no R2 activation, no billing): photo
uploads return 503 and listings show placeholders. After you approve R2 storage, run `pnpm deploy --with-r2`
(creates the private `bike-auction-images` bucket and binds it). Locally, Wrangler's R2 emulation is used.
