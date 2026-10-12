-- 0001_init: global read model + audit foundations.
-- D1 is NOT the source of truth for live auction state; the per-auction Durable Object is.
-- auctions_rm is a projection fed by the DO outbox; projection_seq makes upserts idempotent.

CREATE TABLE auctions_rm (
  id                  TEXT PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT','SCHEDULED','LIVE','ENDED','CANCELLED')),
  current_price_minor INTEGER,
  bid_count           INTEGER NOT NULL DEFAULT 0,
  closes_at           INTEGER,
  projection_seq      INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_auctions_rm_status_closes ON auctions_rm (status, closes_at);

-- Append-only. No code path issues UPDATE or DELETE except the retention purge job.
CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  actor_user_id  TEXT NOT NULL,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  request_id     TEXT NOT NULL,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_audit_resource ON audit_log (resource_type, resource_id, created_at);
