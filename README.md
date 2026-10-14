# Bike Auction Platform

Real-time online auctions for inspected used and bank-repossessed two-wheelers in India. Buyers browse inspected
bikes, bid live against each other (by hand or with an automatic maximum), and see prices, outbid notices and
deadlines update instantly. Admins list bikes, run auctions, and watch the system's health.

**Built on Cloudflare's free tier.** Each auction is run by its own Durable Object, a single-threaded "auction
server" with its own SQLite database. Concurrent bids therefore get one provable order, without locks or races.

> **Status (14 Oct 2026): live on Cloudflare (free plan) at https://bike-auction.skiranbot.workers.dev.**
> `pnpm check` passes (563 tests); browser suites, an accessibility scan and a concurrency/load test pass locally.
> On Cloudflare, a full auction was run end to end with real accounts: live updates over WebSockets, proxy
> bidding, the hidden reserve, outbid alerts and the server-side close (details in
> [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)). R2 (photos) is off; demo mode is off.

|                                        |                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Demo guide and 3-minute script         | [`docs/DEMO.md`](docs/DEMO.md)                                                  |
| Architecture                           | [`docs/architecture.md`](docs/architecture.md) · ADRs in [`docs/adr`](docs/adr) |
| API and WebSocket protocol             | [`docs/api.md`](docs/api.md)                                                    |
| Database                               | [`docs/database.md`](docs/database.md)                                          |
| Reliability and performance (measured) | [`docs/reliability.md`](docs/reliability.md)                                    |
| Security and threat model              | [`docs/threat-model.md`](docs/threat-model.md)                                  |
| Privacy and retention (India DPDP)     | [`docs/privacy.md`](docs/privacy.md)                                            |
| Operations runbook                     | [`docs/runbook.md`](docs/runbook.md)                                            |
| Deployment checklist                   | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)                                      |
| Progress log and decisions             | [`docs/progress.md`](docs/progress.md) · [`BLUEPRINT.md`](BLUEPRINT.md)         |
| Screenshots                            | [`docs/screenshots/day8`](docs/screenshots/day8)                                |

## Features

**Buyers**

- **Catalogue:**
  - search, make/city/year/engine-size/price filters with removable chips;
  - sorting by ending soon, starting soon, price, newest and recently ended;
  - inspection grade, RTO/RC/loan (NOC) transparency, and a repossessed flag.
- **Live auction page:**
  - price, minimum next bid, bid count and leader pseudonym, with a countdown in IST;
  - quick-bid buttons that follow the real increment ladder;
  - live bid history;
  - a connection indicator, with stale numbers marked and bidding paused while offline.
- **Proxy (automatic) bidding:** set a hidden maximum and the server bids for you, eBay-style.
  - Equal maximums: the earlier one wins.
  - Nobody else ever sees your maximum.
- **Outbid alerts:** outbid banner with one-tap rebid, tab-title flash and vibration.
  - **Anti-sniping:** a late bid extends the deadline by 2 minutes, capped at 30 minutes in total.
  - **Results:** confirmed by the server, never by the browser's clock.
- **My Bids** (Leading / Outbid / Won / Lost) and **Watchlist**.
- **Account:** consent recorded at sign-up, data export, and account deletion. Deletion keeps auction history intact.
- **Interface:** light, dark and system themes, mobile-first layouts, WCAG 2.x AA (axe-checked).

**Admins**

- Bikes with full Indian paperwork fields, versioned inspection reports, photos (EXIF stripped, private storage).
- Auctions created as drafts, then scheduled; hidden reserve and anti-sniping toggle; no duplicate open auction per bike.
- **Auction desk** with status counts, plus cancel with a reason.
- **Live operations:** health, viewers, sync lag, backlog and warnings.
- **Per-auction view:** bid ledger, timers and recovery actions.
- **Audit trail** with filters.

**Engineering**

- **Atomic bids:** one SQLite transaction per command, with durable idempotency keys so a retry never bids twice.
- **Read-model sync:** events are written to an outbox in the same transaction, then copied to D1 read models with
  retry and backoff.
