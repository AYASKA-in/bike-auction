-- 0007: post-auction settlement, payments, participation deposits (docs/settlement.md).
-- User ids are plain TEXT (no FK), like user_bids_rm: account deletion is refused while anything is
-- open and re-points closed rows to the tombstone id, so history stays verifiable.

-- One row per buyer attempt at an auction: attempt 1 = the winner, 2+ = runner-up offers.
-- Amounts and deadlines are computed once by packages/domain settlementTerms() and stored, so the
-- deadline sweep is plain SQL.
CREATE TABLE settlements (
  id                 TEXT PRIMARY KEY,
  auction_id         TEXT NOT NULL REFERENCES auction_listings (auction_id),
  attempt            INTEGER NOT NULL CHECK (attempt >= 1),
  buyer_user_id      TEXT NOT NULL,
  bike_id            TEXT NOT NULL,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('OFFERED','AWAITING_INITIAL','AWAITING_BALANCE',
                       'PAID','COLLECTED','DEFAULTED','CANCELLED','DECLINED','EXPIRED')),
  price_minor        INTEGER NOT NULL CHECK (price_minor > 0),
  fee_minor          INTEGER NOT NULL DEFAULT 0,
  gst_minor          INTEGER NOT NULL DEFAULT 0,
  total_minor        INTEGER NOT NULL DEFAULT 0,
  deposit_minor      INTEGER NOT NULL DEFAULT 0,
  initial_due_minor  INTEGER NOT NULL DEFAULT 0,
  payable_minor      INTEGER NOT NULL DEFAULT 0,
  start_at           INTEGER NOT NULL,
  initial_deadline   INTEGER,
  balance_deadline   INTEGER,
  offer_expires_at   INTEGER,
  extension_ms       INTEGER NOT NULL DEFAULT 0,
  extension_reason   TEXT,
  gate_pass          TEXT,
  next_step          TEXT CHECK (next_step IS NULL OR next_step IN ('RUNNER_UP_OFFERED','RELISTED')),
  refund_due_minor   INTEGER NOT NULL DEFAULT 0,
  refunded_at        INTEGER,
  closed_reason      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (auction_id, attempt)
) STRICT;
CREATE INDEX idx_settlements_buyer ON settlements (buyer_user_id, created_at DESC);
CREATE INDEX idx_settlements_status ON settlements (status, updated_at);

-- Payments reported by buyers (UTR / reference) or recorded by admins. Only VERIFIED counts.
-- (settlement_id, reference) is unique: the same transfer can never be counted twice.
CREATE TABLE settlement_payments (
  id             TEXT PRIMARY KEY,
  settlement_id  TEXT NOT NULL REFERENCES settlements (id),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  method         TEXT NOT NULL CHECK (method IN ('UPI','BANK_TRANSFER','CASH','CHEQUE','OTHER')),
  reference      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('REPORTED','VERIFIED','REJECTED')),
  reported_by    TEXT NOT NULL,
  reported_at    INTEGER NOT NULL,
  decided_by     TEXT,
  decided_at     INTEGER,
  reject_reason  TEXT,
  UNIQUE (settlement_id, reference)
) STRICT;
CREATE INDEX idx_settlement_payments_settlement ON settlement_payments (settlement_id, reported_at);
CREATE INDEX idx_settlement_payments_status ON settlement_payments (status, reported_at);

-- Participation deposits (EMD). HELD deposits set the buying limit; APPLIED = counted towards a
-- win; FORFEITED = lost on a default.
CREATE TABLE deposits (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  method         TEXT NOT NULL CHECK (method IN ('UPI','BANK_TRANSFER','CASH','CHEQUE','OTHER')),
  reference      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('PENDING','HELD','REJECTED','APPLIED',
                   'REFUND_REQUESTED','REFUNDED','FORFEITED')),
  settlement_id  TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (user_id, reference)
) STRICT;
CREATE INDEX idx_deposits_user ON deposits (user_id, status);
CREATE INDEX idx_deposits_status ON deposits (status, updated_at);

-- Bidding eligibility: a default pauses bidding until an admin reinstates the account.
CREATE TABLE bidder_flags (
  user_id      TEXT PRIMARY KEY,
  suspended    INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  defaults     INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  updated_at   INTEGER NOT NULL
) STRICT;

-- Settlement applies only to auctions that close after this migration runs: older sales (closed
-- before the 25% / 15-day rule existed) are never opened, defaulted or counted against a bidder.
CREATE TABLE IF NOT EXISTS settlement_config (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO settlement_config (key, value)
  VALUES ('opens_from', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
