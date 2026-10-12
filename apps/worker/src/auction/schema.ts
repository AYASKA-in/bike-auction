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
