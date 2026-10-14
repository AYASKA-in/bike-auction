-- 0006: data protection (DPDP Act 2023 + DPDP Rules 2025), Day 8. See docs/privacy.md.

-- Consent given at sign-up: one row per purpose and Privacy Notice version. Deleted with the account
-- (the account_deletions row below is the minimal record that remains).
CREATE TABLE consents (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  purpose  TEXT NOT NULL CHECK (purpose IN ('ACCOUNT_AND_BIDDING')),
  version  TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 32),
  at       INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_consents_user ON consents (user_id, at);

-- Minimal record that an account was erased: no name, no email, no IP. user_id is the opaque id
-- that the retained, pseudonymous auction ledgers (Durable Objects) still reference. Purged by the
-- retention job after one year.
CREATE TABLE account_deletions (
  user_id             TEXT PRIMARY KEY,
  deleted_at          INTEGER NOT NULL,
  request_id          TEXT NOT NULL,
  bid_rows_anonymised INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_account_deletions_deleted ON account_deletions (deleted_at);

-- Small key/value state for the retention job (e.g. the R2 orphan-scan cursor).
CREATE TABLE retention_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Retention job support (src/lib/retention.ts): every purge is an indexed range scan.
CREATE INDEX idx_session_expires ON "session" ("expiresAt");
CREATE INDEX idx_verification_expires ON "verification" ("expiresAt");
CREATE INDEX idx_login_throttle_updated ON login_throttle (updated_at);
CREATE INDEX idx_watchlist_auction ON watchlist (auction_id);
CREATE INDEX idx_auctions_rm_closes ON auctions_rm (closes_at);

-- Per-admin write budget (middleware/security.ts adminWriteLimit) counts recent audit rows.
CREATE INDEX idx_audit_actor_created ON audit_log (actor_user_id, created_at);
