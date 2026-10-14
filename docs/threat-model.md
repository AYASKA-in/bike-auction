# Threat model and security review (Day 8)

Scope: the deployed system as built: React SPA, one Cloudflare Worker (Hono) serving `/api/*`, Better Auth on D1,
one SQLite Durable Object per auction (`AuctionDO`), `PasswordHasherDO`, D1 read models, private R2 bucket for
images, Workers Static Assets for the SPA. Free plan. Related: [privacy.md](privacy.md) (data flows, retention,
incident response), [architecture.md](architecture.md), [api.md](api.md).

This document lists **implemented safeguards with the tests that prove them**, then what is **not** done. It is an
engineering review, not a certification or legal opinion.

## 1. STRIDE per component

S = spoofing, T = tampering, R = repudiation, I = information disclosure, D = denial of service, E = elevation of
privilege. "Test" names a file in `apps/worker/test/` unless stated otherwise.

### Browser SPA

| Threat                                                | Mitigation                                                                                                                                  | Test                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| I/T: XSS injecting script                             | React escaping, no `dangerouslySetInnerHTML`; strict CSP without `unsafe-inline`/`unsafe-eval` (§2); no inline script/style in `index.html` | `security-headers.test.ts` (CSP shape, no inline in index.html, CSP served by Static Assets on `/` and SPA fallback) |
| T: clickjacking                                       | `frame-ancestors 'none'` + `X-Frame-Options: DENY`                                                                                          | `security-headers.test.ts`                                                                                           |
| I: referrer leaks of auction URLs                     | `Referrer-Policy: strict-origin-when-cross-origin`                                                                                          | `security-headers.test.ts`                                                                                           |
| S: open redirect after login                          | `redirect` search param must be a same-site relative path                                                                                   | `apps/web/src/router.tsx` (zod regex)                                                                                |
| I: cached personal data after account switch/deletion | query keys scoped by user id; deletion clears the whole cache                                                                               | `apps/web/src/lib/me.ts`, `lib/account.ts`                                                                           |
| E: client-side guards bypassed                        | all guards are UX only; the API enforces auth/roles                                                                                         | `authz.test.ts`, `me.test.ts`, `privacy.test.ts`                                                                     |

### Worker API (Hono)

| Threat                                        | Mitigation                                                                                                                                                                                  | Test                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| T/S: CSRF on cookie-authenticated mutations   | `SameSite=Lax` cookies + Origin allow-list on every non-GET (`originGuard`); bearer-only `/internal/*` exempt                                                                               | `security-headers.test.ts` (cross-origin PUT → 403)                                                |
| T: malformed input                            | strict Zod contracts on every body/query; ids by regex; 422 with field paths                                                                                                                | `catalogue.test.ts`, `api-bids.test.ts`, `privacy.test.ts`                                         |
| I: internals in errors                        | `onError` returns generic RFC 9457 `INTERNAL` with a request id; details only in logs; logger redacts password/cookie/token/authorization/secret keys                                       | `security-headers.test.ts` (no stack text); code review of `middleware/errors.ts`, `lib/logger.ts` |
| I: MIME sniffing / embedding of API responses | `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'…`, `CORP: same-origin`, `COOP: same-origin` on every Worker response (incl. errors) | `security-headers.test.ts`                                                                         |
| S: downgrade to HTTP                          | HSTS (2 years, `includeSubDomains`) on HTTPS responses and on static assets                                                                                                                 | `security-headers.test.ts`                                                                         |
| D: request floods                             | layered rate limits (§3); Cloudflare's platform DDoS protection in front                                                                                                                    | `auth.test.ts`, `security-headers.test.ts`, `privacy.test.ts`, `throttle.test.ts`                  |
| R: denying an admin action                    | append-only `audit_log` for every admin mutation and account deletion                                                                                                                       | `catalogue.test.ts`, `privacy.test.ts`                                                             |

### Authentication (Better Auth + PasswordHasherDO)

