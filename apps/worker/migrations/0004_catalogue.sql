-- 0004: motorcycle catalogue (Day 5). D1 is the source of truth for listings; auction DOs own live
-- state. Privacy: only the RTO code is stored, never the full registration number or owner identity.
CREATE TABLE bikes (
  id                   TEXT PRIMARY KEY,
  make                 TEXT NOT NULL,
  model                TEXT NOT NULL,
  variant              TEXT,
  manufacture_year     INTEGER NOT NULL,
  registration_year    INTEGER NOT NULL CHECK (registration_year >= manufacture_year),
  fuel                 TEXT NOT NULL CHECK (fuel IN ('PETROL','ELECTRIC')),
  engine_cc            INTEGER CHECK (engine_cc IS NULL OR engine_cc BETWEEN 50 AND 2000),
  km_driven            INTEGER NOT NULL CHECK (km_driven BETWEEN 0 AND 500000),
  owner_count          INTEGER NOT NULL CHECK (owner_count BETWEEN 1 AND 6),
  rto_code             TEXT NOT NULL,
  rc_status            TEXT NOT NULL CHECK (rc_status IN ('ORIGINAL','DUPLICATE','PENDING_TRANSFER')),
  hypothecation        TEXT NOT NULL CHECK (hypothecation IN ('NONE','ACTIVE','NOC_ISSUED')),
  insurance_valid_till TEXT,
  city                 TEXT NOT NULL,
  yard                 TEXT NOT NULL,
  repossessed          INTEGER NOT NULL CHECK (repossessed IN (0,1)),
  as_is_where_is       INTEGER NOT NULL CHECK (as_is_where_is IN (0,1)),
  colour               TEXT,
  description          TEXT NOT NULL DEFAULT '',
  created_by           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_bikes_make ON bikes (make COLLATE NOCASE);
CREATE INDEX idx_bikes_city ON bikes (city COLLATE NOCASE);

-- Versioned inspection reports; the highest version is current. History is never overwritten.
CREATE TABLE bike_inspections (
  bike_id           TEXT NOT NULL REFERENCES bikes (id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  grade             TEXT NOT NULL CHECK (grade IN ('A','B','C','D')),
  sections_json     TEXT NOT NULL,
  visible_damage    TEXT NOT NULL,
  mechanical_issues TEXT NOT NULL,
  inspector_notes   TEXT NOT NULL,
  inspector_name    TEXT NOT NULL,
  inspected_at      TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (bike_id, version)
) STRICT;

-- Images live in a PRIVATE R2 bucket under random keys, served through the Worker. Never
-- user-controlled filenames. position 0 is the cover photo.
CREATE TABLE bike_images (
  id           TEXT PRIMARY KEY,
  bike_id      TEXT NOT NULL REFERENCES bikes (id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes        INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  alt          TEXT NOT NULL,
  position     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_bike_images_bike ON bike_images (bike_id, position);

-- Auction ↔ bike. `active` = 1 while the auction is draft/scheduled/live; the projection clears it
-- when the auction ends or is cancelled. The partial unique index makes "one open auction per bike"
-- a database guarantee, safe against two admins creating at the same moment.
CREATE TABLE auction_listings (
  auction_id TEXT PRIMARY KEY,
  bike_id    TEXT NOT NULL REFERENCES bikes (id),
  title      TEXT NOT NULL,
  terms      TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX uq_auction_listings_open_bike ON auction_listings (bike_id) WHERE active = 1;
CREATE INDEX idx_auction_listings_created ON auction_listings (created_at);

-- Catalogue query support (filters/sorts run against the read model).
CREATE INDEX idx_auctions_rm_status_price ON auctions_rm (status, current_price_minor);
