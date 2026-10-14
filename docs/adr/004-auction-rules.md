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
3. bidder is not already leading (ALREADY_LEADING; see Proxy bidding); 6. ≥ minimum (BID_TOO_LOW, with
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

## Proxy bidding (Day 7, BLUEPRINT §4.7)

A buyer may set one hidden **maximum** per auction (`setMaxBid {userId, maxMinor}`; `PUT /auctions/:id/max-bid`).
The engine then bids for them, eBay-style, inside the same pure command. Implemented in `engine.ts`
(`setMaxBid`, `resolveProxies`), property-tested against an independent closed-form model in
`test/proxy.property.test.ts`.

- **Priority.** Maxima rank by amount, then by `setSeq` (the auction seq once the command that set that amount
  committed): on equal maxima the **earlier** one wins. Competing maxima never share a `setSeq` (only the leader can
  commit a maximum without a bid, and every other maximum that can compete was set in a command that bid);
  `userId` is a last deterministic tie-break only.
- **Resolution.** After every bid or maximum the engine resolves until stable (no other maximum can meet the
  minimum next bid or beat the leader's commitment L = max(price, leader's maximum)). The best challenger C either
  wins at `min(C, max(minNext, L + inc(L)))` or loses and the leader moves to `min(L, max(minNext, C + inc(C)))`
  (increment at the _second_ amount). So the price is `min(highest, second + increment(second))`, never above the
  winner's maximum and never below the minimum next bid at the start of the command. At most two automatic bids per
  command: the loser's maximum when it is a real step below the final price (this reveals it, as on eBay) and the
  winner's price. Each is a normal ledger row and `bid.accepted` with `kind: "PROXY"` (manual: `"MANUAL"`).
  A step may be less than one increment above the previous bid only when capped at the winner's maximum or lifted to
  the reserve.
- **Manual bids** keep every check above (incl. `ALREADY_LEADING`: the leader cannot outbid themselves by hand). A
  manual bid below another's maximum is recorded, then answered in the same commit. A manual bid **equal** to an
  earlier maximum cannot be recorded and matched (the ledger is strictly increasing), so the maximum takes that amount
  and the bid is rejected `BID_TOO_LOW` with the new minimum; the automatic bid is still committed.
- **Raise / lower.** Setting a maximum replaces yours. Checks: LIVE, valid amount, ≤ ceiling, **≥ minimum next bid**
  (`BID_TOO_LOW`), ≤ fat-finger limit. The leader may raise (no public bid, no price change) or lower, but never below
  the minimum next bid, so a maximum never drops below current exposure (the price). Re-sending your current maximum
  is a no-op that keeps priority. There is no delete. No new error code was needed.
- **Fat-finger.** The 3× rule applies to maxima too (`max ≤ max(minNext, 3 × reference)`, `BID_UNREASONABLE` with
  `maxAcceptableMinor`): a mistyped maximum is silent until it bites, so it gets the same guard. Users can raise it
  as the price rises.
- **Reserve.** If the winning maximum is ≥ the hidden reserve and the computed price is below it, the price jumps to
  exactly the reserve (also when the leader raises their maximum past it). `reserveMet` is computed from the
  resulting price as before; a maximum below the reserve never reveals it.
- **Soft close.** At most one extension per command, emitted after all of its bids, if any bid (manual or automatic)
  was accepted inside the window. All steps share `now`, so per-step extensions would give the same close. A
  leader's raise places no bid and never extends.
- **Privacy.** A maximum is stored only in the DO table `proxy_bids` (stripped from `state_json`), never in events,
  public views, history, the D1 projection, admin details or logs. Only `viewer.myMaxMinor` in the owner's own view
  (HTTP or a personal WS snapshot) carries it. Idempotency fingerprint: `max:v1:<auctionId>:<max>`; bid and maximum
  commands share the (user, key) space and the persistent throttle.

## Bidder pseudonyms

`Bidder ` + Crockford base32 of `HMAC-SHA256(secret, "pseudonym:v1:<auctionId>:<userId>")`, 4 chars, growing to
6/8/… on collision with a different bidder in the same auction. Stable per auction, unlinkable across auctions;
secret from the runtime (≥ 32 chars); HMAC injected as a port (Web Crypto adapter in the Worker).

## Consequences

The engine is verified by 120 domain tests, including model-based property tests against an independent reference
model (see docs/architecture.md › Testing). The DO still runs the Day-1 minimal engine until Day 4.
