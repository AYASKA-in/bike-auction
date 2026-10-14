# Settlement: paying for a won auction

What happens after the hammer falls. Rules are pure functions in `packages/domain/src/settlement.ts`;
storage and workflow live in D1 (`apps/worker/src/settlement/service.ts`, migration `0007_settlement.sql`).

## The rule

| Step                | Deadline                                               | Amount                                                      |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| 1. Secure the bike  | 24 hours after the auction closes                      | 25% of the winning bid (rounded up), minus any deposit held |
| 2. Pay the balance  | 23:59 IST on day 15 after the close                    | The rest of the price + buyer fee 2% + GST 18% on the fee   |
| 3. Collect the bike | Within 7 days of paying in full, with a gate-pass code | —                                                           |

**Worked example:** a ₹1,25,000 winning bid with a ₹15,000 deposit:

- 25% is ₹31,250, so ₹16,250 is due within 24 hours.
- The fee is ₹2,500 and GST on it is ₹450, so the total is ₹1,27,950.
- The balance is ₹96,700.

### Missing a deadline (default)

A stage defaults only once its deadline has passed **and** no payment reported before the deadline is
still waiting for verification, so a buyer who paid on time is never defaulted by a slow admin. When a
sale defaults:

- the participation deposit is **forfeited**;
- payments that were verified are recorded as **refund due** (only the deposit is kept);
- the bidder's account is **suspended** from bidding until an admin reinstates it;
- the admin chooses the next step: **offer to the runner-up** or **relist**.

## Buyer side (`/me/purchases`, `/me/deposit`)

- **My purchases:** a card per won auction, with the next amount and deadline, a countdown, and a
  progress line (Pay 25% → Pay the balance → Collect). The price breakdown is shown with the payments.
- **Paying:** pay by UPI or bank transfer to the details configured below, then report the amount and
  its UTR (transaction reference). Limits:
  - at most 5 reports can be waiting at once;
  - you can't report more than you owe;
  - a reference can be used only once.
- **While a payment is owed**, bidding on other auctions is refused (`BLOCK_BIDDING_WHILE_OWING`).
- **Runner-up offers:** the buyer is offered the bike at their own highest bid, with 24 hours to accept or
  decline. On acceptance the 24 h / 15-day clock starts from that moment.
- **Gate pass:** once paid in full the buyer sees a code to show at the yard.
- **Deposits:** report a ₹5,000, ₹10,000 or ₹25,000 transfer; once an admin verifies it:
  - it counts toward the 25% when you win;
  - your buying limit is 10× the deposit held, enforced on bids and proxy maximums;
  - you can ask for it back unless you owe a payment or have bids on a running auction.
  - Deposits are optional unless `REQUIRE_DEPOSIT=true`.
- **Account deletion** is refused while a settlement is open, a refund is due, or a deposit is held. The
  data export includes purchases and deposits.

## Admin side (`/admin/settlements`, `/admin/deposits`)

- **Queue** with filters: Open, Awaiting verification, Due within 24 h, Paid, Closed, All.
- **Detail page** shows the money (price, fee + GST, deposit counted, verified paid, due now, both
  deadlines), the payments, and a timeline from the audit log.
- **Actions:**
  - **Verify or reject** a reported payment. An admin can't verify a payment they recorded themselves.
  - **Record a payment** (cash at the yard, a cheque). Above ₹50,000 a second admin must verify it
    (dual control).
  - **Extend** the current deadline once, by up to 72 hours, with a reason.
  - **Cancel the sale:** verified payments become refund due and the deposit is released.
  - **Offer to the runner-up** (with a preview of the terms) or **relist**, after a default. The
    runner-up must have bid at least the reserve, and must not be suspended or have bought before.
  - **Mark refunded.**
  - **Mark collected**, which requires the buyer's gate-pass code.
- **Deposits:** verify, reject, and mark refunded. Suspended bidders can be **reinstated** with a reason.
- Every action is written to the audit log.

## How it runs

- `sweep()` opens settlements for newly sold auctions, expires runner-up offers, and defaults overdue
  sales. It runs from the `*/5 * * * *` cron and lazily on the buyer and admin settlement routes, so
  pages are current even between cron runs.
- **Only auctions that close after migration 0007 is applied get a settlement.** The migration records
  that moment in `settlement_config.opens_from`, so sales from before the rule existed are never opened,
  defaulted or held against a bidder.
- Every state change is a guarded `UPDATE … WHERE status = ?`, so a cron run and a request racing each
  other cannot apply the same change twice. Settlement ids are deterministic (`stl_<auction>_<attempt>`).

## Configuration (`wrangler.jsonc` vars)

| Var                         | Default | Meaning                                                               |
| --------------------------- | ------- | --------------------------------------------------------------------- |
| `REQUIRE_DEPOSIT`           | `false` | `true` = no bidding without a verified deposit                        |
| `BLOCK_BIDDING_WHILE_OWING` | `true`  | Refuse bids while the bidder owes a payment                           |
| `PAYMENT_UPI_ID`            | empty   | UPI ID shown to buyers. Empty means "Our team will share the details" |
| `PAYMENT_BANK_DETAILS`      | empty   | Bank account text shown to buyers (account name, number, IFSC)        |

No money moves through the site. Payments are bank or UPI transfers that admins match by reference.
Payment-gateway integration is a later phase.

## Tests

- Domain rules and properties: `packages/domain/src/settlement.test.ts`.
- Worker flows: `apps/worker/test/settlement.test.ts` (opening, privacy, blocking, happy path, defaults,
  runner-up, relist, deposits and the buying limit, extension, dual control, cancel, legacy sales).
- Browser journey: `tests/e2e/settlement.py` (buyer + admin in Chromium, desktop and mobile/dark).
