# Bike Auction Platform — Final Engineering Blueprint (v2)

> Revised and hardened version of the original research report. Verified against current Cloudflare, Better Auth and DPDP sources on **12 Oct 2026**. Where something could not be verified, it is marked **[SPIKE]**: prove it on Day 1 before relying on it.

---

## 0. Verdict on the original report

The core architecture in the original report is right, and I keep it: **React SPA + Hono on Cloudflare Workers + one Durable Object (DO) per auction + D1 read model + R2 images + WebSockets with hibernation**. It is the best zero-cost way to get one authoritative ordering per auction, a demo link that never sleeps and very little infrastructure to run.

Going through it as a senior engineer would, I found **15 gaps**. Some would break the live demo and others would cost points in review:

| # | Gap in original report | Why it matters | Fix (this doc) |
|---|---|---|---|
| 1 | **Password hashing vs Workers Free 10 ms CPU limit** | Free plan allows 10 ms of CPU per HTTP request. Better Auth uses scrypt by default, which is far heavier. Login/registration can fail intermittently with CPU-exceeded errors **on the live demo**. | §7.1 – Day‑1 spike + decision tree |
| 2 | **A DO has exactly one alarm** | The report uses alarms for closing, and implicitly for start, outbox retry and idempotency cleanup. `setAlarm()` overwrites. Naive code silently drops the close alarm. | §3.4 – alarm multiplexer |
| 3 | `await` inside the bid critical section | DO atomicity only holds for synchronous SQL. An `await fetch()`/D1 call mid‑bid lets another bid interleave. | §3.3 – "no await between read and commit" rule |
| 4 | **Load testing the live free deployment** | A 1,000‑client k6 run can burn the 100k requests/day quota and take the demo down right when the reviewer opens it. | §9.4 – separate staging account/env |
| 5 | **Seeded auctions go stale** | Reviewers may open the link days later, and by then every seeded auction has ended. | §9.5 – demo recycler cron + bot bidder |
| 6 | Rate‑limit binding treated as exact | It is per‑location and eventually consistent, and Cloudflare says it is *not* an accounting system. | §7.5 – coarse limits at the edge, exact per‑auction throttle inside the DO |
| 7 | Anti‑sniping deferred; reserve price omitted | Both are cheap once the domain model exists, and both are expected in real auctions. Unbounded soft close is also a liveness bug. | §4 – P0, with a cap on extensions |
| 8 | D1 has no interactive transactions | Better Auth and the projections must use `batch()` / non‑transactional mode. | §6, §7.1 |
| 9 | Logs retained 3 days on free | India's DPDP Rules require ≥1 year of processing/traffic logs. | §8 – security/audit events persisted in D1 |
| 10 | Bidder masking `••••74` | A stable suffix lets competitors track one dealer across auctions. | §4.6 – per‑auction HMAC pseudonyms |
| 11 | Ad‑hoc error envelope; no API spec | Reviewers judge "good API design" quickly from a spec. | §5 – RFC 9457 Problem Details + OpenAPI from Zod + docs UI |
| 12 | Generic bike catalogue | Vutto sells used two‑wheelers and sources repossessed bikes via bank/NBFC partners. Listing fields should reflect that business (FDE thinking). | §1, §6 |
| 13 | WS details missing | No Origin check (cross‑site WebSocket hijacking), no hibernation‑safe pings, no targeted "you were outbid" events. | §3.5 |
| 14 | No reasoning on alternatives' free tiers | Supabase free projects pause when idle, and Render free services spin down, so the demo link can die. That is the real reason to choose Cloudflare, so say it. | §2.2 |
| 15 | Photos leak data | Phone photos carry EXIF GPS, and number plates are visible. | §7.6 |

---

## 1. Product framing (the FDE lens)

**Who's asking:** Vutto is a Delhi‑based, full‑stack used two‑wheeler platform founded in 2024. It runs showrooms in Delhi, offers certified bikes with a warranty, and partners with banks and financial institutions to sell **repossessed two‑wheelers**. Bank repo vehicles are normally liquidated through **auctions with a reserve price, sold "as‑is, where‑is"**, with buyers inspecting before bidding.

