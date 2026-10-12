# ADR 004: Auction rules engine

**Status:** accepted (Day 3). Implemented in `packages/domain/src/auction/`. Durable Object integration is Day 4.

## Context

Bid validity, ordering, reserve outcomes and soft close must be provably correct and independent of Cloudflare,
so they can be reviewed and tested in isolation and survive a platform change.

## Decision: a pure, event-emitting engine

Every command is a pure function `(state, command, now) → { ok, state, events, error? }`. No clock, no I/O, no
hidden state; `now` and `userId` are supplied by the trusted server. Business rejections are values; only
programming errors (non-integer `now`, missing identity) throw `DomainInvariantError`.

**Rejected commands can still return lifecycle events.** A late bid that discovers the auction has closed returns
`auction.ended` with the rejection; the caller must commit it. This is how correctness never depends on alarms.

## State machine

```
DRAFT ──schedule──▶ SCHEDULED ──(now ≥ startsAt)──▶ LIVE ──(now ≥ closesAt)──▶ ENDED{SOLD|RESERVE_NOT_MET|NO_BIDS}
  │                     │                              │
  └──────────────── cancel(reason, 3–500 chars) ───────┴──────────────▶ CANCELLED
```

ENDED and CANCELLED are terminal. `tick(state, now)` resolves due transitions; it is idempotent and handles any
delay (an auction first observed after its close goes SCHEDULED → LIVE → ENDED in one call, with
`startedAt = startsAt` and `endedAt = closesAt`, not the observation time). Terms (price, reserve, times, rules)
are editable only in DRAFT/SCHEDULED, evaluated after resolving time.

## Money and increments

Integer paise; amounts must be positive safe integers ≤ ₹1 crore (`MAX_AMOUNT_MINOR`); `safeAdd`/`safeMultiply`
refuse to leave the safe-integer range. Increment by the **current** price:

| Current price                           | Increment |
| --------------------------------------- | --------- |
| < ₹25,000.00                            | ₹250      |
| ₹25,000.00 – ₹99,999.99                 | ₹500      |
| ₹1,00,000.00 – ₹3,00,000.00 (inclusive) | ₹1,000    |
| > ₹3,00,000.00                          | ₹2,500    |

_Correction:_ Day 1 charged ₹2,500 at exactly ₹3,00,000; the blueprint says "through ₹3,00,000". The Day-1 test
assertion was updated deliberately. Before the first bid, the minimum is exactly the start price.

## Bid acceptance (checks in this order)

1. resolve time; 2. status LIVE (else AUCTION_CANCELLED / AUCTION_ENDED / AUCTION_NOT_LIVE);
2. positive safe integer (BID_INVALID_AMOUNT); 4. ≤ per-auction ceiling (BID_UNREASONABLE);
3. bidder is not already leading (ALREADY_LEADING; proxy bidding is P1); 6. ≥ minimum (BID_TOO_LOW, with
   `minNextBidMinor`); 7. ≤ max(minimum, 3 × reference) where reference = current ?? start (BID_UNREASONABLE, with
   `maxAcceptableMinor`). Every accepted bid is strictly higher than the previous, so the highest bid is unique and
   the winner is the leader at close: deterministic, no tie-breaks needed. The UI's ">20% over minimum" confirmation
   is presentation and lives in the web app.

## Hidden reserve

Optional, ≥ start price, editable before LIVE. Outcome at close: no bids → NO_BIDS; top < reserve →
RESERVE_NOT_MET; else SOLD (winner = leader). Buyers only see `hasReserve` and `reserveMet`. Public DTOs are built
by allow-list (`toPublicView`, `toPublicEvent`) and validated by strict Zod schemas in `@bike/contracts`, where any
extra key fails parsing.

## Soft close

Defaults: window 2 min, extension 2 min, total cap 30 min. A bid accepted with `closesAt − now < window` (exactly
2:00 remaining does **not** extend) sets `closesAt = min(now + extension, hardCloseAt)`; an extension event is
emitted only if that moves the close. `hardCloseAt = originalClosesAt + cap` is derived, never supplied, and
`closesAt ≤ hardCloseAt` always holds, so every auction terminates.

## Events and ordering

`auction.created/updated/scheduled/started`, `bid.accepted`, `auction.extended/cancelled/ended`. Each event's
`seq` is previous + 1 within the auction, in emission order (bid before its extension; start before end). The
leading bid's ledger sequence is its `bid.accepted` seq. `created`/`updated` are admin-only (they carry the
reserve) and have no public form. Events are broadcast only after the DO commits them (Day 4 wiring).

## Idempotency

Scope (userId, key); key `[A-Za-z0-9_-]{16,128}`; fingerprint `bid:v1:<auctionId>:<amount>` (excludes
server-assigned bidId and time). Same key + same fingerprint → original stored result (accepted _or_ rejected),
no new effects; different fingerprint → IDEMPOTENCY_KEY_REUSED; retention ≥ 24 h, then the record is treated as
absent. Only deterministic domain outcomes are stored, never infrastructure failures. Storage is the DO's SQLite,
written in the same transaction as the bid (Day 4). The test harness's in-memory map is explicitly not durable.

## Bidder pseudonyms

`Bidder ` + Crockford base32 of `HMAC-SHA256(secret, "pseudonym:v1:<auctionId>:<userId>")`, 4 chars, growing to
6/8/… on collision with a different bidder in the same auction. Stable per auction, unlinkable across auctions;
secret from the runtime (≥ 32 chars); HMAC injected as a port (Web Crypto adapter in the Worker).

## Consequences

The engine is verified by 120 domain tests, including model-based property tests against an independent reference
model (see docs/architecture.md › Testing). The DO still runs the Day-1 minimal engine until Day 4.
