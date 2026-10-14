# Day-1 spike results

Date: 12 Oct 2026. Environment: local `workerd` via `@cloudflare/vitest-plugin` 1.4.0 / Wrangler 4.149.0
(workerd 1.20261006.1), Linux x64 cloud VM. **Nothing has been deployed to Cloudflare yet**, so everything
below is either _verified locally_, _verified from source/docs_, or _unverified (needs deployment)_.

## A. Authentication on Workers Free

| Fact                                                                                              | Status                                              | Evidence                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Workers Free CPU limit is 10 ms per HTTP request                                                  | Docs                                                | developers.cloudflare.com/workers/platform/limits                                                                        |
| Better Auth 1.7.7 hashes with scrypt N=16384, r=16, p=1, 64-byte key                              | **Verified from source**                            | `@better-auth/utils/password`: under the `workerd` export condition it uses `node:crypto` scrypt (needs `nodejs_compat`) |
| That scrypt costs **~91 ms CPU per derive** (p50 of 10, max 94 ms)                                | **Measured** (native OpenSSL in Node 22 on this VM) | `process.cpuUsage()` around `scryptSync`                                                                                 |
| PBKDF2-SHA256: 100k it ≈ 19 ms, 600k it ≈ 100 ms                                                  | **Measured**, same method                           |                                                                                                                          |
| A login or registration is one derive, i.e. ~9× over the Free CPU limit                           | Derived                                             |                                                                                                                          |
| Better Auth's hash/verify work **inside a Durable Object** (format `salt:key`, verify true/false) | **Verified locally** in workerd                     | `test/password-hasher.test.ts`                                                                                           |
| SQLite-backed DOs get a 30 s default CPU budget per request                                       | Docs                                                | durable-objects/platform/limits                                                                                          |
| …and that budget applies on the **Free** plan                                                     | **UNVERIFIED**                                      | needs a deployed test                                                                                                    |
| Better Auth supports D1 natively                                                                  | **Verified from source**                            | `@better-auth/kysely-adapter` ships a D1 dialect that uses `batch()` and throws on interactive transactions              |

Measurement note: inside workerd, `performance.now()`/`Date.now()` don't advance during pure computation
(Spectre mitigation), so CPU can't be timed from inside the runtime. An attempt to time requests externally
against `wrangler dev` was abandoned because this workspace's HTTP proxy interfered with loopback traffic
(`scripts/spike-auth-cpu.mjs` is kept; run it on your own machine). The native-crypto numbers come from
the same OpenSSL-class implementation workerd uses and are an **order-of-magnitude estimate** for
Cloudflare hardware, which may be faster or slower.

**Decision (provisional): Plan A.** Better Auth with D1; `password.hash/verify` delegate over RPC to
`PasswordHasherDO` (4 shards), which calls Better Auth's own functions. No custom crypto, no weakened
parameters. **Gate on Day 2:** deploy, register and log in 20× on the Free plan, and check Workers Logs for
CPU-exceeded errors. If any appear, switch to Plan B (Firebase Auth as credential custodian + our own
HttpOnly session), or Plan C (Workers Paid, $5/mo).

## B. Durable Object concurrency and persistence: verified locally

All of the following are executable tests in `apps/worker/test/auction-do.test.ts`:

| Behaviour                                        | Result                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 50 simultaneous identical bids via RPC           | exactly **1 accepted**, 49 `BID_TOO_LOW`, seq advanced once                                       |
| 200 concurrent random bids                       | ledger seq gap-free, amounts strictly increasing, snapshot == top of ledger                       |
| `evictDurableObject()` then a fresh stub         | snapshot identical; next bid gets seq+1 (state reloaded from SQLite)                              |
| Bid after `closesAt` before the alarm fires      | rejected `AUCTION_ENDED` (lazy close)                                                             |
| D1 read model unavailable (table renamed away)   | bids still **accepted**; outbox pending; retry scheduled with backoff; converges after D1 returns |
| Projection replay                                | no-op (monotonic `projection_seq` guard)                                                          |
| **Spike probe:** `await` between check and write | **>1 of 10 concurrent bids "won"** (lost update reproduced)                                       |
| **Spike probe:** synchronous check-and-write     | exactly 1 of 10                                                                                   |