**So the realistic users of this platform are:**
- **Buyers/dealers**, who need fast confidence about condition, paperwork and price, and need to know whether they are winning.
- **Ops/admin** (Vutto's auction desk), who list bikes, attach inspection reports, schedule auctions, monitor them live, and cancel when listing data is wrong.

**Domain fields that make it feel like a real Indian used‑bike auction** (cheap to add, and a strong signal):
- Make, model, variant, manufacturing year, registration year, **engine cc**, **km driven**, fuel type (incl. EV)
- **Owner count** (1st/2nd/3rd owner), **registration state + RTO code** (e.g. DL‑3C), **RC status** (available / duplicate / pending)
- **Hypothecation / NOC status** (key for repo bikes), **insurance valid till**
- **Inspection report**: overall grade (A/B/C/D), checklist sections (engine, electricals, frame, tyres, brakes, body), inspector notes, inspection date
- **Yard location (city)**, "as‑is where‑is" flag, photos (EXIF stripped, plate masked)

Assumption to state in the README: *"Modelled on a B2B/B2C liquidation auction for used & repossessed two‑wheelers. EMD (earnest money deposit), KYC and payment settlement are out of scope; the system determines the winner."*

---

## 2. Final stack

### 2.1 Decisions (pin exact versions in the lockfile at project start)

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | Shared types end‑to‑end |
| Monorepo | pnpm workspaces (no Turbo/Nx) | `apps/web`, `apps/worker`, `packages/domain`, `packages/contracts` |
| Frontend | React 19 + Vite | SPA served as **Workers Static Assets**, so same origin as the API and no CORS |
| Routing | TanStack Router | Type‑safe params/search; file routes |
| Server state | TanStack Query | WS events patch the query cache |
| UI | Tailwind CSS v4 + shadcn/ui (Radix) | Accessible primitives; own the components |
| Forms | React Hook Form + Zod | Same Zod schemas the API uses |
| Motion | `motion` (Framer Motion) | Price‑change flashes; respects `prefers-reduced-motion` |
| Toasts | sonner | |
| API | Hono + `@hono/zod-openapi` | Generates OpenAPI 3.1; Scalar docs UI at `/api/docs` |
| Auction coordinator | **SQLite‑backed Durable Object** per auction, called via **DO RPC** | Free plan supports SQLite DOs only (fine) |
| Real‑time | DO WebSocket **Hibernation API** | `acceptWebSocket`, tags, `setWebSocketAutoResponse` |
| Global DB | D1 + Drizzle ORM + Drizzle migrations | Users, sessions, catalogue, read models, audit |
| Objects | R2 | Bike images |
| Auth | Better Auth (email+password) on D1 **or** fallback (see §7.1) | Decided by Day‑1 spike |
| Bot defence | Turnstile (free) | Register/login |
| Rate limiting | Workers Rate Limiting binding (coarse) + DO‑internal throttle (exact) | |
| Scheduled jobs | Workers Cron Triggers | Demo recycler, outbox sweep, retention purge, canary |
| Logs | Workers Logs (structured JSON) | 200k events/day, 3‑day retention on free |
| Metrics | **Workers Analytics Engine** | 100k data points written/day + 10k queries/day free; currently not billed. Powers the admin ops dashboard via SQL API |
| Errors | Sentry Developer (free, ~5k errors/mo) | `@sentry/cloudflare` + `@sentry/react` |
| Uptime | External free monitor (UptimeRobot / Better Stack) on `/api/v1/health` | Independent of Cloudflare |
| Tests | Vitest + `@cloudflare/vitest-pool-workers`, **fast-check**, Playwright + `@axe-core/playwright`, k6 | |
| CI/CD | GitHub Actions + Wrangler; CodeQL, gitleaks, Dependabot | |
| Hosting | `*.workers.dev` | Free, always on |

### 2.2 Why not the alternatives (put this in the ADR)

| Option | Strength | Why not here |
|---|---|---|
| Node + Postgres + Redis + Socket.IO | Industry standard, portable | No genuinely free always‑on hosting for 3 services; multi‑instance WS fan‑out needs Redis pub/sub; more moving parts than the problem needs |
| Supabase (Postgres + Realtime) | Great DX | Free projects **pause after inactivity**, so the reviewer may hit a dead link. Bid ordering would still need row locks / RPC functions |
| Render/Railway/Fly | Simple containers | Free tiers spin down or no longer exist, giving cold starts or a sleeping demo |
| Convex | Transactional + reactive, very fast to build | Hides the very concurrency engineering the assignment wants to evaluate |
| Firebase/Firestore | Free, realtime | Transactions are optimistic with retries under contention; less control over ordering semantics |

The one‑line pitch: *"Cloudflare lets me map the correctness boundary (one auction) onto a single‑threaded, strongly consistent object with co‑located storage and WebSockets, deployed at zero cost on a link that never sleeps. The domain package is platform‑free, so Postgres is a credible migration path."*

---

## 3. Architecture

### 3.1 Topology

```text
Browser (React SPA)
  │  HTTPS (REST commands, same origin)        WSS (events, read-only feed)
  ▼                                             ▼
┌──────────────────────── Worker (Hono) ─────────────────────────┐
│ requestId · secure headers · session · RBAC · Zod validation   │
│ edge rate limit · Turnstile · problem+json errors · logging    │
└───────┬───────────────────────────┬────────────────────────────┘
        │ SQL                       │ RPC / WS upgrade by auctionId
        ▼                           ▼
┌───────────────┐        ┌───────────────────────────────────────┐
│ D1            │◄───────│ AuctionDO (one per auction)           │
│ users/session │ outbox │ SQLite: state · bids · proxy_bids ·   │
│ bikes/inspect │ project│ idempotency · outbox · meta           │
│ auctions (RM) │ (async)│ engine = packages/domain (pure)       │
│ my_bids (RM)  │        │ alarm multiplexer · WS hub (tags)     │
│ audit/security│        └───────────────────────────────────────┘
└───────────────┘
┌───────────────┐   ┌──────────────────────┐   ┌───────────────┐
│ R2 images     │   │ Analytics Engine     │   │ Cron triggers │
└───────────────┘   │ (metrics)            │   │ recycler,     │
                    └──────────────────────┘   │ sweep, purge  │
                                               └───────────────┘
```

**Principle:** *The auction DO is authoritative; everything else is recoverable.*

### 3.2 Bid command flow

```text
POST /api/v1/auctions/:id/bids   Idempotency-Key: <uuid>   {amountMinor} | {maxAmountMinor}
 1. Worker: requestId, session → userId (never from body), role check, Zod, edge rate-limit
 2. stub = AUCTION_DO.get(idFromName(auctionId)); result = await stub.placeBid({userId, ...})
 3. DO (synchronous critical section, no awaits):
      maybeAdvanceLifecycle(now)          // lazy start/close: correctness never waits on alarms
      idempotency lookup (userId,key) → return stored result (or 422 if payload differs)
      per-user exact throttle check
      decision = engine.evaluate(state, cmd, now)      // pure function
      ctx.storage.transactionSync(() => {
        insert bid(s) · update state · seq++ · insert idempotency · insert outbox · maybe extend closesAt
      })
      reschedule alarm (multiplexer)
 4. After commit: broadcast events (all sockets) + targeted `you.outbid` (socket tag user:<id>)
 5. Fire-and-forget projection attempt to D1; alarm sweeps anything left in outbox
 6. Return 201 {bid, state} (or problem+json 409/422)
```

### 3.3 Concurrency rules (write these in `docs/architecture.md`)

- A DO processes events one at a time, but **an `await` on anything other than its own storage opens a window for interleaving**. Rule: read state, decide and commit **synchronously** with `ctx.storage.sql.exec` / `transactionSync`. Network I/O (D1 projection, Sentry) happens only **after** commit.
- On construction, `ctx.blockConcurrencyWhile()` runs DO‑schema migrations (`PRAGMA user_version`) and loads state, so no request sees a half‑initialised object.
- Ordering comes from the committed `seq`, never from timestamps. Client clocks are ignored.

### 3.4 Alarm multiplexer (fixes gap #2)

There is one alarm per DO, and `setAlarm()` overwrites it. So never set alarms ad hoc. Always call:

```ts
function rescheduleAlarm() {
  const candidates = [
    state.status === "SCHEDULED" ? state.startsAt : null,
    state.status === "LIVE" ? state.closesAt : null,
    outboxPending() ? now() + backoffMs() : null,
    nextIdempotencyGcAt(),
    demoBotNextActionAt(),        // demo only
  ].filter(Boolean);
  candidates.length ? ctx.storage.setAlarm(Math.min(...candidates)) : ctx.storage.deleteAlarm();
}
async alarm() { maybeAdvanceLifecycle(now()); await drainOutbox(); gcIdempotency(); rescheduleAlarm(); }
```

Alarms are at‑least‑once and retry up to 6 times with backoff. Make `alarm()` idempotent and **catch errors so it always reschedules** (after the retries are used up, a failed alarm never fires again).

### 3.5 WebSocket design

- `GET /api/v1/auctions/:id/stream` → Worker checks the **`Origin` header against an allow‑list** (prevents cross‑site WebSocket hijacking), resolves the optional session, and forwards the upgrade to the DO.
- DO: `ctx.acceptWebSocket(ws, ["all", userId ? "user:"+userId : "anon"])`, plus `ws.serializeAttachment({connId, userId})`, so state survives hibernation.
- `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}','{"type":"pong"}'))`. Heartbeats then don't wake the DO, which costs nothing and keeps detection fast.
- Anonymous viewers may watch, and bidding requires login. That is good for UX and shows the read fan‑out scales.
- The feed is **server → client only**. Commands go over HTTP. Ignore or close on unexpected client messages, and cap the message rate per socket.
- Protocol (`packages/contracts/ws.ts`, versioned):

```text
hello            {protocolVersion, serverTime}
auction.snapshot {seq, status, currentPriceMinor, minNextBidMinor, closesAt, reserveMet, bidCount, recentBids[], you:{isLeading, yourMaxMinor?}}
bid.accepted     {seq, bidId, bidder:"Bidder K7Q2", amountMinor, at, closesAt, minNextBidMinor}
auction.extended {seq, closesAt, reason:"SOFT_CLOSE"}
auction.status   {seq, status}
auction.ended    {seq, outcome:"SOLD"|"RESERVE_NOT_MET"|"NO_BIDS", winningAmountMinor?}
you.outbid       {seq, currentPriceMinor, minNextBidMinor}      // targeted via tag
```

- Client: if `seq` has a gap or you reconnect, request a fresh snapshot (snapshot‑on‑reconnect, no replay). Back off on reconnect at 250 ms → 8 s with full jitter. Resync on `visibilitychange` and on `online`.
- Server time offset: `offset = serverTime − (t0 + t1)/2` (NTP‑style), recomputed on every snapshot.

### 3.6 D1 projection (outbox)

- Every committed mutation inserts an outbox row in the **same** DO transaction.
- The projector upserts into D1 with a monotonic guard: `UPDATE auctions_rm SET … WHERE id=? AND projection_seq < ?`. Replays are no‑ops.
- Use D1 `batch()` (atomic) for multi‑statement writes, because D1 has no interactive transactions.
- The admin console shows **projection lag** = DO seq − D1 `projection_seq`.

---

## 4. Auction domain (`packages/domain`, zero Cloudflare imports)

### 4.1 Lifecycle

```text
DRAFT ──schedule──► SCHEDULED ──(t ≥ startsAt)──► LIVE ──(t ≥ closesAt)──► ENDED{SOLD | RESERVE_NOT_MET | NO_BIDS}
  └────────────── cancel(reason) ──────────────────┴──────────► CANCELLED
```

- Transitions are **commands** (`schedule`, `cancel`, `placeBid`, `setMaxBid`, `tick(now)`), never `UPDATE status`.
- `tick(now)` is pure and is called lazily on every command and by the alarm, so correctness never depends on alarm timing.
- Editing price, rules or bike details is allowed only in DRAFT/SCHEDULED. Once LIVE, only cancel is allowed.

### 4.2 Money

Integers in **paise** (`amountMinor`). ₹1 crore = 1e9 paise, which is below 2^53, so `number` is safe. Validate `Number.isSafeInteger`. Display with `Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0})`, which gives ₹2,81,500.

### 4.3 Increment ladder (realistic, configurable per auction)

| Current price | Min increment |
|---|---|
| < ₹25,000 | ₹250 |
| ₹25,000 – ₹1,00,000 | ₹500 |
| ₹1,00,000 – ₹3,00,000 | ₹1,000 |
| > ₹3,00,000 | ₹2,500 |

Before the first bid, the minimum next bid is the starting price. Add a **fat‑finger guard**: the server rejects bids more than 3× the current price (or above a per‑auction cap) with `BID_UNREASONABLE`, and the UI asks for confirmation when a bid is more than 20% over the minimum.

### 4.4 Reserve price (P0)

The reserve is hidden from buyers, who see only `reserveMet: boolean`. If the auction ends below it, the outcome is `RESERVE_NOT_MET`, which is realistic for bank repo lots where a valuer sets the reserve.

### 4.5 Soft close / anti‑sniping (P0, bounded)

A bid accepted with `closesAt − now < 2 min` sets `closesAt = now + 2 min`. **Cap the total extension** (e.g. `hardCloseAt = originalClosesAt + 30 min`) so the auction is guaranteed to end. That is a liveness invariant, and it needs a test.

### 4.6 Bidder privacy

Display name = `"Bidder " + base32(HMAC(secret, auctionId + userId)).slice(0,4)`. It is stable within an auction and unlinkable across auctions. The current user sees "You".

### 4.7 Proxy / auto‑bid (P1, the standout feature if time allows)

The user sets a hidden max. The engine resolves eBay‑style: price = `min(highestMax, secondHighestMax + increment)`. On equal maxes, the **earlier‑committed max wins** (by seq). Each automatic step is a normal bid row with `kind='PROXY'`. Everything is deterministic and pure, which makes it ideal for property tests. Skip it if P0 is not rock solid.

### 4.8 Invariants (each one gets a test)

| ID | Invariant |
|---|---|
| A | No bid accepted at authoritative `now ≥ closesAt` |
| B | Every accepted bid ≥ min next bid at commit time |
| C | One (userId, idempotencyKey) causes ≤ 1 effect; same key + different payload → 422 |
| D | Leader = highest committed bid (proxy: highest max, tie → earliest) |
| E | `seq` strictly increases by 1 per committed event |
| F | ENDED/CANCELLED are terminal |
| G | `closesAt ≤ hardCloseAt` always (soft close terminates) |
| H | Only ADMIN mutates auction configuration; userId comes only from the session |
| I | Price never decreases |
| J | D1 projection converges to DO state (eventually equal by seq) |

---

## 5. API design

- Versioned `/api/v1`, nouns for resources, **dedicated command endpoints** for lifecycle.
- **Errors: RFC 9457** `application/problem+json`:

```json
{ "type": "https://bike-auction.dev/errors/bid-too-low", "title": "Bid too low",
  "status": 409, "code": "BID_TOO_LOW", "detail": "Minimum bid is ₹82,000.",
  "minNextBidMinor": 8200000, "seq": 847, "requestId": "req_01J…" }
```

Codes: `AUTH_REQUIRED, FORBIDDEN, VALIDATION_FAILED, NOT_FOUND, AUCTION_NOT_LIVE, AUCTION_ENDED, AUCTION_CANCELLED, BID_TOO_LOW, BID_UNREASONABLE, SELF_OUTBID_NOT_ALLOWED*, IDEMPOTENCY_KEY_REUSED, RATE_LIMITED, CONFLICT, INTERNAL`. (*Decide: the leader may raise their proxy max but not outbid themselves.)

- 401 vs 403 used correctly; 409 for state conflicts; 422 for semantic validation; 429 + `Retry-After`.
- Every response carries `X-Request-Id`, and errors include it in the body.
- **Idempotency‑Key** is required on bid and admin POST commands. It is stored per user and kept for 24 h.
- Cursor pagination: `GET /auctions/:id/bids?beforeSeq=847&limit=30`, and `GET /auctions?status=LIVE&cursor=…`.
- `ETag` on auction detail / catalogue (cheap, and shows HTTP maturity).
- OpenAPI generated from the same Zod schemas; docs at `/api/docs`; CI fails on breaking spec diffs (optional).

```text
GET    /api/v1/health                      liveness (no deps)
GET    /api/v1/status                      version, commit, env, D1 ping
GET    /api/v1/auctions?status=&make=&city=&priceMax=&cursor=
GET    /api/v1/auctions/:id                detail + bike + inspection + live snapshot
GET    /api/v1/auctions/:id/bids?beforeSeq=&limit=
POST   /api/v1/auctions/:id/bids           {amountMinor} | {maxAmountMinor}
GET    /api/v1/auctions/:id/stream         WebSocket
GET    /api/v1/me · /me/bids · /me/watchlist · POST/DELETE /me/watchlist/:auctionId
GET    /api/v1/me/export · DELETE /api/v1/me          (data rights)
POST   /api/v1/admin/bikes · PATCH /admin/bikes/:id · POST /admin/bikes/:id/images
POST   /api/v1/admin/auctions · PATCH /admin/auctions/:id
POST   /api/v1/admin/auctions/:id/schedule · /cancel {reason}
GET    /api/v1/admin/auctions/:id/ops      seq, viewers, projection lag, rejects by reason
GET    /api/v1/admin/audit?resource=&cursor=
GET    /api/v1/admin/metrics?window=1h     (Analytics Engine SQL)
```

---

## 6. Data model

**DO SQLite (per auction):** `meta(user_version)`, `state` (single row: status, startsAt, closesAt, hardCloseAt, startPriceMinor, reserveMinor, ladderJson, softCloseMs, currentPriceMinor, leaderUserId, seq, outcome, finalisedAt), `bids(seq PK, bidId UNIQUE, userId, amountMinor, kind, at)`, `proxy_bids(userId PK, maxMinor, setSeq)`, `idempotency(userId, key, payloadHash, responseJson, createdAt, PK(userId,key))`, `outbox(eventId PK, seq, type, payloadJson, attempts, nextAttemptAt, projectedAt)`, `throttle(userId, windowStart, count)`.

**D1 (global):** Better Auth tables (`user, session, account, verification`) + `user_role`, `bikes`, `bike_images(r2Key, w, h, alt)`, `inspections(bikeId, grade, sectionsJson, inspectedAt, notes)`, `auctions_rm` (status, prices, closesAt, bidCount, leaderPseudonym, projection_seq), `user_bids_rm(userId, auctionId, myHighestMinor, isLeading, updatedSeq)`, `watchlist`, `audit_log` (append‑only; no UPDATE/DELETE path in code), `security_events` (logins, failures, role changes, exports, deletions; 1‑year retention), `consents(userId, version, purpose, at)`.

Indexes on `auctions_rm(status, closesAt)`, `auctions_rm(status, startsAt)`, `user_bids_rm(userId, updatedSeq)`, `audit_log(resourceType, resourceId, createdAt)`. D1 bills by rows scanned, so index every list query and use `EXPLAIN QUERY PLAN` in review.

---

## 7. Security

### 7.1 Authentication: **Day‑1 spike decides** (fixes gap #1)

Facts: Workers Free has **10 ms CPU per HTTP request**. Better Auth hashes with **scrypt** by default and allows custom `password.hash/verify`. Strong password hashing costs tens to hundreds of ms of CPU. SQLite‑backed DOs document a **30 s** default CPU budget per request **[SPIKE: confirm this applies on the Free plan]**.

Decision tree (timebox to 3 hours):

1. **Plan A: Better Auth + D1, hashing in a `PasswordHasher` DO.** Custom `hash/verify` RPCs to a DO (`idFromName("hasher-"+random(0..7))` shards load). Inside it, use WebCrypto **PBKDF2‑SHA256 at the highest iteration count workerd accepts [SPIKE: measure; workerd caps PBKDF2 iterations]**, with a per‑user salt and the parameters stored in the hash string so they can be upgraded later. Deploy, log in 20 times, and confirm zero CPU‑limit errors and p95 latency below 400 ms. ✅ If it passes, take Plan A: you keep full ownership and nothing extra is needed for DPDP.
2. **Plan B: Firebase Authentication (Spark, free) as credential custodian + your own session.** The client signs in with Firebase. `POST /api/v1/session` sends the ID token. The Worker verifies the RS256 JWT against Google's JWKS with `jose` (~1 ms CPU), upserts the user into D1, and issues **its own HttpOnly session cookie**. Roles stay in D1. Firebase also sends verification and reset emails for free. The cost is a third‑party processor for email + password hash, which you document.
3. **Plan C: Workers Paid ($5/mo).** Removes the CPU issue entirely. Mention it in trade‑offs as the "real production" choice even if you stay free.

Whichever plan wins, the requirements are the same:
- Cookie `__Host-session`: `Secure; HttpOnly; SameSite=Lax; Path=/`. 7‑day absolute / 24 h idle expiry; rotate on login; logout revokes it server‑side.
- Generic login errors and **no account enumeration** on register/reset.
- Turnstile on register + login. Per‑account progressive backoff after failures, logged to `security_events`.
- Password policy: minimum 10 chars, block the top common passwords (small bundled list); no composition rules (NIST 800‑63B style).
- Better Auth on D1: disable transactions / use batch mode per its D1 notes.

### 7.2 Authorisation
- Middleware `requireUser`, `requireAdmin` on the **server**. `userId` is always taken from the session.
- Admin routes are in a separate Hono sub‑app, so it is impossible to forget the guard. A test enumerates every `/admin/*` route and asserts 401 when anonymous and 403 for a normal user.

### 7.3 CSRF / origin
Same‑origin SPA + `SameSite=Lax` + **Origin/`Sec-Fetch-Site` check on every non‑GET** (Hono `csrf()` middleware) + Origin check on WS upgrade.

### 7.4 Headers (Hono `secureHeaders`)
`Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss://<host> https://*.sentry.io; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`. Also `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geolocation off). Verify with securityheaders.com and screenshot the result for the README.

### 7.5 Layered rate limiting (fixes gap #6)
| Layer | Mechanism | Example |
|---|---|---|
| Bot | Turnstile | register/login |
| Edge, coarse | Rate Limiting binding keyed by userId (or route+IP for anonymous) | 60 req/60 s per user on `/bids` |
| Exact, per auction | `throttle` table inside the DO | ≤ 5 bid commands / 10 s per user per auction |
| WS | per‑socket incoming message cap | close with 1008 on abuse |

### 7.6 Uploads
Admin only. Allow‑list `image/jpeg|png|webp`, **verify magic bytes** (don't trust `Content-Type`), ≤ 5 MB. The client **re‑encodes through a canvas before upload**, which strips EXIF/GPS and resizes to ≤ 2000 px. R2 keys are random UUIDs, images are served by the Worker with `Cache-Control: public, max-age=31536000, immutable` and `Content-Disposition: inline`, and the original filename is never used. P2: number‑plate masking tool (admin drags a blur box).

### 7.7 Threat model (`docs/threat-model.md`, STRIDE table)
Keep the original report's table and add: cross‑site WebSocket hijacking → Origin check; cross‑auction bidder tracking → HMAC pseudonyms; EXIF location leak → re‑encode; enumeration → generic responses; quota‑exhaustion DoS → rate limits + quota alerts + separate load‑test env; supply chain → lockfile, Dependabot, CodeQL, gitleaks, pinned GitHub Actions SHAs.

---

## 8. Data protection (India DPDP Act 2023 + DPDP Rules 2025)

The DPDP Rules were notified on **14 Nov 2025** with a staggered rollout. Most obligations apply after ~18 months, so in practice from around May 2027. Being designed for compliance already is a strong FDE signal. What to build and document:

| Principle | Implementation |
|---|---|
| Notice & consent | Plain‑language notice at signup (what, why, how long); required consent for the service; **separate, unticked** optional marketing consent; stored in `consents` with version |
| Data minimisation | Collect only name, email, city. **No Aadhaar/PAN/phone** (KYC out of scope by design) |
| Purpose limitation | Bidding data used only to run auctions; analytics events carry no PII |
| Security safeguards | TLS everywhere, encryption at rest (platform), least‑privilege API tokens, masked identifiers, access‑controlled admin, audit logs |
| Log retention ≥ 1 year | Workers Logs keep only 3 days on free, so **security & audit events are persisted in D1** and purged by cron after 365 days |
| Rights | `GET /me/export` (JSON) · `DELETE /me` → anonymise PII (name/email replaced, sessions revoked) but **keep pseudonymous bid records** for auction integrity (legitimate retention; documented) |
| Breach response | `docs/runbook.md` has a breach section: contain, assess, notify affected users promptly, initial intimation to the Board, detailed report within **72 h** |
| Processors | List Cloudflare, Sentry (PII scrubbing on: `sendDefaultPii:false`) and Firebase if Plan B |
| Log hygiene | Redaction middleware drops `password`, `cookie`, `authorization`, tokens; emails are hashed in logs |

---

## 9. Reliability

### 9.1 SLO targets (state them as targets, then measure)
Bid command p95 < 300 ms (same region); accepted‑bid propagation to other clients p95 < 500 ms; reconnect + snapshot convergence p95 < 2 s; projection lag p95 < 5 s; unexpected 5xx < 0.1 %; **duplicate effects / late bids / illegal transitions = 0** (hard invariants).

### 9.2 Failure‑mode table
Keep the original report's table and add these rows:

| Failure | Behaviour |
|---|---|
| Alarm handler throws 7 times | Catch‑all reschedules; lazy `tick()` on next command still closes correctly |
| DO evicted / hibernated mid‑auction | State reloads from SQLite in `blockConcurrencyWhile`; sockets keep attachments |
| Client tab asleep for 10 min | `visibilitychange` triggers a snapshot; bid button disabled until fresh |
| Bid response lost (network) | Client retries with the **same** Idempotency‑Key and gets the original result |
| D1 down | Bidding continues (DO authoritative); list page shows last projection with "updating" badge; outbox drains later |
| R2 down | Placeholder image; auction fully usable |
| Free quota exhausted | Explicit 503 page "Demo capacity reached, resets 05:30 IST" (00:00 UTC) instead of cryptic errors; alert fired at 70 % |
| Bad deploy | Post‑deploy smoke fails, so `wrangler rollback` runs automatically |

### 9.3 Backups & recovery
D1 Time Travel gives point‑in‑time restore for the last **7 days on free** (30 on paid); document the restore command in the runbook. Run a nightly GitHub Action `wrangler d1 export`, **encrypted with `age`** (it contains PII), and keep it as a 7‑day artifact. Auction ledgers live in DO SQLite; also project the full bid ledger to D1 (`bids_archive`) so they are reconstructible.

### 9.4 Protect the demo from yourself (fixes gap #4)
- Two environments in `wrangler.jsonc`: `production` (the reviewer link) and `staging`. **Ideally run staging on a second free Cloudflare account**, because quotas are per account.
- k6 runs **only** against staging or local `wrangler dev`, never production.
- An Analytics Engine counter tracks daily request/write volume, and a cron posts to a Discord/Slack webhook at 70 %.

### 9.5 Reviewer experience (fixes gap #5)
- **Demo recycler cron** (every 10 min): keeps ≥ 2 LIVE auctions (closing in 5–20 min), ≥ 2 starting soon, and a few ENDED with each outcome, by cloning templates. A reviewer opening the link on any day sees a living marketplace.
- **Bot bidder** (P1): on demo auctions, a seeded `bot` user occasionally outbids you through the **same command path** (scheduled via the alarm multiplexer, with randomised timing and a cap). One reviewer alone can then experience being outbid, real‑time updates and soft‑close extensions.
- A "Demo" banner lists the credentials, with a one‑click "Log in as Buyer A / Buyer B / Admin".
- README: "Open the same auction in a normal and an incognito window, logged in as Buyer A and Buyer B."

---

## 10. Observability

| Signal | Tool | Content |
|---|---|---|
| Logs | Workers Logs (`observability.enabled: true`) | One structured JSON line per request + domain events (`auction.bid.accepted/rejected`, `auction.extended`, `auction.ended`, `projection.failed`, `auth.login.failed`), always with `requestId, auctionId, seq, durationMs, version` |
| Metrics | Analytics Engine `writeDataPoint` | blobs: event, reason, route, status; doubles: durationMs, count; index: auctionId. Bounded cardinality: no emails/userIds |
| Errors | Sentry (Worker + React) | Release = git SHA; PII scrubbing; source maps uploaded in CI |
| Tracing | `requestId` propagated Worker → DO RPC → projection → WS event (`causationId`) | Enough to reconstruct one bid end to end |
| Uptime | External monitor on `/api/v1/health` + status badge in README | |
| Synthetic | Cron canary: create a 2‑min auction on a hidden `canary` flag, place 2 bids via internal RPC, assert outcome, write the result to AE | Proves the whole lifecycle works in prod every N minutes |
| Ops UI | `/admin/ops` | Live auctions, viewers, bids/min, rejects by reason, projection lag, p95 bid latency (from AE SQL), recent errors |

Note: **from 1 Dec 2026 Workers Logs moves to Cloudflare Observability pricing.** Re‑check the free allowance if you submit after that.

---

## 11. UI/UX specification

### 11.1 Design direction
"**Trading desk meets garage**": a calm, high‑contrast neutral base (zinc/stone), one confident accent (signal orange) for primary actions and LIVE, green for *winning* and amber for *outbid*. Every state is also communicated with **text + icon**, never colour alone. Use a modern grotesk (e.g. Inter / Geist) and **tabular numerals** (`font-variant-numeric: tabular-nums`) for prices and timers so digits don't jitter. Support light and dark (shadcn tokens). Respect `prefers-reduced-motion`.

### 11.2 Pages
Buyer: `/` (live now, ending soon, starting soon), `/auctions` (filters: status, make, cc band, price, city, year; sort: ending soonest), `/auctions/:id`, `/me/bids` (Leading / Outbid / Won / Lost tabs), `/me/watchlist`, `/account` (export, delete), `/login`, `/register`.
Admin: `/admin` (ops overview), `/admin/bikes` (+ new/edit with image uploader & inspection form), `/admin/auctions` (+ new: pick bike, start price, reserve, ladder preset, start/end, soft‑close toggle; preview), `/admin/auctions/:id` (live ops: seq, viewers, lag, bid ledger, cancel with reason), `/admin/audit`.

### 11.3 Live auction screen (the money page)
- **Desktop:** gallery and specs on the left; a sticky **bid panel** on the right.
- **Mobile:** gallery, then status pill, current price, countdown and reserve badge, then a **sticky bottom bid bar** that is always reachable; specs/inspection go in accordions below.
- Bid panel: current price (animated flash on change), *Min next bid*, input prefilled with the minimum, **quick chips** (+1, +2, +5 increments), primary button "Place bid ₹X". If you are leading: "✓ You're the highest bidder". If you are outbid: an amber banner "You've been outbid. Minimum now ₹X" plus a one‑tap rebid. The tab title flashes "(Outbid!)" and the phone vibrates (`navigator.vibrate`, when allowed).
- **Submitting state** (no optimistic win) → accepted toast; on rejection, map the `code` to human copy and **auto‑refresh the minimum**.
- **Countdown:** `hh:mm:ss` from server offset; under 2 min shows "Soft close active: late bids extend by 2 min"; extension shows a "+2:00 extended" chip. Show the absolute time too: "Ends 9:42 PM IST".
- **Connection pill:** Live ● / Reconnecting… / Paused (stale). In the stale state the bid button is disabled with the reason.
- **Reserve:** "Reserve not met" / "Reserve met ✓".
- **Bid history:** pseudonyms, relative time, your bids highlighted, "Load older" (cursor).
- **Ended:** outcome card. Winner sees "You won at ₹X. Our team will contact you" (out‑of‑scope stub); others see the final price; reserve‑not‑met is explained.
- Skeletons for loading, designed empty states, and an error boundary with requestId + retry.

### 11.4 Accessibility (WCAG 2.2 AA)
Labels on every input; visible focus; full keyboard flow (Enter to bid, Esc closes the confirm dialog); `aria-live="polite"` **only** for meaningful changes (outbid, accepted, extended, ended), **never** the ticking timer; alt text from bike data; 44 px touch targets; contrast checked; axe run in CI.

### 11.5 Microcopy (map error codes, never show raw messages)
`BID_TOO_LOW` → "Someone just bid. Minimum is now ₹82,000." · `AUCTION_ENDED` → "This auction has ended." · `RATE_LIMITED` → "You're bidding very fast. Try again in a few seconds."

---

## 12. Testing strategy

| Layer | Tooling | Must‑have cases |
|---|---|---|
| Domain unit | Vitest | boundaries at `closesAt−1ms / closesAt / +1ms`; ladder bands; reserve outcomes; soft‑close cap; terminal states; proxy resolution & ties |
| **Property / model‑based** | **fast-check** | Generate random sequences of `{bid, setMax, tick(+Δ), cancel, duplicateKey}` and apply them to the real engine and to a naive reference model. After every step, assert invariants A–J. This is the single most impressive test in the repo |
| DO integration | `@cloudflare/vitest-pool-workers` (`runInDurableObject`, `runDurableObjectAlarm`) | 50 concurrent equal bids via `Promise.all` on one stub → exactly 1 accepted; duplicate key → one effect; state survives a new stub instance; alarm after close finalises; outbox retry after simulated D1 failure |
| API | Worker tests via `SELF.fetch` | 401/403 matrix across all admin routes; problem+json shape; validation; CSRF Origin rejection; WS Origin rejection |
| E2E | Playwright (2 browser contexts) | A bids → B sees it without reload → B outbids → A sees the outbid banner; `context.setOffline(true)` → reconnect → snapshot; auction ends → both see the outcome; non‑admin blocked from `/admin`; axe scan on key pages |
| Load | k6 (staging only) | many auctions (1,000 VUs over 100 auctions); hot auction (300 WS + bid spikes); reconnect storm. Results with p50/p95/p99 in `docs/load-test-results.md` |

Inject `Clock` everywhere in the domain, and never call `Date.now()` there. Target coverage of ≥ 90 % for `packages/domain`. Don't chase coverage elsewhere.

---

## 13. CI/CD & environments

```text
PR:    install (frozen) → lint (eslint/biome) → typecheck → unit+property → worker integration
       → build → e2e (against wrangler dev) → `wrangler versions upload` (preview URL comment)
       + CodeQL, gitleaks, dependency review
main:  same gates → d1 migrations apply (prod) → deploy → smoke (Playwright @smoke on prod)
       → on failure: wrangler rollback + fail the job
cron:  nightly encrypted D1 export; weekly dependency updates (Dependabot)
```

Migrations are forward‑only and backward‑compatible (expand → migrate → contract). `GET /api/v1/status` shows the commit SHA. Secrets live only in `wrangler secret`. Commit `.dev.vars.example`, never `.dev.vars`. Protect the `main` branch.

---

## 14. Feature tiers

**P0, must ship and be excellent:** auth + roles (spike‑decided) · bike catalogue with Indian used‑bike fields + inspection report + images · full lifecycle · multiple simultaneous auctions · DO per auction · idempotent bids · server time · increment ladder · **reserve price** · **bounded soft close** · WS live feed + snapshot recovery + connection states · buyer UI (list, detail, my bids) · admin console with live ops + audit log · structured logs + AE metrics + Sentry · security headers, CSRF, rate limits, Turnstile · unit/property/integration/E2E tests · CI/CD with rollback · **demo recycler** + seeded accounts · docs (README, architecture, ADRs, threat model, runbook, assumptions/trade‑offs).

**P1, the differentiators:** proxy/auto‑bid · bot bidder for demos · watchlist + in‑app outbid notifications (targeted WS) · `/api/docs` (Scalar) · ops charts · data export/delete · dark mode · k6 report · synthetic canary.

**P2, only if everything else is done:** email notifications (free tier of a transactional provider such as Resend) · number‑plate blur · PWA + web push · bid CSV export · Hindi locale.

**Out of scope (say so explicitly):** payments/EMD, KYC, ownership/RC transfer, logistics, chat, recommendations, microservices, Kafka/Redis/Kubernetes.

---

## 15. Build plan (≈ 10 focused days; compress by cutting P1)

| Day | Outcome |
|---|---|
| **1 – Spikes & skeleton** | CF account (+ second for staging), pnpm monorepo, Worker + static assets + D1 + R2 + DO bindings, `/health` **deployed**. **Spikes:** (a) password hashing CPU (§7.1) → pick auth plan; (b) WS hibernation hello‑world with auto‑response; (c) DO RPC + alarm. CI with lint/typecheck/test running |
| 2 – Auth & roles | Register/login/logout, session cookie, RBAC middleware, Turnstile, seeded users, 401/403 test matrix |
| 3 – Domain engine | `packages/domain`: lifecycle, ladder, reserve, soft close, idempotency semantics; unit + **fast-check** tests green |
| 4 – AuctionDO | SQLite schema + migrations, `placeBid` critical section, alarm multiplexer, outbox → D1 projection; concurrency/integration tests |
| 5 – Catalogue & admin | Bikes, inspection, image upload (re‑encode), auction create/schedule/cancel, audit log |
| 6 – Real‑time | WS hub, tags, snapshot, client reconnect/offset/stale states |
| 7 – Buyer UX polish | Live auction page (mobile sticky bar, chips, outbid UX), list/filters, my bids, a11y pass |
| 8 – Observability & hardening | Logs schema, AE metrics, Sentry, ops page, headers/CSP, rate‑limit layers, DPDP features (consent, export, delete, retention cron) |
| 9 – Reliability & proof | Demo recycler, (bot bidder), Playwright 2‑context E2E, k6 on staging, deploy pipeline with smoke + rollback |
| 10 – Docs & demo | README, architecture + ADRs, threat model, runbook, assumptions/trade‑offs, load‑test results, 3‑min demo video/GIF |

Rule: **deploy every day.** Never let production lag behind main by more than a day.

---

## 16. Submission package

```text
README.md            live link · demo accounts · 60-sec "how to see real-time" · screenshots/GIF ·
                     features · architecture diagram · local setup · tests · deploy · observability ·
                     security · assumptions · trade-offs · known limitations · free-tier envelope
docs/architecture.md invariants · flows · DO internals · alarm multiplexer · failure table
docs/adr/001..007    workers · DO-per-auction · HTTP commands/WS events · D1 read model+outbox ·
                     idempotency · auth plan (spike result!) · soft close + reserve rules
docs/threat-model.md docs/runbook.md docs/data-protection.md docs/load-test-results.md
```

Demo accounts (demo‑only passwords): `admin@demo.bikeauction.dev`, `buyer.a@…`, `buyer.b@…`.

**Extra interview questions to prepare** (beyond the original report's list):
- *"Your alarm and your outbox both need the single DO alarm. How?"* → multiplexer, min of candidates, idempotent handler.
- *"Why can't you `await` the D1 write inside placeBid?"* → interleaving / input gates; outbox after commit.
- *"What did your Day‑1 spike show?"* → real CPU numbers, and why you chose Plan A or B.
- *"How does soft close guarantee termination?"* → hardCloseAt cap, property‑tested.
- *"How do you keep someone from tracking a dealer across auctions?"* → HMAC per‑auction pseudonyms.
- *"What happens to a deleted user's winning bid?"* → PII anonymised, pseudonymous ledger retained (integrity), documented under DPDP.

> The sentence to leave the interviewer with: **"Every mutation for an auction goes through one authoritative, single‑threaded object that commits synchronously. Everything around it (sockets, projections, clients, alarms) is designed to be lost and recovered."**

---

## Sources
- Cloudflare Workers limits (Free: 10 ms CPU/request, 100k req/day): https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing (DO/D1 free allowances, static assets free, Logs change 1 Dec 2026): https://developers.cloudflare.com/workers/platform/pricing/
- Durable Objects limits (SQLite DO 30 s CPU default, 1,000 rps soft limit/object, 100 classes on Free): https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects alarms (single alarm, at‑least‑once, 6 retries): https://developers.cloudflare.com/durable-objects/api/alarms/
- DO free tier announcement: https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/
- Rate Limiting binding (per‑location, eventually consistent, 10/60 s periods): https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Analytics Engine pricing (100k points/day, 10k queries/day free, not billed): https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- D1 Time Travel (7 days free / 30 paid): https://developers.cloudflare.com/d1/reference/time-travel/
- Better Auth email & password (scrypt default, custom hash/verify): https://www.better-auth.com/docs/authentication/email-password
- Password hashing on Workers discussion: https://flaviocopes.com/native-email-password-authentication-cloudflare-workers/
- Clerk pricing (Hobby: 50k MRU), considered as an alternative: https://clerk.com/articles/clerk-pricing-explained
- Sentry free plan summary: https://costbench.com/software/developer-tools/sentry/free-plan/
- DPDP Rules 2025 notification & timelines: https://www.storyboard18.com/amp/digital/breaking-govt-notifies-final-dpdp-rules-sets-staggered-rollout-with-key-obligations-for-data-fiduciaries-84201.htm
- Vutto business (Series A, repo‑bike partnerships, Delhi showrooms): https://entrackr.com/snippets/used-two-wheeler-marketplace-vutto-raises-7-mn-in-series-a-round-9765499
- Bank two‑wheeler auction practice (reserve, as‑is where‑is): https://xpertarc.com/bank-auction-vehicle/two-wheeler
