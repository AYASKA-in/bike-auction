# Architecture

> Full design rationale: `BLUEPRINT.md`. This document describes what exists and the invariants it
> protects, and is kept current as the code evolves.

## Components

| Component                                | Responsibility                                                                                                 | Source of truth for     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| React SPA (`apps/web`)                   | UI. Server-time offset for countdowns. Never decides validity                                                  | nothing                 |
| Worker / Hono (`apps/worker/src/app.ts`) | Request ids, structured logs, security headers, CSRF origin guard, validation, RFC 9457 errors, routing to DOs | nothing (stateless)     |
| `AuctionDO` (one per auction, SQLite)    | Lifecycle, bid validation, ordering (`seq`), bid ledger, outbox, deadlines, WebSocket fan-out                  | **live auction state**  |
| `PasswordHasherDO` (4 shards)            | Better Auth password hash/verify outside the 10 ms Worker budget                                               | nothing                 |
| D1                                       | Users/sessions (Day 2), catalogue, read models (`auctions_rm`), audit log                                      | users, catalogue, audit |
| R2                                       | Bike images (Day 5)                                                                                            | images                  |

## Bid data flow (Day-1 implementation)

```
client ──HTTP──▶ Worker ──RPC──▶ AuctionDO.placeBid()
                                   │ maybeClose(now)         ← lazy, alarm-independent
                                   │ validate vs minNextBid  ← @bike/domain (pure)
                                   │ transactionSync{ bid row, state, seq+1, outbox row }
                                   ├─ broadcast bid.accepted to sockets (tag "all")
                                   └─ waitUntil(drainOutbox) → D1 upsert WHERE seq newer
```

## Recovery mechanisms

| Failure                     | Mechanism                                                       | Status                              |
| --------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| DO evicted / restarted      | state in SQLite; schema migrated in constructor                 | tested                              |
| Socket idle / DO hibernates | Hibernation API; attachments; auto-response pings               | tested                              |
| D1 unavailable              | outbox + exponential backoff timer; idempotent monotonic upsert | tested                              |
| Close alarm late or lost    | lazy close on every command; alarm handler always reschedules   | tested                              |
| Client missed events        | snapshot on (re)connect; `seq` gap detection                    | snapshot tested; client logic Day 6 |
| Duplicate HTTP retries      | Idempotency-Key per (user, key)                                 | Day 4                               |

## Invariants: Day-1 coverage (superseded below)

- **B** accepted bid ≥ minimum: tested · **D** leader = top of ledger: tested · **E** seq gap-free: tested
- **A** no bid at/after close: tested (lazy close) · **I** price never decreases: tested
- **C, F, G, H, J**: Day 3–4 (domain engine, idempotency, auth); J partially (projection convergence tested)

## Auction domain engine (Day 3)

Rules, lifecycle, reserve, soft close, events, idempotency and pseudonyms are specified in
[ADR 004](adr/004-auction-rules.md) and implemented as pure functions in `packages/domain/src/auction/`:

| Module           | Responsibility                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`      | `createAuction`, `updateTerms`, `schedule`, `tick`, `placeBid`, `cancel`, `minNextBidFor`, `maxAcceptableBid`, `outcomeFor` |
| `config.ts`      | defaults (soft close 2/2/30 min, 3× limit, ₹1 crore ceiling), term and rule validation                                      |
| `events.ts`      | typed internal events with contiguous `seq`                                                                                 |
| `views.ts`       | allow-listed public view and public events (no reserve, no user ids)                                                        |
| `idempotency.ts` | fingerprint, `resolveIdempotency`, stored results, 24 h retention                                                           |
| `pseudonym.ts`   | HMAC-based per-auction bidder codes with collision growth                                                                   |

### Invariant coverage

| Invariant                        | Where it is proven                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| A no bid at/after close          | unit boundary tests (−1/0/+1 ms) + model property (every acceptance `at < closesAt`)   |
| B accepted ≥ minimum at commit   | model property (checked against the model's pre-state minimum)                         |
| C one effect per idempotency key | model property (retries add no accepted bids; replays equal first result) + unit tests |
| D leader/price match ledger      | model property + Worker test (200 concurrent bids)                                     |
| E contiguous seq                 | model property (committed log seq = index + 1) + Worker test                           |
| F terminal states                | unit tests (all commands rejected) + model property (terminal event is last)           |
| G closesAt ≤ hardCloseAt         | soft-close unit tests + model property every step                                      |
| H price never decreases          | model property (strictly increasing ledger)                                            |
| I reserve never public           | strict Zod contracts + model property every step + Worker privacy regression tests     |
| J deterministic winner           | engine vs model outcome every step + replay-determinism property                       |
| K no bids → no winner            | unit + model property                                                                  |
| L no duplicate terminal events   | unit (repeated ticks) + model property (tick after end emits nothing)                  |
| Authorization                    | Worker `test/authz.test.ts` (not a domain concern)                                     |
| D1 projection convergence        | Worker `test/auction-do.test.ts` (outbox) + Day-3 durability regression                |

### Testing approach

- **Model-based property test** (`packages/domain/test/model.property.test.ts`): fast-check generates scenarios
  (start prices at band boundaries, optional reserve, soft close on/off) and up to 60 commands (bids of 7 amount
  kinds incl. malformed, retries with same/different payload, time jumps, jumps near close and past the hard cap,
  ticks, cancels). An independent reference model, written from the spec with no shared code, is stepped
  alongside the engine; observable state is compared after every step and invariants A–L are asserted. Coverage
  counters fail the test if any scenario class (every rejection code, extensions, replays, conflicts, all three
  outcomes, cancel ok/rejected) is never generated. Default seed 20261012 × 400 runs in CI; also run locally
  with seeds 1, 42, 987654, 31337 × 3000 runs. Reproduce with `FC_SEED`, `FC_PATH`, `FC_RUNS`.
- Coverage (`pnpm --filter @bike/domain test:coverage`, thresholds 90%): 98.3% statements, 97.9% branches, 100% functions.

### Day-4 integration (implemented, see below)

Inside `AuctionDO.placeBid`, with **no await between read and commit**:

1. read `state` row → domain `AuctionState`; read idempotency row for (userId, key);
2. `resolveIdempotency` → replay: return stored result; conflict: 422, no writes;
3. `placeBid(state, {bidId, userId, amountMinor, now: Date.now()})`;
4. `transactionSync`: write new state, `bid.accepted` → `bids` row, ALL returned events → `outbox`,
   idempotency record (accepted or rejected), and timers (`close` = new `closesAt`, `outbox` = now) through the
   alarm multiplexer;
5. after commit: map events with `toPublicEvent` (pseudonyms via HMAC adapter, cached per auction in a
   `pseudonyms` table) and broadcast; `waitUntil(drainOutbox())`.
   Alarm handler: `tick(state, now)`; commit its events the same way. GC idempotency rows older than 24 h via a timer.

## Live bidding backend (Day 4)

`AuctionDO` now delegates every rule to `@bike/domain`; the Day-1 rule code is gone (one implementation).

**Bid path:** HMAC pseudonym digest (async, before reading state) → read state → `resolveIdempotency`
(replay/conflict return immediately) → per-user throttle (new commands only) → `placeBid` (pure) → one
`transactionSync`: state, events (= outbox), bid row, idempotency record, pseudonym, timers → broadcast public
events + targeted `you.outbid` → `waitUntil(drainOutbox)`. No await between read and commit.

**Lifecycle:** `lifecycle` timer = startsAt (SCHEDULED) or closesAt (LIVE, moved by every extension). Alarm and
every read/command run `tick` and commit due transitions; `tick` is idempotent, so at-least-once alarms and lazy
reads cannot duplicate `auction.ended`. Admin create/edit/schedule/cancel go through the same commit path.

**Recovery:** constructor re-arms missing lifecycle/outbox/idem-gc timers; state is cached in memory only after a
successful commit; WebSockets hibernate and survive eviction.

**D1 sync:** coalesced drain → one atomic D1 batch (summary + bid rows + per-user rows) → mark projected up to the
batch's last seq. Failure: attempts++, `sync_status` updated, exponential backoff timer (1 s … 60 s). Ops view:
`GET /admin/auctions/:id` → `ops` (seq, projectedSeq, pendingOutbox, oldestPendingAgeMs, sync, timers).

## Catalogue and listings (Day 5)

- **Read path:** catalogue cards and filters come from one D1 query joining `auction_listings`, `bikes`,
  `auctions_rm`, the latest inspection grade and the cover image. No Durable Object is contacted to render a
  list. Status shown is derived from the schedule (a SCHEDULED row past its start reads as LIVE) so cards stay
  honest even if a projection is briefly late.
- **Detail page:** static bike data from `/auctions/:id/details` (D1); price, bids, reserve-met and status from
  the DO (`GET /auctions/:id`, then the WebSocket). The client reducer applies an HTTP view only if its seq is
  ≥ the socket's, so a delayed read can never override newer authoritative state.
- **Listing → auction workflow:** bike → inspection (required) → photos → `POST /admin/auctions` inserts the
  listing row first (the partial unique index rejects a second open auction, race-safe), then creates the DO.
  If the DO call fails the listing row is deleted; a listing stranded by a crash between the two (no read model
  after 2 min) is released automatically on the next create. Drafts are reviewed, then scheduled.
- **Images:** the browser resizes to ≤2000 px and re-encodes to WebP/JPEG (drops EXIF/GPS); the Worker
  re-validates size, magic bytes vs declared type, and dimensions; R2 put happens before the D1 insert and is
  deleted if the insert fails, so no orphans. The bucket is private; images are streamed through the Worker.
- **Audit:** every admin mutation (bike, inspection, image, auction create/edit/schedule/cancel) is written to
  `audit_log` with admin id, time, record and a minimal, secret-free metadata object.

## Live auction frontend (Day 6)

```
GET /auctions/:id (HTTP view) ─┐
                               ├─▶ LiveFeed (one per auction, refcounted registry) ─▶ reduceLive (pure) ─▶ React
