# ADR 001: One SQLite-backed Durable Object per auction

**Context.** Bids for one auction need a single total order and atomic validation; different auctions are independent.
**Decision.** Each auction is a Durable Object addressed by `idFromName(auctionId)`, holding its state, bid ledger,
outbox and deadlines in its own SQLite database. Commands arrive via RPC; the critical section is synchronous.
**Alternatives.** Postgres row locks + Redis pub/sub (more infrastructure, no free always-on hosting); Firestore
transactions (optimistic retries under contention); Convex (hides the concurrency we are asked to demonstrate).
**Consequences.** Correct ordering is proven by tests (spike-results.md §B). Cloudflare coupling is contained:
business rules live in `@bike/domain` with zero platform imports. A single hot auction is bounded by one object.