- **Live updates:** hibernatable WebSockets that recover from gaps and restarts.
- **Security:** CSP and security headers, CSRF origin checks, layered rate limits, Turnstile, per-account login
  backoff.
- **Observability:** structured logs with secrets and PII redacted; metrics in Analytics Engine.
- **Tests:** property-based tests of the auction rules; browser tests with two real buyers, a server restart and
  going offline.

## Architecture in one picture

```
 Browser (React SPA) ── HTTPS commands ──▶ Cloudflare Worker (Hono API, auth, rate limits, CSP)
        ▲                                         │ RPC (one object per auction)
        │ WebSocket events                        ▼
        └──────────────────────────────── AuctionDO  ◀── the authority for ONE auction
                                           SQLite: state · bid ledger · proxy maxima · idempotency · outbox
                                           single-threaded → bids are processed one at a time, in order
                                                  │ outbox (same transaction) → retried projection
                                                  ▼
                                   D1 (SQLite): catalogue, read models, accounts, audit · R2: photos
```

- **Why one Durable Object per auction?** Cloudflare runs each object single-threaded, in one place, with its own
  storage. Every bid for an auction goes to the same object, which checks the rules and commits state, ledger row,
  idempotency record and outbox event in **one synchronous SQLite transaction**. Two bids can never interleave, so
  there are no lost updates and no double winners, and no locks are needed. Different auctions scale independently.
- **Commands over HTTP, events over WebSocket.** A bid is an idempotent `POST`; its effect is broadcast with a
  contiguous sequence number. Clients detect gaps and resync, and an old HTTP response can never overwrite newer
  live state.
- **D1 is a read model, never the authority.** The catalogue, My Bids and the admin desk read D1. If D1 is down,
  bidding continues and the outbox catches up later.
- More detail: [`docs/architecture.md`](docs/architecture.md). The demo guide has interview-style explanations.

## Run it locally

Prerequisites: **Node 22+**, **pnpm 10** (`corepack enable`), Python 3 for the browser tests. No Cloudflare
account is needed.

```bash
pnpm install
pnpm dev                                  # builds the SPA, applies local D1 migrations, serves http://localhost:8787
pnpm --filter @bike/worker seed:local     # (2nd terminal) demo accounts + 8 fictional bikes/auctions
pnpm --filter @bike/worker demo:reset     # any time later: fresh demo auctions with times relative to NOW
```

Open http://localhost:8787. Demo sign-in buttons appear on the sign-in page in local demo mode; the accounts are
listed in [`docs/DEMO.md`](docs/DEMO.md). Frontend hot reload: `pnpm dev:web` (http://localhost:5173, proxies
`/api` and WebSockets to :8787).

Secrets for local work are generated into `apps/worker/.dev.vars` (git-ignored) from `.dev.vars.example`.

## Testing

```bash
pnpm check     # format → lint → typecheck → all tests → production build + deploy dry run (≈ 5–6 min)
pnpm test      # contracts, domain (incl. fast-check properties), web, Worker integration tests in workerd
```

Browser and load tests (Playwright for Python: `pip install playwright axe-playwright-python pillow`):

| Script                                                  | What it proves                                                                                                                                                                    | Server         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `python3 tests/e2e/journey.py http://127.0.0.1:8787`    | Admin lists a bike (photo EXIF stripped), creates and schedules an auction, buyer finds it and bids                                                                               | running app    |
| `python3 tests/e2e/live.py`                             | Two buyers and an admin: live updates, outbid notice, anti-sniping, offline → recovery, **server killed and restarted**, simultaneous bids, close, proxy bids, My Bids, Watchlist | starts its own |
| `python3 tests/e2e/journeys.py`                         | Buyer (register with consent → bid → proxy → win → export), privacy (consent refused, export, delete, history intact), admin ops/ledger/audit; light, dark and mobile             | starts its own |
| `python3 tests/e2e/a11y.py http://127.0.0.1:8787`       | axe WCAG 2.x A/AA on every main page, desktop and mobile, visitor/buyer/admin. Fails on serious or critical                                                                       | running app    |
| `node tests/load/concurrency.mjs http://127.0.0.1:8787` | 20 buyers; 50 and 100 simultaneous bids; proxy and manual together; 5 auctions; duplicates; deadline race; hard cap; latency                                                      | running app    |

