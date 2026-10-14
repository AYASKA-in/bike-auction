# Demo guide: launch, reset, 3-minute script, technical talking points

## Launch (local)

```bash
pnpm install
pnpm dev                                   # http://localhost:8787 (build + local D1 migrations + Worker)
pnpm --filter @bike/worker seed:local      # 2nd terminal: demo accounts + fictional catalogue
pnpm --filter @bike/worker demo:reset      # before each demo: fresh auctions, times relative to NOW
```

`demo:reset` only touches data the demo seed created (`created_by = 'seed'`):

- Its auctions are cancelled, so any open page shows "cancelled".
- Its listings, bikes and read-model rows are removed.
- A fresh set is created.

Real accounts, real listings and their bids are never touched, and the reset never edits the database by hand. It
calls an operator endpoint protected by the `SEED_TOKEN` secret (`POST /api/v1/internal/demo/reset`).

Use two browser windows (one private) for the two buyers. Phone layout: the browser's device toolbar at 390 px.

## Demo accounts (local and evaluation deployments only)

These passwords are public, so they exist only where demo mode is on: local `wrangler dev`, or a deploy run with
`--demo`. In demo mode the sign-in page shows one-click buttons for them.

| Role    | Email                    | Password          |
| ------- | ------------------------ | ----------------- |
| Admin   | admin@bikeauction.demo   | Demo-Admin-2026!  |
| Buyer A | buyer.a@bikeauction.demo | Demo-BuyerA-2026! |
| Buyer B | buyer.b@bikeauction.demo | Demo-BuyerB-2026! |

## What a fresh demo contains

Eight fictional, clearly labelled listings, with all times relative to when you run the reset:

| Bike                      | State after reset                                     | Use it to show                       |
| ------------------------- | ----------------------------------------------------- | ------------------------------------ |
| Royal Enfield Classic 350 | **Live, ends in 30 min**, hidden reserve ₹1,40,000    | ending soon, reserve met / not met   |
| Honda Activa 6G           | Live, 5 h, no reserve, has bids                       | manual bidding and **proxy bidding** |
| Bajaj Pulsar NS200        | Live, 26 h, repossessed, active loan (NOC on payment) | paperwork transparency               |
| TVS Jupiter               | **Starts in 15 min**                                  | starting soon, auto-start            |
| Hero Splendor Plus        | Starts in 24 h                                        | upcoming                             |
| Suzuki Access 125         | **Ended: SOLD**, winner pseudonym shown               | completed auction with a winner      |
| TVS Apache RTR 160 4V     | Ended: **reserve not met**                            | reserve outcome                      |
| Yamaha FZ-S               | Draft                                                 | admin draft → schedule               |

## Three-minute script

**0:00 Intro (20 s).** "This is a real-time auction platform for inspected and bank-repossessed two-wheelers. It
runs entirely on Cloudflare's free tier. Each auction has its own small server, so bids are processed one at a
time, in order, and they're always correct."

**0:20 Catalogue (25 s).** Open `/`, then `/auctions`.

- Filter by make or engine-size band and sort by ending soon.
- Open a card and point out the inspection grade, RC/loan status, the "repossessed" label and the countdown in IST.
- Toggle dark mode.

**0:45 Admin creates an auction (35 s).** As admin, go to Auction desk → Add motorcycle:

1. Fill the form and save, then add the inspection.
2. Under Create auction, start now and close in 3 minutes with anti-sniping on. It's created as a **draft**.
3. Click **Schedule**. It goes live.

**1:20 Two buyers (40 s).**

- Buyer A (window 1) and Buyer B (window 2) both open the auction.
- A bids the minimum. B's price updates instantly, with no refresh.
- B uses the +2 quick-bid button. A gets the orange **"You've been outbid"** banner, a tab-title flash, and a one-tap
  rebid.
- Point at the bid history: buyers appear only as pseudonyms like "Bidder 7K2Q".

**2:00 Proxy bidding (25 s).**

- A opens **Auto-bid** and sets a maximum, for example ₹20,000 above the price.
- B bids again, and A's maximum answers automatically in the same instant. A stays "You're leading".
- B never sees A's maximum.

**2:25 Anti-sniping and the result (20 s).**

- In the last 2 minutes, a bid shows the **"+2:00 extended"** chip, and both windows get the new closing time.
- At the close, the server declares the result: A sees "You won at ₹…", B sees "Sold to Bidder …".
- My Bids moves the auction to Won and Lost.

**2:45 Operations (15 s).**

- As admin, open **Live ops**: health, viewers, sync lag and outbox backlog.
- Open the auction's admin page to show the **ledger**, with manual and automatic bids and no maximums shown.
- Open the **Audit trail**.

