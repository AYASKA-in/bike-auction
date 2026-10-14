# Privacy, data flows and retention (Day 8)

> **Not legal advice.** This document describes what the software does and how it was designed with India's
> Digital Personal Data Protection Act, 2023 (DPDP Act) and the DPDP Rules, 2025 in mind. Building these features
> does **not** make a deployment compliant. Section 9 lists what a lawyer and the operator still have to decide.
> Our reading of the law is summarised conservatively and must be checked against the official texts.

Related: [threat-model.md](threat-model.md) (security review, rate limits, checklist), `BLUEPRINT.md` §8.

## 1. Roles and context

- **Data Fiduciary:** whoever operates a deployment (for this internship build: the developer running the demo).
  The operator's name and contact must be filled into the Privacy Notice before real users are invited (§9).
- **Data Principals:** registered buyers and administrators.
- **Data Processor:** Cloudflare (Workers, D1, Durable Objects, R2, Turnstile, Workers Logs). Data may be processed
  outside India.
- **Scope by design (data minimisation):** name, email, password, bids. No phone, Aadhaar, PAN, address, payment or
  KYC data. Bike listings contain no owner identity and only the RTO code, never the registration number.
- **Timeline (as we understand it):** the DPDP Rules were notified in November 2025 with a phased start; most
  Data Fiduciary obligations apply about 18 months later (around May 2027). The features below are built now.

## 2. Data flows

```
 Browser (SPA)                         Cloudflare Worker (/api/*)                     Storage
 ─────────────                         ──────────────────────────                     ───────
 sign-up form ── name, email, password, ──▶ Turnstile check ─▶ Better Auth ──────────▶ D1 user, account (scrypt hash),
                 consent{version}            consent check        │                     session, consents
                                             (refuse w/o consent) └─ hash via PasswordHasherDO (no storage)
 sign-in ─────── email, password ─────────▶ IP limit, HMAC(email) backoff ───────────▶ D1 login_throttle (HMAC key)
                                             security event ─────────────────────────▶ D1 security_events (HMAC ip/email)
 bid / max bid ─ amount (+ session) ──────▶ AuctionDO (user id from session) ─────────▶ DO SQLite: ledger (user id),
                                                                                       proxy maxima, idempotency (24 h)
                                             outbox projection ──────────────────────▶ D1 auctions_rm, auction_bids_rm
                                                                                       (pseudonym), user_bids_rm (user id)
 live page ◀──── pseudonymous events ─────── AuctionDO WebSocket (Origin checked)
 watchlist ───── auction id ──────────────▶ Worker ──────────────────────────────────▶ D1 watchlist
 /account ◀───── export JSON ─────────────── Worker reads D1 + own maxima from DOs
 delete ──────── confirm email ───────────▶ Worker: checks DOs, one D1 batch ────────▶ erase / anonymise (§6)
 admin photos ── re-encoded image ─────────▶ Worker (magic bytes, size) ─────────────▶ R2 (random key) + D1 bike_images
 every request ─ IP, user agent ──────────▶ Workers Logs (JSON, redacted keys) ──────▶ Cloudflare (short retention)
```

Other bidders only ever see a per-auction pseudonym (`Bidder K7Q2`, HMAC of user id + auction id). Hidden maximum
bids are visible only to their owner (and never in events, history, D1 or admin views).

## 3. Data inventory