The scripts that use a "running app" need it started with the captcha check disabled:
`cd apps/worker && npx wrangler dev --var TURNSTILE_SECRET_KEY:`. That's because the browsers these scripts drive
can't solve a captcha, and the test sandbox can't reach Cloudflare's captcha service at all. The Worker skips the
captcha only when `ENVIRONMENT=development`, and anywhere else it refuses to start without the secret. The
self-starting scripts do this automatically.

## Deployment

One command, run in **your own terminal** (it opens a browser for `wrangler login`; logging in on the Cloudflare
website alone does not authenticate Wrangler):

```bash
node scripts/deploy.mjs --turnstile-site-key <site key> --turnstile-secret-key <secret key>
```

It creates the D1 database, builds, migrates, deploys, sets generated secrets (kept git-ignored), and checks
health. Full checklist, flags (`--demo`, `--with-r2`, `--test-turnstile`), smoke test and rollback:
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Nothing here enables paid services. R2 (photos) stays off unless you pass
`--with-r2`.

## Security highlights

- **Bid integrity:**
  - Authoritative per-auction state with atomic commits.
  - Mandatory idempotency keys.
  - The server's clock is the only clock: the browser never decides a bid's timing or an auction's end.
- **Privacy:**
  - Pseudonymous bidders: other buyers never see identities.
  - Hidden reserves and maximums: never in events, history, D1, logs or other users' responses.
- **Authentication:**
  - Better Auth sessions in HttpOnly cookies.
  - Password hashing (scrypt) in a dedicated Durable Object, to stay within the free-plan CPU limit.
  - Turnstile on sign-up and sign-in, plus per-account login backoff.
- **Browser and HTTP protections:**
  - Strict CSP with no inline scripts; HSTS, COOP and CORP headers.
  - CSRF origin checks; WebSocket origin checks.
- **Rate limits:** layered, at the edge, per auction and per admin.
- **Data protection:**
  - Consent recorded with the notice version.
  - Export and deletion of your own data.
  - Daily retention cleanup.
  - Threat model and privacy documents, which separate implemented safeguards from legal review still needed.

## Known limitations

- **Not verified on real Cloudflare yet:**
  - the deployment itself;
  - password-hashing CPU time on the free plan;
  - Turnstile under the CSP;
  - real R2;
  - the cron cleanup;
  - Analytics Engine.

  See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

- **No real bike photos:** none are bundled (no licensed images), so listings show an original placeholder until an
  admin uploads photos.
- **Missing account features:** no email provider (so no email verification or password reset), no payments, no KYC.
- **Sessions:** they slide forward for 7 days; there is no absolute cap.
- **Approximate limits:** some limits apply per Cloudflare location, so they're approximate. Other residual risks
  are in [`docs/threat-model.md`](docs/threat-model.md) § 6.
- **Performance numbers are local measurements** ([`docs/reliability.md`](docs/reliability.md)), not production.

## Repository layout

```
apps/web            React SPA (Workers static assets, same origin as the API)
apps/worker         Hono API, AuctionDO, PasswordHasherDO, D1 migrations, Worker tests, seed/demo scripts
packages/domain     Pure auction engine: lifecycle, ladder, reserve, soft close, proxy bidding, idempotency
packages/contracts  Zod schemas shared by API, WebSocket protocol and UI
tests/e2e           Playwright journeys and accessibility scan · tests/load: concurrency + latency
docs/               Architecture, ADRs, API, database, security, privacy, runbook, reliability, demo, deployment
```

Stack: React 19 · Vite 8 · Tailwind CSS 4 · TanStack Router/Query · Hono · Cloudflare Workers, Durable Objects
(SQLite, alarms, hibernatable WebSockets), D1, R2, Rate Limiting, Analytics Engine · Better Auth · Zod · Vitest +
`@cloudflare/vitest-plugin` · fast-check · Playwright · pnpm.