**Concurrency guarantees actually relied on:** a DO delivers events one at a time _between awaits_.
`ctx.storage.sql.exec` is synchronous, so a critical section with no `await` is atomic.
`transactionSync` makes multi-row writes all-or-nothing. **Any `await` on non-storage I/O (fetch, D1,
timers) lets other requests interleave**, which the probe demonstrates. Rule for the codebase: read →
decide → `transactionSync` commit with no awaits; network I/O only after commit.

## C. WebSockets and alarms: verified locally

`apps/worker/test/websocket.test.ts` and the alarm tests:

| Behaviour                                                        | Result                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Upgrade through Worker route → DO (`acceptWebSocket` with tags)  | 101, `hello` + `auction.snapshot` received                                                       |
| Two clients; bid committed via RPC                               | the other client receives `bid.accepted` with seq and next minimum                               |
| Cross-site Origin on upgrade                                     | 403 (CSWSH defence)                                                                              |
| Heartbeat `{"type":"ping"}`                                      | answered by `setWebSocketAutoResponse`                                                           |
| `evictDurableObject(stub, {webSockets:"hibernate"})`, then a bid | the socket **survives** and receives the broadcast                                               |
| Naive `setAlarm(t1); setAlarm(t2)`                               | `getAlarm()` returns t2, so the first deadline is silently lost                                  |
| Multiplexer (`timers` table → single alarm = MIN(due_at))        | alarm equals earliest timer; close alarm ends the auction; projection then drains; alarm cleared |

**Bug found and fixed:** a 101 response returned through a DO stub has **immutable headers**. Hono
middleware that sets `X-Request-Id`/security headers threw "Can't modify immutable headers" (HTTP 500).
The route now re-wraps the response (`new Response(body, {status, headers, webSocket})`).

**Multiplexer design for Day 4:** all deadlines (`start`, `close`, `outbox`, `idempotency-gc`, `demo-bot`)
are rows in `timers`; every change calls `rescheduleAlarm()`; `alarm()` processes due rows, catches errors,
and always reschedules in `finally` (alarms retry at most 6 times). Correctness never depends on alarm
timing because every command first runs the lazy lifecycle check.

## Free-tier limits that shape the design (docs, 12 Oct 2026)

Workers: 100k requests/day, 10 ms CPU/request. DO: 100k requests/day, 100k SQLite rows written/day.
D1: 100k rows written/day, 5M read/day. Static asset requests are free and unlimited. Workers Logs keep
3 days (pricing changes 1 Dec 2026). Load tests must not run against the production free account.

## Other findings

- `@cloudflare/vitest-pool-workers` is **deprecated**, renamed to `@cloudflare/vitest-plugin` (used here).
- TypeScript 7 (Go-native) is "latest", but typescript-eslint supports `<6.1`, so TS is pinned to **6.0.3**.
- Vitest is pinned to **4.1.11** (the plugin supports 4.1+ and 5; 4.x is the more mature line).

## Day 2 additions (12 Oct 2026)

| Fact                                                                                                | Status                                                                                                   | Evidence                             |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Better Auth scrypt inside workerd: **80–110 ms per hash** (wall clock across the DO RPC, 5 samples) | **Measured locally**                                                                                     | matches the 91 ms native measurement |
| Full register → sign-in → /me → sign-out cycle via `PasswordHasherDO`                               | **Passed locally** (`scripts/auth-gate.mjs`, 3 runs: sign-up p50 136 ms, sign-in p50 127 ms, 0 failures) | `wrangler dev`                       |
| Same gate, 20 runs on the deployed Free plan                                                        | **PENDING** (you run `node scripts/deploy.mjs`; my environments cannot reach api.cloudflare.com)         |                                      |
| Better Auth migrations match what the library expects                                               | **Verified** by a drift test (`test/auth-schema.test.ts`)                                                |                                      |

**Bug found: Better Auth instance initialised across requests.** A request that created an auth instance
but returned early (validation failure) left `auth.$context` initialising in a finished request; the next
request awaited that cross-request promise and hung forever (Workers forbids resuming another request's
I/O). Fix: `getAuth()` always awaits `auth.$context` inside the current request. Reproduced and pinned
by `test/auth.test.ts` (short/common password → duplicate sign-up sequence).
