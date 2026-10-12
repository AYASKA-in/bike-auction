# Bike Auction Platform

Real-time auctions for used and repossessed two-wheelers. Each auction is run by one authoritative
Cloudflare Durable Object, so concurrent bids get a single, provable order. Built on free Cloudflare
infrastructure. Design: [`BLUEPRINT.md`](BLUEPRINT.md) · Status: [`docs/progress.md`](docs/progress.md).

> **Status: Day 1 of 10.** Foundation, technical spikes and tests are in place; auth, catalogue and the
> bidding UI follow. Not yet deployed.

## Stack

React 19 · Vite 8 · Tailwind CSS 4 · TanStack Router/Query · Hono on Cloudflare Workers · Durable Objects
(SQLite, RPC, alarms, WebSocket hibernation) · D1 · R2 · Zod · Vitest + `@cloudflare/vitest-plugin` · fast-check · pnpm.

## Layout

```
apps/web          React SPA (served as Workers static assets, same origin as the API)
apps/worker       Hono API, AuctionDO, PasswordHasherDO, D1 migrations, Worker tests
packages/domain   Pure auction rules (money, increment ladder, clock); no Cloudflare imports
packages/contracts Zod schemas shared by API, WebSocket protocol and UI
docs/             architecture, ADRs, spike results, assumptions, progress
```

## Prerequisites

Node 22+, pnpm 10 (`corepack enable`). No Cloudflare account is needed for local work.

## Local development

```bash
pnpm install
pnpm dev            # builds the SPA, applies local D1 migrations, runs the Worker on http://localhost:8787
# for frontend hot-reload, in a second terminal:
pnpm dev:web        # http://localhost:5173, proxies /api (incl. WebSockets) to :8787
```

Try: `curl http://localhost:8787/api/v1/health` and `curl http://localhost:8787/api/v1/status`.

## Checks

```bash
pnpm check          # format, lint, typecheck, build, all tests
pnpm test           # unit tests + Worker integration tests inside workerd
pnpm --filter @bike/worker spike:auth   # optional: password-hashing latency spike against wrangler dev
```

## Environment

Non-secret config lives in `apps/worker/wrangler.jsonc` (`vars`). Secrets go in `apps/worker/.dev.vars`
locally (see `.dev.vars.example`) and `wrangler secret put` in production. Never commit `.dev.vars`.
After changing bindings, run `pnpm --filter @bike/worker cf-typegen`.

## Deployment (not yet performed; requires approval)

```bash
cd apps/worker
npx wrangler login
npx wrangler d1 create bike-auction        # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create bike-auction-images
npx wrangler d1 migrations apply DB --remote
cd ../.. && pnpm build && pnpm --filter @bike/worker exec wrangler deploy
```
