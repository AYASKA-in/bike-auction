-- 0005: buyer watchlist (Day 7). One row per (user, auction); PUT is an idempotent upsert.
-- Integrity: the route only inserts for an auction that exists in auction_listings and is not a
-- DRAFT in auctions_rm (D1 FKs can't express "not a draft"). Removing a user cascades with the
-- account. At most 100 rows per user, enforced in the route (409 CONFLICT beyond that).
CREATE TABLE watchlist (
  user_id    TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  auction_id TEXT NOT NULL REFERENCES auction_listings (auction_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, auction_id)
) STRICT;

-- "My watchlist" newest first, and the per-user count for the cap.
CREATE INDEX idx_watchlist_user_created ON watchlist (user_id, created_at DESC);