| Threat                               | Mitigation                                                                                                                                                                             | Test                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| S: credential stuffing / brute force | Turnstile on sign-up and sign-in; per-IP edge limit; per-account exponential backoff keyed by HMAC(email), checked before hashing                                                      | `auth.test.ts`, `throttle.test.ts`                           |
| I: account enumeration               | identical responses and backoff for real and unknown emails on sign-in. Sign-up does report `ACCOUNT_EXISTS` (a usability choice; Turnstile + IP limit bound the probing rate; see §6) | `auth.test.ts`                                               |
| S: weak passwords                    | ≥ 10 chars, deny-list of common passwords and personal info, no composition rules                                                                                                      | `auth.test.ts`                                               |
| I: password storage                  | Better Auth scrypt, computed in a DO outside the 10 ms Worker budget; never logged or exported                                                                                         | `auth.test.ts`, `password-hasher.test.ts`, `privacy.test.ts` |
| S: session theft                     | HttpOnly, `SameSite=Lax`, `Secure` + `__Secure-` prefix on HTTPS; sessions server-side (revocable); logout and account deletion delete rows                                            | `auth.test.ts`, `privacy.test.ts` (all devices revoked)      |
| E: self-assigned admin role          | `role` is `input: false`; only operators set it                                                                                                                                        | `auth.test.ts`                                               |
| R: no consent record                 | sign-up refused without consent to the current notice version; consent stored in `consents`                                                                                            | `privacy.test.ts`                                            |

### AuctionDO (one per auction)

| Threat                                   | Mitigation                                                                                                                     | Test                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| T: race conditions, double bids          | single-threaded object; no await between read and commit; one `transactionSync` per command; contiguous `seq`                  | `auction-do.test.ts`, `api-bids.test.ts`                                           |
| T: replayed commands                     | `Idempotency-Key` per (user, key) with fingerprint, 24 h                                                                       | `api-bids.test.ts`                                                                 |
| S: forged bidder identity                | user id comes only from the session in the Worker; the DO never trusts client ids; `x-user-id` stripped then set by the Worker | `authz.test.ts`, `websocket.test.ts`                                               |
| I: reserve / maxima / identities leaking | strict public views; HMAC per-auction pseudonyms; hidden maxima only in the owner's view                                       | `pseudonym-adapter.test.ts`, `proxy.test.ts`, `privacy.test.ts` (export isolation) |
| D: bid spam on one auction               | persistent per-user throttle 10 / 10 s in SQLite (`bid_attempts`), survives eviction/restart                                   | `throttle.test.ts`                                                                 |

### WebSocket

