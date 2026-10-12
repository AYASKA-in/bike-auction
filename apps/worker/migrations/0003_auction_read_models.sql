-- 0003: read models fed by the AuctionDO outbox (Day 4). D1 is never the source of truth for live
-- auction state; every row carries the DO seq it reflects, and writes only move forward.

ALTER TABLE auctions_rm ADD COLUMN outcome TEXT CHECK (outcome IN ('SOLD','RESERVE_NOT_MET','NO_BIDS'));
ALTER TABLE auctions_rm ADD COLUMN start_price_minor INTEGER;
ALTER TABLE auctions_rm ADD COLUMN starts_at INTEGER;
ALTER TABLE auctions_rm ADD COLUMN has_reserve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auctions_rm ADD COLUMN reserve_met INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auctions_rm ADD COLUMN leading_bidder TEXT;
ALTER TABLE auctions_rm ADD COLUMN winner_user_id TEXT;
ALTER TABLE auctions_rm ADD COLUMN extension_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_auctions_rm_status_starts ON auctions_rm (status, starts_at);

-- Public bid history (pseudonymous). PK makes replays of the same event a no-op.
CREATE TABLE auction_bids_rm (
  auction_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  bid_id       TEXT NOT NULL UNIQUE,
  bidder       TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (auction_id, seq)
) STRICT;

-- Per-user participation (for "My bids"). Guarded by last_bid_seq so older events never overwrite.
CREATE TABLE user_bids_rm (
  user_id              TEXT NOT NULL,
  auction_id           TEXT NOT NULL,
  highest_amount_minor INTEGER NOT NULL,
  last_bid_seq         INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (user_id, auction_id)
) STRICT;
CREATE INDEX idx_user_bids_rm_user ON user_bids_rm (user_id, updated_at);