| Data                                                         | Where                                                                                  | Purpose                                 | Legal basis (design intent)      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| Name, email                                                  | D1 `user`                                                                              | account, sign-in, contact               | consent at sign-up               |
| Password                                                     | D1 `account` (scrypt hash only)                                                        | sign-in                                 | consent                          |
| Sessions (token, expiry, IP, user agent)                     | D1 `session`                                                                           | keep you signed in; show/revoke devices | consent                          |
| Consent records (purpose, notice version, time)              | D1 `consents`                                                                          | prove consent                           | consent / legal obligation       |
| Bids, outcome                                                | DO SQLite ledger (user id); D1 `user_bids_rm` (user id), `auction_bids_rm` (pseudonym) | run the auction; "My bids"              | consent; record of a transaction |
| Hidden maximum bid                                           | DO SQLite `proxy_bids`                                                                 | proxy bidding                           | consent                          |
| Watchlist                                                    | D1 `watchlist`                                                                         | bookmarks                               | consent                          |
| Security events (type, user id, HMAC(email), HMAC(ip), time) | D1 `security_events`                                                                   | abuse detection, log retention duty     | legal obligation / security      |
| Login backoff (HMAC(email), counters)                        | D1 `login_throttle`                                                                    | brute-force protection                  | security                         |
| Admin audit trail                                            | D1 `audit_log`                                                                         | accountability of admin actions         | security                         |
| Account-deletion record (user id, time, request id)          | D1 `account_deletions`                                                                 | proof of erasure; sweeping late copies  | legal obligation                 |
| Request logs                                                 | Workers Logs (platform)                                                                | operations                              | security                         |

## 4. Notice and consent (implemented)

- **Notice:** `/privacy` (public) states what is collected, the three purposes, retention periods, rights, how to
  withdraw, the processor and the right to complain to the Data Protection Board. A short version sits next to the
  consent checkbox on `/register`, with links to the full notice and to Account & privacy. Version:
  `PRIVACY_NOTICE_VERSION` in `packages/contracts/src/account.ts`.
- **Consent:** an **unticked** checkbox ("I agree to the Privacy Notice and Terms") is required. The client sends
  `consent: {accepted: true, version}`; the server refuses sign-up without it, or with an outdated version
  (`databaseHooks.user.create.before` in `apps/worker/src/auth/auth.ts`, after captcha and duplicate checks), and
  records one `consents` row per purpose (`ACCOUNT_AND_BIDDING`) with the version and time. If recording fails, the
  just-created user is deleted (no account without a consent record). Operator-seeded demo accounts have no consent
  record (they are fictional) and the account page says so.
- **One purpose, necessary for the service:** we process no data for optional purposes (no marketing, analytics
  profiling or ads), so there is no optional consent to ask for. If one is ever added it must be a **separate,
  unticked, optional** consent with its own purpose value.
- **Withdrawal:** withdrawing consent for the only purpose means closing the account, which is one self-service
  action (§6). Withdrawal does not affect processing done before it.
- **Not claimed:** a checkbox labelled "Terms" is not, by itself, evidence of DPDP compliance. What the software
  gives is a versioned, purpose-specific record linked to a specific notice text.

## 5. Rights handling

| Right (DPDP Act)                  | How                                                                                                                                                                                                                                                                                                                                                                                               | Where                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Information / access (§11)        | Account & privacy shows details and consent history; **Download my data** returns JSON: account, sessions (no tokens), consent history, watchlist, one row per auction bid in, the user's **own** hidden maxima (read from each auction's object via the owner view, bounded to auctions the user bid in), security events linked to the account (no hashes), and notes on what is held elsewhere | `GET /api/v1/me/account`, `GET /api/v1/me/export` |
| Correction (§12)                  | not self-service yet: contact the operator (§9)                                                                                                                                                                                                                                                                                                                                                   | —                                                 |
| Erasure / withdrawal (§12, §6(4)) | **Delete my account** (re-type email)                                                                                                                                                                                                                                                                                                                                                             | `DELETE /api/v1/me`                               |
| Grievance (§13)                   | contact the operator; complaint to the Data Protection Board                                                                                                                                                                                                                                                                                                                                      | notice                                            |
| Nomination (§14)                  | not implemented: contact the operator                                                                                                                                                                                                                                                                                                                                                             | —                                                 |

The export never contains other users' identities, pseudonym mappings, other buyers' maxima, reserve prices,
password hashes, session tokens or HMACs (`test/privacy.test.ts` checks this against the real rows). Exports are
logged (`account.exported`) and limited to 20 per minute per account.

## 6. Account deletion semantics

`DELETE /api/v1/me` with `{ "confirmEmail": "<your email>" }`:

