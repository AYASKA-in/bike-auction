/**
 * Versioned schema migrations for the per-auction SQLite database.
 * Durable Object SQLite restricts some PRAGMAs, so the version lives in a `_meta` table.
 * Migrations are append-only: never edit a released step, add a new one.
 */
const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE state (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    auction_id          TEXT NOT NULL,
    status              TEXT NOT NULL,
    start_price_minor   INTEGER NOT NULL,
    current_price_minor INTEGER,
    leader_user_id      TEXT,
    bid_count           INTEGER NOT NULL,
    closes_at           INTEGER NOT NULL,
    seq                 INTEGER NOT NULL
  );
  CREATE TABLE bids (
    seq          INTEGER PRIMARY KEY,
    bid_id       TEXT NOT NULL UNIQUE,
    user_id      TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    at           INTEGER NOT NULL
  );
  CREATE TABLE outbox (
    event_id     TEXT PRIMARY KEY,
    seq          INTEGER NOT NULL,
    type         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    projected_at INTEGER
  );
  CREATE INDEX idx_outbox_pending ON outbox (projected_at, seq);
  CREATE TABLE timers (kind TEXT PRIMARY KEY, due_at INTEGER NOT NULL);
  `,
  // v2 (Day 4): the domain engine becomes the single rule implementation. The Day-1 `state`/`outbox`
  // tables are replaced. Pre-release only: no deployment has ever held v1 data (docs/progress.md).
  `
  DROP TABLE state;
  DROP TABLE outbox;
  DELETE FROM bids;
  DELETE FROM timers;
  -- Authoritative domain AuctionState (JSON) at a given seq. One row.
  CREATE TABLE auction_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    seq        INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Committed event log (internal form; contains user ids). Also the outbox: projected_at IS NULL.
  CREATE TABLE events (
    seq          INTEGER PRIMARY KEY,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    at           INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    projected_at INTEGER
  );
  CREATE INDEX idx_events_pending ON events (projected_at, seq);
  -- Durable idempotency, scoped by (user, key); retained >= 24 h then garbage-collected by a timer.
  CREATE TABLE idempotency (
    user_id     TEXT NOT NULL,
    key         TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  CREATE INDEX idx_idempotency_created ON idempotency (created_at);
  -- Per-auction bidder pseudonyms; UNIQUE(code) enforces the collision rule at the storage layer.
  CREATE TABLE pseudonyms (user_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE);
  -- D1 synchronisation health.
  CREATE TABLE sync_status (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    last_attempt_at      INTEGER,
    last_success_at      INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error           TEXT
  );
  INSERT INTO sync_status (id) VALUES (1);
  `,
  // v3 (Day 5): the per-user bid throttle survives restarts (was in-memory on Day 4).
  `
  CREATE TABLE bid_attempts (user_id TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX idx_bid_attempts ON bid_attempts (user_id, at);
  `,
];

export const AUCTION_SCHEMA_VERSION = MIGRATIONS.length;

export function migrateAuctionSchema(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  const hasMeta =
    sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_meta'`).toArray()
      .length > 0;
  const current = hasMeta
    ? Number(
        sql
          .exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'schema_version'`)
          .toArray()[0]?.value ?? 0,
      )
    : 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    // Each step and its version bump commit atomically.
    storage.transactionSync(() => {
      sql.exec(MIGRATIONS[v]!);
      sql.exec(
        `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(v + 1),
      );
    });
  }
}
