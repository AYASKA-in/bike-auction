# Reliability and performance (Day 9, measured locally)

All numbers below were **measured on 14 Oct 2026** against the local app (`wrangler dev`, workerd, local D1 and
Durable Objects) on a 2-core, 7 GB cloud VM. They are **not production numbers**: real Cloudflare adds network
latency but runs each auction object on its own isolate. Raw output: [`load-test-results.json`](load-test-results.json).
Re-run: `node tests/load/concurrency.mjs http://127.0.0.1:8800 out.json` (see README → Testing).

## Concurrency and correctness (`tests/load/concurrency.mjs`)

20 buyers (2 demo + 18 registered through the real sign-up API, consent included). Every check reads the
authoritative state (admin ledger + the auction object's view), not what clients assumed.

| Scenario           | Load                                                    | Result                                                                                                     |
| ------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A. Same amount     | 50 simultaneous bids at the minimum                     | **exactly 1 accepted**; 47 `BID_TOO_LOW`, the rest `ALREADY_LEADING` (the winner's own extra requests)     |
| B. Mixed amounts   | 100 simultaneous bids, ₹50,000–₹79,500                  | 7 accepted; every 201 = one ledger row; prices strictly increase; no duplicates                            |
| C1. Equal maxima   | two ₹80,000 maxima                                      | the **earlier** one leads at exactly ₹80,000                                                               |
| C2. Proxy + manual | 8 maxima (₹60k–₹67k) + 10 manual bids, all simultaneous | ₹67k max leads at **₹66,500** (second max + increment); 15 ledger rows; no automatic bid above any maximum |
| D. Many auctions   | 5 auctions × 20 simultaneous bids (100 at once)         | each auction internally consistent (8/7/2/5/4 accepted); no cross-talk                                     |
| E. Duplicates      | one Idempotency-Key sent 10× concurrently               | **one bid**; 10 × 201 with the same bidId, 9 marked `Idempotent-Replayed`                                  |
| F. Deadline race   | 80 bids fired across the close (soft close off)         | 31 accepted, **0 at/after the close**; server ended it SOLD to the highest bidder                          |
| G. Soft close      | 6 rounds of late bids (soft close on)                   | deadline extended on late bids; every `closesAt` ≤ original + 30 min (hard cap)                            |

Invariants checked after every scenario: ledger prices strictly increase, unique seq and bidId (no duplicated
effects), the public view equals the ledger (count and price), no automatic bid above its owner's maximum.
**All passed (0 failures).**

## Failure recovery (automated tests that run in `pnpm check`)

| Failure                           | Proven by                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable Object restart (eviction) | `auction-do.test.ts` "state, ledger and idempotency survive eviction"; `proxy.test.ts` "eviction/restart keeps maxima"; `throttle.test.ts` "the limit survives a restart"                                     |
| Lost timers after a crash         | `auction-do.test.ts` "restores lost timers after a restart"; `regressions-day3.test.ts` "restores the outbox timer on restart"                                                                                |
| D1 outage and recovery            | `auction-do.test.ts` "bidding keeps working while D1 is down; failures are tracked; it converges after recovery"                                                                                              |
| Stale/duplicate projection        | `auction-do.test.ts` "an older projection can never overwrite a newer one", "replays are no-ops"                                                                                                              |
| Delayed alarm                     | `auction-do.test.ts` "late bids are rejected even if the close alarm has not run (lazy close)"                                                                                                                |
| Duplicate alarm execution         | `auction-do.test.ts` "closes … via the alarm … emits exactly one ended event"; one alarm multiplexes all timers                                                                                               |
| API timeout during a bid          | `api-bids.test.ts` "network failure after the bid is saved: retrying the same key returns the original result"; client: `bid-intent.test.ts` (same key only for uncertain failures, never an automatic retry) |
| Retry with the same key           | `auction-do.test.ts` "rejections are replayed too"; scenario E above                                                                                                                                          |
| WebSocket disconnect / refresh    | `live-feed.test.ts` (back-off, offline/online, heartbeat, gap → resync); `tests/e2e/live.py` (offline → recovery, refresh)                                                                                    |
| Server restart mid-auction        | `live-day6.test.ts` "after a server restart … contiguous seqs"; `tests/e2e/live.py` kills and restarts `wrangler dev`, both buyers recover                                                                    |

## Latency (local, ms)

Final run, 14 Oct 2026 06:30 UTC (an earlier run the same day gave sequential-bid p50 50 ms / p95 64 ms; both
are real, the spread is normal VM noise).

| Measure                                                    | n   | p50      | p95       | max   |
| ---------------------------------------------------------- | --- | -------- | --------- | ----- |
| Bid round trip, one at a time                              | 30  | **58.7** | **77.4**  | 78.6  |
| WebSocket delivery (bid sent → event at another client)    | 30  | **46.5** | **65.3**  | 65.4  |
| D1 projection delay (bid sent → catalogue shows the price) | 10  | **69.2** | **107.8** | 107.8 |
| `GET /auctions` (catalogue, D1)                            | 40  | 13.9     | 20.7      | 23.5  |
| `GET /auctions/:id/details` (D1)                           | 40  | 16.2     | 26.9      | 28.5  |
| `GET /auctions/:id` (live view, Durable Object)            | 40  | 26.3     | 37.1      | 38.1  |
| Bid round trip inside 50–100-request bursts                | 390 | 1,209    | 2,713     | 2,766 |

The burst figure is queueing: 100 requests at once on one local workerd process with 2 CPU cores, each also
resolving a session in D1, while one auction object processes them **serially by design** (that serialisation is
what makes the result correct). In production each auction object runs on its own and sessions resolve at the edge,
so per-bid processing time (the sequential row) is the representative number. No change was made: it is not a
defect, and optimising it locally would not reflect production.

## Frontend

| Measure                       | Value                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| First load `/`, local, 5 runs | DOMContentLoaded 318–464 ms; first contentful paint 520–868 ms                                                     |
| JavaScript transferred on `/` | 169 KB (compressed)                                                                                                |
| Largest chunks (raw / gzip)   | `index` 269 KB / 83 KB; shared vendor 237 KB / 74 KB; every page except home is lazy-loaded (auction detail 43 KB) |
| Day 5 baseline                | one 577 KB chunk (178 KB gzip)                                                                                     |