WebSocket /stream ─────────────┘        │  reconnect/backoff, offline/online, visibility, heartbeat,
GET /auctions/:id/bids (history) ◀──────┘  gap→resync, deadline→resync, history merge
POST /auctions/:id/bids ─(201 {seq})─▶ feed.noteOwnBid → "You're leading" when that seq is the latest bid
```

- **`live-auction.ts`** is a pure reducer: seq ordering, stale-HTTP guard, leading/outbid, bid history (dedupe by
  seq), lifecycle. **`live-feed.ts`** owns the socket and timers and is framework-free, so both are unit-tested
  with a fake socket and fake timers. React binds via `useSyncExternalStore` (`use-live-auction.ts`): subscribing
  acquires the feed, unsubscribing releases it; the socket closes one tick after the last user leaves (survives
  StrictMode remounts, never leaks).
- **Polling only as a fallback:** the HTTP view is refetched every 15 s only while the socket isn't live.
- **Countdowns** share one 1 s ticker aligned to wall-clock seconds; only countdown leaves re-render. Device clock
  errors are corrected by the measured server offset.
- **Catalogue** cards never open sockets: the list refetches every 30 s while visible, on focus/reconnect, and
  once (coalesced) when any card's start/close passes. A failed refresh marks prices "may be outdated".
- **Bid safety:** client validation (whole rupees, ≥ minimum), confirmation above 1.5× the minimum, one
  idempotency key per intended bid, kept for a manual retry after an uncertain failure (network/timeout/5xx),
  never an automatic retry. Success only after the server's 201.
- **Code splitting:** every page except home is a lazy route chunk. First load 577 KB → 490 KB (gzip 178 → 155
  KB); no chunk over 500 KB.

## Known limitations (Day 6)

- Nothing verified on real Cloudflare or R2 yet (deploy pending your approval); live behaviour was tested on
  `wrangler dev` (workerd), including a real process restart.
- A socket keeps the identity it connected with: if the session expires mid-auction, personal fields
  (`viewer`) stay until the next reconnect; bidding itself is refused immediately (401) and the UI asks to sign in.
- "You've been outbid" survives reconnects but not a full page refresh (the server has no per-user
  "was outbid" state; My Bids is Day 8).
- The first load still carries zod and the router (~490 KB raw); `zod/mini` could cut more.
- Price sorts use keyset paging on a value that changes while bids arrive; a card can move between pages.
- No bundled demo photos (no authorised images available); placeholders are shown.

## Known limitations (Day 4)

- Nothing verified on real Cloudflare yet (deploy pending): CPU limits, alarm timing, WS limits, D1 latency.
- Per-user per-auction throttle (10 / 10 s) is in-memory: exact per instance, resets on eviction.
- `auction.created/updated` are not broadcast; a client watching a SCHEDULED auction that an admin edits sees a
  seq gap and resyncs (by design).
- Projection lag/failures are visible in ops and logs; Analytics Engine metrics and alerting are Day 8.
- Soft-close boundaries are proven at the domain level (ms-exact); DO tests check integration with real time.
- Worker test files run sequentially (parallel runs on 2 cores hung intermittently; root cause not isolated).

## Observability (Day 8)

Runbook: [`docs/runbook.md`](runbook.md). API: [`docs/api.md`](api.md) → _Admin observability_.

### Log schema (Workers Logs, one JSON object per line)

`apps/worker/src/lib/logger.ts`. Every line: `ts` (ISO 8601), `level`, `event` (the operation, dotted:
`http.request`, `auction.bid.accepted`, `auction.projection.failed`, `auction.alarm_failed`, …), plus
context. Request-scoped lines also carry `requestId`, `version`, `environment`, `colo`. The **completion
line** (`event: "http.request"`, one per request, `middleware/request-context.ts`) has `method`, `route`
(the matched _pattern_, e.g. `/api/v1/auctions/:id/bids`, or `unmatched` — never the raw URL or query),
`status`, `durationMs`, `code` (RFC 9457 problem code on errors) and `auctionId` when the path names one;
5xx lines are `level: "error"`. Auction-object lines carry `auctionId`, `requestId` and `seq`. Errors are
logged as `errorName` + `errorMessage` (≤ 500 chars), never stacks with request data.

**Never logged** (enforced by `redact()` at any depth as a safety net, tested in `test/ops.test.ts`): any
key matching `/pass|token|cookie|secret|authorization|email|reserve|max|session|^ip$|…connecting-ip|forwarded|real-ip/i`
→ `"[REDACTED]"`; e-mail addresses inside free text → `[email]`. So no passwords, session tokens,
cookies, client IPs, e-mails, reserve amounts or hidden maxima. User ids appear only where needed for
security investigations (security events store HMACs, not raw IPs/e-mails).

### Metric schema (Workers Analytics Engine, dataset `bike_auction_metrics`, binding `METRICS`)

`apps/worker/src/lib/metrics.ts`. **Optional binding:** unbound (tests without it, a deploy that strips
it) → every write is a no-op; a throwing binding is swallowed — metrics can never fail a request or a bid.

| Field     | Content                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `index1`  | `auctionId` for auction events, else `"<METHOD> <route pattern>"` (sampling key)                  |
| `blob1`   | event (table below)                                                                               |
| `blob2`   | `"<METHOD> <route pattern>"` or `""`                                                              |
| `blob3`   | status class `2xx`…`5xx` or `""`                                                                  |
| `blob4`   | outcome: problem `ErrorCode`, `MANUAL`, `ok`/`error`, WS close code, lifecycle kind (all bounded) |
| `blob5`   | exact HTTP status (`"429"`) or `""`                                                               |
| `blob6`   | colo (≈ 300 values) · `blob7` version (git SHA)                                                   |
| `double1` | `durationMs` · `double2` `count` · `double3` event-specific value                                 |

| Event                              | Where                 | outcome / doubles                                                                                    |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `http_request`                     | request middleware    | problem code or `ok`; d1 = I/O duration                                                              |
| `auth_security`                    | request middleware    | `/auth/*` non-2xx by code (`INVALID_CREDENTIALS`, `RATE_LIMITED`, `CAPTCHA_FAILED` …)                |
| `bid_accepted` / `bid_rejected`    | `AuctionDO.placeBid`  | `MANUAL` / rejection code; d1 = in-object processing latency, d2 = bids committed (incl. automatic)  |
| `max_bid_set` / `max_bid_rejected` | `AuctionDO.setMaxBid` | `ok` / code; d2 = automatic bids committed (the maximum itself is never recorded)                    |
| `ws_connect` / `ws_disconnect`     | `AuctionDO`           | `user`·`anon` / close code; d2 = open sockets after; d3 = 1 for an abnormal close (≠ 1000/1001/1005) |
| `ws_error`                         | `AuctionDO`           | socket errors                                                                                        |
| `projection_lag`                   | outbox drain success  | d1 = age of the oldest projected event, d2 = events, d3 = still pending                              |
| `projection_failure`               | outbox drain failure  | `d1_error`; d3 = consecutive failures                                                                |
| `alarm_run`                        | `AuctionDO.alarm`     | `ok`/`error`; d1 = duration, d2 = due timers                                                         |
| `auction_lifecycle`                | publish               | `started`·`extended`·`cancelled`·`ended:<outcome>`; d1 (ended) = commit delay after `closesAt`       |
| `do_rpc_failure`                   | ops summary           | an object RPC threw                                                                                  |

Cardinality is bounded by construction (enums, codes, route patterns, auction ids). No user ids,
e-mails, IPs, reserves or maxima. Free plan: 100k data points written and 10k read queries per day;
Analytics Engine is currently not billed. Every request writes ≥ 1 point, so the AE budget tracks the
Workers 100k-requests/day budget. Query example (AE SQL API):
`SELECT blob4, SUM(_sample_interval) FROM bike_auction_metrics WHERE blob1='bid_rejected' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY blob4`.

### Ops UI and health

- `/admin/ops`: overall status (ok / degraded / down), live auctions (≤ 50, closing soonest) with
  health badge, viewers (open sockets), seq vs projected seq, outbox backlog + oldest pending age, bids
  in the last 5 min, last successful D1 sync, sync errors, and a warnings list (stuck/failing projection,
  unreachable object, overdue deadline or timer, failed alarm, stale read model). Auto-refresh every 10 s
  only while the tab is visible; "Retry projection" per auction. Values an object did not report show
  as "Unavailable", never as 0.
- `/admin/auctions/:id`: authoritative state over the read-only live feed (price, bids, accepted seq,
  leader pseudonym, deadline, extensions, reserve met — no amount), ops (viewers, projection, last sync,
  failures, timers with overdue marker), the pseudonymous ledger (with kind, "Load older"), cancel with
  reason (two-step confirm) and retry projection.
- `/admin/audit`: filters by action, admin, affected record id and IST date range; keyset pagination.
- Health: public `GET /health` (liveness) and `GET /status` (version + D1) are minimal by design;
  admins get `GET /admin/ops/health` (D1 latency, metrics binding, stale read-model scan).

**Anomaly rules** (grace 60 s, `OPS_GRACE_MS`): object `LIVE` with `closesAt` passed, or `SCHEDULED` with
`startsAt` passed → `DEADLINE_OVERDUE`; any timer due > grace ago → `TIMER_OVERDUE` (alarm late/failing);
D1 row still `LIVE`/`SCHEDULED` past its close (or `SCHEDULED` past its start) → `READ_MODEL_STALE`
(either the alarm or the projection is stuck; buyers don't see it because lists use the effective status);
pending events older than the 5 s projection SLO → lagging; any failed attempt → failing.

### Known limitations (Day 8)

- `lastAlarmError` is in object memory (lost on eviction); the durable record is the log line + metric.
- `audit_log` has no `created_at` index (a migration was out of scope for this change); fine at demo
  volume, add `CREATE INDEX idx_audit_created ON audit_log (created_at, id)` before it grows.
- p95 latency and rejects-by-reason charts are AE SQL queries (runbook), not rendered in the UI yet.
- Alerting (webhook at 70 % of quota) is not implemented.