| Threat                               | Mitigation                                                                                           | Test                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| S: cross-site WebSocket hijacking    | explicit Origin allow-list on upgrade (browsers don't apply CORS to WS)                              | `websocket.test.ts`        |
| I: token in URL                      | none: the session cookie is the only credential                                                      | `websocket.test.ts`        |
| D: message floods                    | 30 client messages / socket / minute, then close 1008; pings auto-answered without waking the object | `live-day6.test.ts`        |
| D: connect floods / reconnect storms | 30 upgrades / 10 s per client IP at the edge (new)                                                   | `security-headers.test.ts` |

### D1

| Threat                   | Mitigation                                                                            | Test                             |
| ------------------------ | ------------------------------------------------------------------------------------- | -------------------------------- |
| T: SQL injection         | prepared statements with bound parameters only; dynamic SQL only from fixed fragments | code review; `catalogue.test.ts` |
| T: read-model corruption | monotonic upserts guarded by `projection_seq`/`last_bid_seq`; D1 never decides a bid  | `auction-do.test.ts`             |
| I: over-retention        | daily retention job, configurable periods, bounded batches                            | `privacy.test.ts`                |
| R: tampering with logs   | `audit_log` has no UPDATE/DELETE path in code; security events kept 1 year            | code review                      |

### R2 (images)

| Threat                                    | Mitigation                                                                                                                              | Test                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| T: malicious upload (script/SVG/polyglot) | admin only; allow-list JPEG/PNG/WebP; magic bytes must match the declared type; ≤ 5 MB; 320–4096 px; random keys, never user file names | `catalogue.test.ts`                           |
| I: EXIF/GPS leaks                         | browser re-encodes through a canvas before upload                                                                                       | `apps/web/src/lib/image-prep.ts`              |
| I: direct bucket access                   | private bucket, streamed by the Worker with `nosniff` + `CORP: same-origin`                                                             | `catalogue.test.ts`                           |
| D: storage exhaustion                     | 12 images per bike; per-admin upload budget (§3); orphaned objects swept daily                                                          | `security-headers.test.ts`, `privacy.test.ts` |

### Admin

| Threat                                 | Mitigation                                                                                                                             | Test                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| E: missing guard on a route            | one sub-app with `requireAdmin`; a test enumerates every admin route (anonymous 401, user 403)                                         | `authz.test.ts`                                                   |
| R: unattributed changes                | every mutation audited with admin id, request id, time                                                                                 | `catalogue.test.ts`                                               |
| D/T: stolen admin session mass-editing | per-admin write budget counted exactly in `audit_log` (120 / min, uploads 60 / min); admins can't bid or delete themselves via the API | `security-headers.test.ts`, `api-bids.test.ts`, `privacy.test.ts` |

Supply chain: pinned exact versions + lockfile, `pnpm install --offline` in CI-like runs. Dependabot/CodeQL/gitleaks
from the blueprint are **not** configured in this repository yet (see §6).

## 2. Response headers and CSP

Source of truth: `apps/worker/src/middleware/security.ts` (`SPA_CSP`, `API_CSP`, `API_SECURITY_HEADERS`).

**SPA (static assets, `apps/web/public/_headers`, applied by Workers Static Assets to assets and the SPA
fallback):**

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Frame-Options: DENY
```

**API (every Worker response, set after the error handler so errors carry them too):** the same headers, with
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` and HSTS
only when the request is HTTPS.

Why each source is there, checked against the real pages:

- **Scripts/styles:** the production `index.html` (checked after `vite build`) loads one module script, module
  preloads and one stylesheet, all from `/assets/`; nothing inline, so no hashes or nonces are needed. The built JS
  contains no `eval`/`new Function` call sites outside libraries that feature-detect and fall back.
- **Turnstile (sign-in/sign-up):** the widget script is loaded from `https://challenges.cloudflare.com` and renders
  an iframe from the same origin. Cloudflare documents exactly `script-src` + `frame-src` for this origin (the
  `connect-src 'self'` note there only concerns pre-clearance mode, which we don't use).
- **Images:** listing photos come from `/api/v1/images/...` (same origin → `'self'`); upload previews use `blob:`;
  small placeholders may use `data:`.
- **WebSockets:** the live feed connects to `wss://<same host>/api/v1/auctions/:id/stream`. CSP Level 3 matches
  `'self'` against `ws:`/`wss:` for the page's own host and port (an `https:` page matches `wss:` only), so
  `connect-src 'self'` covers it in current browsers. Older Safari versions did not apply this rule; if they ever
  had to be supported, add `wss://<host>` at deploy time.
- **Fonts:** self-hosted (`@fontsource`), `font-src 'self'`.
- **Verified:** `security-headers.test.ts` loads the built SPA through the real Static Assets binding
  (`env.ASSETS`) and asserts the CSP on `/` and on an SPA-fallback navigation (`/account`); the test skips itself
  only when the web app hasn't been built (placeholder `index.html`).
- **Vite dev server (`pnpm dev:web`, :5173):** serves the SPA without `_headers`, so there is no CSP in that mode;
  API responses proxied from `wrangler dev` still carry the API headers. Use `pnpm dev` (wrangler + Static Assets)
  to test the real policy locally. HSTS sent over `http://localhost` is ignored by browsers (RFC 6797 §8.1).
- **To verify on the first real deploy:** that the Turnstile widget renders correctly under `style-src 'self'`
  (Cloudflare's CSP page lists no style requirement), and the securityheaders.com grade.

## 3. Rate limits and abuse controls (every endpoint)

Mechanisms:

- **Edge bindings** (Workers Rate Limiting, free; per Cloudflare location, eventually consistent, counted by key,
  independent of any object restart): `AUTH_RATE_LIMIT` 20 / 60 s and `BID_RATE_LIMIT` 30 / 10 s. Each use has its
  own key prefix so budgets never mix.
- **Exact, persistent counters:** DO SQLite (`bid_attempts`), D1 (`login_throttle`, `audit_log`).
- **Per-socket counter** in the WebSocket attachment (resets when the socket reconnects; see note).

| Endpoint                                                                                                                                | Limiter(s)                                                                                                      | Key                             | Bypassable by restart/reconnect?                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/sign-up/email`                                                                                                              | Turnstile; `AUTH_RATE_LIMIT`                                                                                    | `auth:<ip>`                     | No                                                                                                                                                                    |
| `POST /auth/sign-in/email`                                                                                                              | Turnstile; `AUTH_RATE_LIMIT`; backoff after 5 failures (30 s doubling to 15 min) in D1                          | `auth:<ip>`; HMAC(email)        | No                                                                                                                                                                    |
| `POST /auth/request-password-reset`                                                                                                     | `AUTH_RATE_LIMIT` (no email provider is configured, so reset is not functional)                                 | `auth:<ip>`                     | No                                                                                                                                                                    |
| `POST /auth/sign-out`, `GET /auth/get-session`                                                                                          | none (session-bound, cheap)                                                                                     | —                               | —                                                                                                                                                                     |
| `POST /auctions/:id/bids`                                                                                                               | `BID_RATE_LIMIT`; DO throttle 10 / 10 s per user per auction (SQLite)                                           | `bid:<userId>`; (auction, user) | No (DO counter is persisted)                                                                                                                                          |
| `PUT /auctions/:id/max-bid`                                                                                                             | same as bids (shared budgets)                                                                                   | `bid:<userId>`; (auction, user) | No                                                                                                                                                                    |
| `GET /auctions/:id/stream` (WS connect)                                                                                                 | **new** `BID_RATE_LIMIT`                                                                                        | `ws:<ip>`                       | No                                                                                                                                                                    |
| WS client messages (`resync`)                                                                                                           | 30 / socket / minute, then close 1008                                                                           | per socket                      | Yes, by reconnecting; bounded by the connect limit above (≤ 30 connects / 10 s per IP). Accepted: a resync costs one snapshot read in the object; pings never wake it |
| `PUT/DELETE /me/watchlist/:id`                                                                                                          | `BID_RATE_LIMIT`; cap 100 rows                                                                                  | `watch:<userId>`                | No                                                                                                                                                                    |
| `GET /me/export`                                                                                                                        | **new** `AUTH_RATE_LIMIT`                                                                                       | `export:<userId>`               | No                                                                                                                                                                    |
| `DELETE /me`                                                                                                                            | **new** `AUTH_RATE_LIMIT`                                                                                       | `account:<userId>`              | No                                                                                                                                                                    |
| Admin mutations (`POST/PATCH/PUT/DELETE /admin/*`)                                                                                      | **new** 120 audited changes / rolling minute per admin, counted in D1 `audit_log`                               | admin id                        | No (D1, global, exact)                                                                                                                                                |
| `POST /admin/bikes/:id/images`                                                                                                          | **new** 60 uploads / rolling minute per admin (D1), plus 12 per bike, 5 MB each                                 | admin id                        | No                                                                                                                                                                    |
| `POST /internal/seed`                                                                                                                   | bearer token (timing-safe compare); disabled without `SEED_TOKEN`                                               | —                               | —                                                                                                                                                                     |
| Public reads (`GET /auctions`, `/auctions/:id`, `/bids`, `/details`, `/images/*`, `/catalogue/facets`, `/health`, `/status`, `/config`) | none at the app layer; Cloudflare platform DDoS protection; reads are indexed D1 queries or single-object reads | —                               | —                                                                                                                                                                     |

Why the admin budget is not an edge binding: the fixed bindings (30 / 10 s, 20 / min) are tighter than a real listing
session (create, inspect, 12 photos, reorder, schedule) and per-location. Every admin change is already an
`audit_log` row, so counting those is exact, global and free. Requests rejected by validation write nothing and are
not counted.

Tests: `auth.test.ts` (IP + account), `throttle.test.ts` (DO), `live-day6.test.ts` (WS messages),
`security-headers.test.ts` (WS connects, admin writes, uploads), `privacy.test.ts` (export), `me.test.ts` (watchlist).

## 4. Other review items

- **CSRF:** Origin allow-list on all non-GET requests; same-origin plus `ALLOWED_ORIGINS`. `GET` routes have no
  side effects (the export is a read; its security-event write is bookkeeping).
- **WebSocket origin:** checked in `routes/auctions.ts` before the upgrade reaches the object; identity from the
  session only.
- **Sessions:** 7-day expiry, refreshed at most daily while used (sliding). Revocation = row deletion (no cookie
  cache), so sign-out and account deletion take effect on the next request.
- **Secrets:** `BETTER_AUTH_SECRET` (≥ 32 chars, checked), `TURNSTILE_SECRET_KEY` (required outside development:
  fail closed), `PSEUDONYM_SECRET`, `SEED_TOKEN` are Worker secrets set by `scripts/deploy.mjs` (`wrangler secret
bulk`), never in `wrangler.jsonc`. Locally they live in `.dev.vars` (git-ignored). Public config is limited to
  `GET /config` (Turnstile site key, environment, demo flag).
- **Input validation / uploads:** see the R2 and Worker tables above.
- **Error responses:** RFC 9457 everywhere; unexpected errors are `INTERNAL` with a request id only.

## 5. Security checklist (release)

- [ ] `pnpm check` green (format, lint, typecheck, all tests, build).
- [ ] Secrets set in the target environment; `TURNSTILE_SECRET_KEY` present (sign-in fails closed without it).
- [ ] `ALLOWED_ORIGINS` contains only origins you control.
- [ ] D1 migrations applied (`0006_privacy.sql` adds consents, deletion records, retention indexes).
- [ ] Cron trigger present (`wrangler deployments`/dashboard → Triggers) and the first `retention.completed` log
      line seen.
- [ ] Headers checked on the deployed host: `/`, `/account` (SPA fallback), `/api/v1/health`; securityheaders.com
      screenshot for the README.
- [ ] Turnstile widget renders and passes on `/login` and `/register` under the CSP.
- [ ] Demo accounts: `DEMO_MODE` intended for this environment; `SEED_TOKEN` rotated or removed after seeding.
- [ ] Privacy Notice version bumped if the notice text changed.

## 6. Known limitations

- **Session lifetime:** sliding 7 days; the blueprint's 7-day absolute / 24 h idle pair is not enforced (Better
  Auth has no absolute cap; would need a check in `loadSession`).
- **Edge limits are per Cloudflare location** and eventually consistent; a distributed attacker gets more total
  budget. Exact limits exist where it matters most (bids in the DO, login backoff in D1, admin writes in D1).
- **WS message limit is per socket**; reconnecting resets it (bounded by the per-IP connect limit). Shared IPs
  (mobile carrier NAT) share the connect budget of 30 / 10 s; generous for normal use, but a very large NAT pool
  could see occasional 429s on reconnect storms (the client backs off and retries).
- **Public reads** have no app-level limit; a scraper could consume Free-plan daily quotas (D1 reads, requests).
  Mitigation path: Cloudflare WAF rate-limiting rule (free tier has one) on `/api/v1/*`.
- **Sign-up reveals existing emails** (`ACCOUNT_EXISTS`), bounded by Turnstile and the IP limit.
- **No email provider:** no email verification, no password reset.
- **Supply-chain automation** (Dependabot, CodeQL, gitleaks, pinned Action SHAs) is not configured here.
- **Not verified on real Cloudflare yet:** Turnstile under CSP, headers on the production host, cron execution.
- **Reserve disclosure on a reserve jump (accepted, eBay-like):** when a maximum ≥ the reserve lifts the price to
  exactly the reserve, observers see a PROXY bid at that amount with "reserve met" flipping, so the reserve value is
  inferable at that moment. Reserves are otherwise never sent to buyers.
- **Admin write budget is soft under concurrency** (counted from `audit_log` before the write; parallel requests can
  overshoot, and rejected requests write no audit row). Uploads are still capped per bike (12) and by size; a coarse
  edge limiter in front would make it hard (review LOW-7).
- **WS connect limit is per IP** (anonymous viewers have no better key); see the NAT note above (review LOW-8).
- **Data export fan-out:** up to 200 auction objects are asked for the requester's own maxima, 8 at a time with a 3 s
  timeout each (any timeout → 503, nothing partial); export is limited to 20/min per user.
