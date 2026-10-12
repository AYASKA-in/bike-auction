# Data design

## Per-auction Durable Object SQLite (authoritative), schema v3

| Table           | Purpose                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `auction_state` | one row: domain `AuctionState` JSON + `seq`                                             |
| `events`        | committed event log, contiguous `seq`; `projected_at IS NULL` = outbox                  |
| `bids`          | accepted-bid ledger (seq PK, bid_id UNIQUE) for history pagination                      |
| `idempotency`   | (user_id, key) PK, fingerprint, stored result, created_at; GC after 24 h                |
| `pseudonyms`    | user_id PK, code UNIQUE (collision rule enforced by storage)                            |
| `timers`        | lifecycle / outbox / idem-gc deadlines multiplexed onto the single alarm                |
| `sync_status`   | last attempt/success, consecutive failures, last error                                  |
| `bid_attempts`  | v3: per-user bid attempts for the 10 / 10 s sliding-window throttle (survives eviction) |

Every bid/lifecycle/admin command commits state + events + ledger + idempotency + pseudonym + timers in **one**
`transactionSync`; a non-contiguous seq aborts the transaction. Schema v1 (Day 1) tables were dropped in v2:
pre-release, never deployed.

## D1 (global; read models + accounts)

`0001` auctions_rm, audit_log · `0002` Better Auth tables, login_throttle, security_events ·
`0003` auctions_rm summary columns, `auction_bids_rm` (PK auction_id+seq, pseudonymous), `user_bids_rm`
(PK user_id+auction_id, guarded by last_bid_seq) · `0004` catalogue: `bikes` (CHECKs on years, cc, km, owners,
enums; NOCASE indexes on make/city), `bike_inspections` (PK bike_id+version, history kept), `bike_images`
(content_type CHECK, width/height, position 0 = cover; bytes live in private R2 under `bikes/<bikeId>/<uuid>`),
`auction_listings` (auction ↔ bike, title, terms; **partial UNIQUE index on bike_id WHERE active = 1** = no two
open auctions per bike; the projection sets `active = 0` when the auction ends or is cancelled), plus a
status/price index on `auctions_rm` for catalogue sorts. Catalogue pages use keyset pagination. Projection = one atomic `DB.batch`; summary rows accept only a
newer `projection_seq`; bid rows are `INSERT OR IGNORE`. D1 is never read to decide a bid.
