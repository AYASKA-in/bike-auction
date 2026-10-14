# Runbook

Operational guide for the bike auction platform. Commands run from `apps/worker/` with `npx wrangler …`.
Signals: `/admin/ops` (start here), `/admin/auctions/:id`, Workers Logs (JSON, `event` field), Analytics
Engine dataset `bike_auction_metrics` (schema in `docs/architecture.md` → Observability).

**First principle:** the auction Durable Object is the source of truth. D1 is a read model. A D1 problem
never stops bidding; it makes lists and "My bids" stale. Never "fix" an auction by editing D1 rows by hand.

## 0. Triage in two minutes

1. Open `/admin/ops`. Overall: **ok** / **degraded** (read the warnings list) / **down** (D1 unreachable).
2. `GET /api/v1/status` (public): `checks.d1.status`, `version`. `GET /api/v1/admin/ops/health` (admin):
   D1 latency, metrics binding, stale read-model rows.
3. Workers Logs: filter `level = "error"`, then by `requestId` (every response carries `X-Request-Id`; the
   user's error screen shows it) or `auctionId`.
4. Did it start with a deploy? Check `version` in log lines against `npx wrangler deployments list`.

## 1. Projection lag / D1 sync failing

Symptoms: warning `PROJECTION_LAGGING` (events pending > 5 s) or `PROJECTION_FAILING`; catalogue/My bids
prices behind the live page; `seq / projected` differs on `/admin/ops`.

Diagnose:

- `/admin/auctions/:id` → Operations: outbox backlog, oldest pending age, consecutive failures, last error.
- Logs: `event = "auction.projection.failed"` (`errorMessage`, `consecutiveFailures`); successes are
  `auction.projection.ok` with `lagMs`.
- AE: `SELECT blob4, SUM(_sample_interval) FROM bike_auction_metrics WHERE blob1 = 'projection_failure' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY blob4`.
- `GET /api/v1/status`: is D1 itself down (`checks.d1.status = "down"`)?

Recover:

- D1 down/quota exhausted: nothing to do for bidding. The outbox retries with backoff (1 s … 60 s) and
  converges by itself (writes are idempotent and monotonic by seq). Watch the backlog fall after recovery.
- After the cause is fixed, press **Retry projection** (audited `PROJECTION_RETRIED`) to drain immediately
  instead of waiting for the backoff. It returns the number still pending (0 = caught up).
- Persistent error with the same message (e.g. a schema mismatch after a migration): a code/migration bug.
  Roll back (section 6) or apply the missing migration (`npx wrangler d1 migrations apply DB --remote`).

## 2. Auction object (DO) errors, overdue deadlines, stuck alarms

Symptoms: `AUCTION_UNREACHABLE` (timeout / error / not_found), `DEADLINE_OVERDUE`, `TIMER_OVERDUE`,
`ALARM_FAILED`, `READ_MODEL_STALE`; 5xx on `/api/v1/auctions/:id/*`.

Diagnose:

- Logs: `auction.alarm_failed` (with `auctionId`), `http.request` with `status >= 500` and the route.
- `not_found` on `/admin/ops`: a read-model row exists but no object holds that id (a crashed create;
  such listings are released automatically after 2 min) or test data.
- `timeout`: object busy or the platform is degraded; check other auctions. One slow object never blocks
  the ops page (2 s budget per object, parallel).
- `DEADLINE_OVERDUE` / `TIMER_OVERDUE`: the alarm is late or failing. Closing does **not** depend on the
  alarm: every read/command lazily applies a due start/close, so a late alarm never accepts a late bid.

Recover:

- Opening `/admin/auctions/:id` (or any buyer view) triggers a lazy tick and commits the due transition.
- `READ_MODEL_STALE` without object warnings: projection stuck; **Retry projection** on that auction.
- Repeated `auction.alarm_failed` for one auction after a deploy: roll back (section 6).
- A truly wrong auction (bad terms) is cancelled with a reason from `/admin/auctions/:id` (audited,
  broadcast to bidders). There is no "uncancel".

## 3. WebSocket issues

Symptoms: users stuck on "Reconnecting…", live page not updating, viewers count near zero.

Diagnose:

- AE: abnormal closes (`double3 = 1`) by close code:
  `SELECT blob4, SUM(_sample_interval) FROM bike_auction_metrics WHERE blob1 = 'ws_disconnect' AND double3 = 1 AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY blob4`.
  1006 = dropped without a close frame (network/proxy/eviction), 1008 = client exceeded 30 messages/min,
  1011 = server error.
- `ws_connect` vs `ws_disconnect` rates; `ws_error`; `http.request` with route `/api/v1/auctions/:id/stream`
  and status 403 (Origin rejected: check `ALLOWED_ORIGINS`) or 404.
- Clients fall back to HTTP polling every 15 s while the socket is down and resync on reconnect, so
  correctness is preserved; only latency degrades.

Recover: config (`ALLOWED_ORIGINS`) or a bad deploy → fix/roll back. Many 1008 closes from one client =
a misbehaving client, already contained (socket closed).

## 4. Rate-limit spikes / abuse

Symptoms: many 429s; users report "Too many requests".

Diagnose:

- AE: `SELECT blob2, SUM(_sample_interval) FROM bike_auction_metrics WHERE blob1 = 'http_request' AND blob5 = '429' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY blob2`.
- Auth abuse: `blob1 = 'auth_security'` grouped by `blob4` (`INVALID_CREDENTIALS`, `RATE_LIMITED`,
  `CAPTCHA_FAILED`); details in `/admin` security events (D1 `security_events`, IPs stored as HMACs).
- Bid throttle: 429s on `POST /api/v1/auctions/:id/bids` come from the per-user per-auction limit
  (10 / 10 s) inside the object or the edge limit `BID_RATE_LIMIT` (30 / 10 s); auth uses
  `AUTH_RATE_LIMIT` (20 / min). Edge limits are per key and per location (approximate).

Recover: limits are deliberately conservative and self-healing (windows ≤ 60 s). For a sustained attack,
add a WAF rate-limiting rule in the Cloudflare dashboard; keep Turnstile on sign-up/sign-in.

## 5. Useful AE queries

p95 in-object bid processing latency (last hour):
`SELECT quantileWeighted(0.95)(double1, _sample_interval) FROM bike_auction_metrics WHERE blob1 IN ('bid_accepted','bid_rejected') AND timestamp > NOW() - INTERVAL '1' HOUR`

5xx rate by route: `… WHERE blob1 = 'http_request' AND blob3 = '5xx' GROUP BY blob2`.
Close delay (ended commit after `closesAt`): `… WHERE blob1 = 'auction_lifecycle' AND startsWith(blob4, 'ended')`.

Run with `curl https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql -H "Authorization: Bearer <API_TOKEN>" -d "<SQL>"` (token with _Account Analytics: Read_).

## 6. Roll back a bad deploy

1. `npx wrangler deployments list` — find the last good version (its `version` matches log lines).
2. `npx wrangler rollback` (previous version) or `npx wrangler rollback <VERSION_ID>`; add a message with
   `--message "reason"`.
3. Verify: `GET /api/v1/status` shows the old `version`; `/admin/ops` overall returns to ok.
4. Caveats: rollback restores **code only**. D1 migrations are not reverted (write forward-compatible
   migrations); Durable Object storage is not reverted (the auction schema is migrated additively in the
   object constructor, so older code must tolerate newer columns). Secrets/bindings are not reverted.
5. Data restore (last resort): D1 Time Travel, `npx wrangler d1 time-travel restore bike-auction --timestamp <ISO>`
   (7 days on the free plan). Auction objects then re-project their state on the next drain/Retry.

## 7. Free-tier limits to watch (Workers Free)

| Resource         | Daily limit (resets 00:00 UTC = 05:30 IST)                    | Where it shows                         |
| ---------------- | ------------------------------------------------------------- | -------------------------------------- |
| Worker requests  | 100,000                                                       | Dashboard → Workers → Metrics          |
| Durable Objects  | 100,000 requests (incl. WS messages/alarms), 13,000 GB-s      | Dashboard → Durable Objects            |
| D1               | 5 M rows read, 100,000 rows written, 5 GB storage             | Dashboard → D1 → Metrics               |
| Analytics Engine | 100,000 data points written, 10,000 read queries (not billed) | ≥ 1 point per request: tracks requests |
| Workers Logs     | per Cloudflare Observability pricing (changes 1 Dec 2026)     | Dashboard → Observability              |

Exhausting D1 writes stalls projections (section 1) but not bidding. Exhausting Worker or DO requests
stops the service until the reset: run load tests only against staging/local, never production.
Verify the current numbers on Cloudflare's pricing pages before relying on them.