Optional extras: go offline in DevTools to see the "Offline" banner, the price marked "may be outdated" and bidding
paused, then reconnect to catch up. Show Watchlist, the phone layout, and `/account` → Download my data.

### Optional: after the win (1 minute)

1. As the winner, open **Purchases** (the badge shows what needs action). The card says "Pay ₹X by …" with a
   countdown, the price breakdown (fee 2% + GST 18% on the fee) and where to pay.
2. Report a payment with any 12-character UTR, for example `UTR123456789`.
3. As the admin, open **Auction desk → Settlements**, open the sale and click **Verify**. The buyer's card
   moves to "Pay the balance".
4. Record the balance as the admin. The buyer now sees a gate-pass code; **Mark collected** needs that code.

Rules and edge cases (default, runner-up offer, deposits): [`settlement.md`](settlement.md).

## Technical talking points (for interview questions)

**Why this architecture?**

- An auction is a tiny, extremely contended piece of state: many people race to change one number.
- A Cloudflare Durable Object gives each auction a single-threaded owner with its own SQLite database, running close
  to its users.
- That turns a distributed-locking problem into ordinary sequential code.
- D1 (SQLite at the edge) serves everything that's read-mostly: the catalogue, My Bids and the admin desk.
- All of it fits Cloudflare's free tier.

**How do concurrent bids stay correct?**

- Every bid for auction X goes to object X, which handles one command at a time.
- Inside one synchronous SQLite transaction, with no `await` in between, it:
  1. checks the rules with pure functions (status, deadline, increment ladder, fat-finger limit, reserve, proxy
     resolution);
  2. writes the new state, the ledger row, the idempotency record and the outbox event;
  3. guards that the sequence number is contiguous.
- Measured result: 50 simultaneous equal bids → exactly one accepted; 100 simultaneous mixed bids → strictly
  increasing prices with no duplicates (`docs/reliability.md`).

**How are duplicate requests handled?**

- Every bid carries an `Idempotency-Key` (16–128 chars), scoped per user and stored for 24 h with the result,
  rejections included.
- A retry returns the stored answer marked `Idempotent-Replayed: true`; a reused key with a different amount is
  rejected.
- The UI keeps the same key only for "uncertain" failures (timeouts, network, 5xx) and never retries automatically.

**How are D1 failures recovered?**

- D1 is never consulted to decide a bid.
- Events go to an outbox in the same transaction, and an alarm drains it into D1 in atomic batches.
- If D1 fails, bidding continues; the drain retries with exponential backoff, and `/admin/ops` shows the lag.
- Projections are monotonic (newer sequence numbers only), so a late retry can never overwrite newer data.

**How is buyer privacy protected?**

- Bidders are per-auction pseudonyms (an HMAC of the user and auction). No identity crosses to other buyers.
- Hidden reserves and proxy maximums never leave the auction object except to their owner. No events, history, D1
  rows, logs or metrics contain them, and tests serialise every message to check.
- Account deletion is all-or-nothing:
  - It is refused while the user leads, holds an active maximum, or recently won.
  - Otherwise the user is retired in every open auction, then their personal data is erased.
  - The pseudonymous ledgers are kept, so other bidders' results stay verifiable.

**What I learned**

- Put the authority in one place, and make everything else a projection that can be rebuilt.
- Test the scary paths for real: two browsers, a killed server, the network cut, 100 simultaneous requests.
- An independent review found a deletion race that every test I had written missed. Review changes what you test.
- A fake clock in the browser is a bug waiting to happen. Only the server decides when an auction ends.

## Feature summary (for a submission form)

A real-time motorcycle auction platform for India, built on Cloudflare Workers, Durable Objects, D1 and R2 (free
tier).

- **Live bidding:** each auction is processed by its own Durable Object, so concurrent bids are correct by
  construction. The page updates live over WebSockets, with reconnection and resync.
- **Proxy bidding:** eBay-style automatic bids with private maximums.
- **Anti-sniping:** late bids extend the deadline, up to a hard cap.
- **Hidden reserves.**
- **Buyer features:** My Bids, Watchlist, and account export and deletion (India DPDP-aware).
- **Admin features:** listing management with inspection reports, a live operations dashboard, a bid ledger and an
  audit trail.
- **Quality:** 563 automated tests, including property-based tests of the auction rules, plus browser tests with
  two buyers and a server restart, a 100-request concurrency test, and an accessibility scan.
- **Security:** strict CSP, CSRF and WebSocket origin checks, layered rate limits, Turnstile, and redacted structured
  logs.