1. **Refused (409 `CONFLICT`, with `blockers`)** while the user
   - has the highest bid in a LIVE auction (`LEADING_LIVE_AUCTION`), or
   - has a maximum bid that can still bid for them in a LIVE auction (`ACTIVE_MAX_BID_LIVE_AUCTION`; defensive,
     the engine normally makes such a user the leader), or
   - won an auction that closed less than 30 days ago (`WON_UNSETTLED_AUCTION`; settlement happens offline and is
     out of scope, so a fixed window stands in for "settled").

   We **refuse** rather than cancel a maximum or withdraw a leading bid: removing a leader mid-auction would change
   the price and leader for everyone else, and the ledger is append-only by design. **Every** auction that is
   scheduled, live or closed within the settlement window is asked (not only the ones D1 already associates with
   the user: the projection is asynchronous, so a just-placed bid or maximum may not be there yet; independent
   review finding HIGH-1). Each auction's Durable Object answers atomically through `retireUser`: it either refuses,
   or **retires** the user there, after which it rejects every further bid or maximum from them (`FORBIDDEN`,
   "account closed"), so a request already in flight can't slip in. All-or-nothing: on any refusal or unreachable
   object the auctions already retired are rolled back (`unretireUser`) and nothing is deleted (409 or 503). More
   than 1,000 open auctions to check → 503 (an operator handles it). Administrators get 403.

2. **Otherwise, one atomic D1 batch:** deletion record + `audit_log` (`ACCOUNT_DELETED`) + security event; delete all
   sessions (every device is signed out immediately), credentials, verification tokens, watchlist, consents, the
   login-backoff row and the user; re-key the user's "My bids" rows to a random tombstone (`deleted_<random>`, not
   derived from the user id). The response expires the auth cookies.
3. **Kept (retention exceptions):**
   - **Auction ledgers** in each `AuctionDO` (bid rows, events, outcome, pseudonym table) keep the opaque internal
     user id. They contain no name or email; after deletion nothing maps that id back to a person except the
     minimal deletion record (kept one year). Reason: the auction's order, price and winner must stay verifiable
     for the other bidders and the seller, and seq integrity/idempotency must not be disturbed. Winners
     (`auctions_rm.winner_user_id`) are likewise unchanged.
   - **Public bid history** (`auction_bids_rm`) shows only per-auction pseudonyms, before and after deletion; a
     deleted identity is never revealed.
   - **Security events** linked to the account: kept until their one-year retention ends (log-retention duty).
   - **`audit_log`**: append-only accountability record (opaque ids).
4. **Idempotent:** a retry is 401 (no session left) and changes nothing; the deletion record is `ON CONFLICT DO
NOTHING`. The same email can register again as a brand-new account.
5. **Ordering:** retire everywhere → one atomic D1 batch (sessions, credentials, …) → retire in any auction scheduled
   meanwhile (best effort; closes a sub-second window). A late projection that recreates a "My bids" row under the old
   id is swept by the retention job.
6. **Hidden maxima** are stored in the auction's `proxy_bids` table and, for 24 h, inside the owner's own idempotency
   record (the stored response to their max-bid request, returned only to them on a retry). Neither is ever exposed
   to anyone else.

## 7. Retention schedule

Run daily by the cron trigger (`47 21 * * *` UTC = 03:17 IST) → `scheduled()` → `apps/worker/src/lib/retention.ts`.
Bounded (≤ 500 rows per statement, ≤ 20 statements per step, one R2 listing page of 500 per run), idempotent,
each step independent. Periods are Worker vars in `wrangler.jsonc`; invalid values fall back to the default.

