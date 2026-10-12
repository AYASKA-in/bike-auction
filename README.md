# Bike Auction Platform

Real-time auctions for used and repossessed two-wheelers. Each auction is run by one authoritative
Cloudflare Durable Object, so concurrent bids get a single, provable order. Built on free Cloudflare
infrastructure. Design: [`BLUEPRINT.md`](BLUEPRINT.md) · Status: [`docs/progress.md`](docs/progress.md).

> **Status: Day 4 of 10.** Accounts, roles, the auction rules engine and the real-time bidding backend
> (atomic bids, idempotency, alarms, D1 sync, WebSockets) are in place. API: [`docs/api.md`](docs/api.md).
> Catalogue and bidding UI follow.

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
pnpm --filter @bike/worker seed:local   # in a second terminal: create the demo accounts locally
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
