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

## Invariants (BLUEPRINT §4.8): coverage so far

- **B** accepted bid ≥ minimum: tested · **D** leader = top of ledger: tested · **E** seq gap-free: tested
- **A** no bid at/after close: tested (lazy close) · **I** price never decreases: tested
- **C, F, G, H, J**: Day 3–4 (domain engine, idempotency, auth); J partially (projection convergence tested)