| Data                                                       | Kept for                                         | Var (default)                             | Mechanism                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Security events                                            | 1 year (cannot be set lower)                     | `RETENTION_SECURITY_EVENTS_DAYS` (365)    | cron                                                                                 |
| Expired sessions                                           | until expiry (7 days, sliding)                   | —                                         | cron                                                                                 |
| Expired verification tokens                                | until expiry                                     | —                                         | cron                                                                                 |
| Login backoff rows                                         | 24 h idle and not locked                         | `RETENTION_LOGIN_THROTTLE_HOURS` (24)     | cron                                                                                 |
| Watchlist rows                                             | 90 days after the auction ended or was cancelled | `RETENTION_WATCHLIST_AFTER_END_DAYS` (90) | cron                                                                                 |
| Account-deletion records                                   | 1 year                                           | `RETENTION_ACCOUNT_DELETIONS_DAYS` (365)  | cron                                                                                 |
| Failed uploads (R2 objects without a `bike_images` row)    | 24 h grace (uploads write R2 first)              | `RETENTION_ORPHAN_UPLOAD_HOURS` (24)      | cron, cursor in `retention_state`                                                    |
| Idempotency records (per auction)                          | 24 h                                             | —                                         | **already** removed by each AuctionDO's own `idem-gc` timer; not touched by the cron |
| Per-auction bid throttle rows                              | 10 s window                                      | —                                         | pruned by the DO on every command                                                    |
| Account, consents                                          | until account deletion                           | —                                         | `DELETE /me`                                                                         |
| Auction records (listings, read models, ledgers, outcomes) | not deleted for age                              | —                                         | transaction records; a retention period must be decided by the operator (§9)         |
| `audit_log`                                                | not purged                                       | —                                         | accountability; period to be decided (§9)                                            |
| Workers Logs                                               | platform retention (days)                        | —                                         | Cloudflare                                                                           |

## 8. Personal data breach response (runbook)

Our reading of DPDP Rules 2025 (verify with counsel): on becoming aware of a breach, inform each **affected Data
Principal** without delay (what happened, likely consequences, mitigation, what they can do, contact), and inform
the **Data Protection Board** without delay, followed by a detailed report within **72 hours** (or a longer period
the Board allows).

1. **Contain (minutes):** rotate the affected secret (`wrangler secret put BETTER_AUTH_SECRET` invalidates every
   session; `PSEUDONYM_SECRET` rotation changes pseudonyms of new events only; rotate `SEED_TOKEN`); disable
   compromised admin accounts (`UPDATE "user" SET role='USER'` and delete their sessions); if needed, roll back the
   Worker (`wrangler rollback`) or put it in maintenance by removing the route.
2. **Preserve evidence:** export `security_events`, `audit_log` and Workers Logs for the window (logs keep only a
   few days on the Free plan: do this first); note request ids.
3. **Assess:** which data categories and which users (D1 queries by `user_id`/time; R2 access is only via the
   Worker); whether passwords are exposed (stored as scrypt hashes; still force resets if the hash table leaked).
4. **Notify:** affected users (email from the operator's own channel, since the app has no mailer) and the Board as
   above; record the timeline (detection, containment, notifications) in the incident log.
5. **Recover and review:** fix the root cause, add a regression test, update this document and the threat model.

## 9. Implemented safeguards vs. compliance work still needed

**Implemented in software (tested in `apps/worker/test/privacy.test.ts`, `security-headers.test.ts`):** versioned
notice; required, unticked, recorded consent; export; deletion with documented exceptions; retention job;
one-year security logs in D1; pseudonymous public bidding; hidden maxima owner-only; security headers; rate limits;
audit trail; encrypted transport (HTTPS/HSTS) and platform encryption at rest.

**Needs the operator and legal review before real users:**

- Operator identity and grievance contact (name, email, response time) in the notice; Data Protection Officer if
  the operator is a Significant Data Fiduciary.
- Confirm the purposes and that the bid-ledger retention is a permissible exception, and set a retention period
  for auction records and `audit_log`.
- Confirm the 30-day "unsettled win" window and whether a court/legal-hold process is needed.
- Correction and nomination workflows (currently "contact the operator").
- Cross-border processing by Cloudflare; data processing agreement with the processor.
- Children: the service assumes adult users; DPDP requires verifiable parental consent for children, and age
  confirmation is **not** implemented.
- Consent Manager integration (DPDP Rules) is not implemented.
- Whether the notice must be available in languages listed in the Eighth Schedule of the Constitution (DPDP Act
  §5(3)); it is English only.
- Breach-notification templates and an on-call owner.
