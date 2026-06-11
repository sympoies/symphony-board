-- symphony-board — canonical store schema, Postgres dialect (migration 0001).
--
-- Mirrors schema/sqlite/0001_init.sql table-for-table and column-for-column;
-- the Store interface (src/db/store.ts) is the contract, the DDL is driver-
-- owned. Dialect differences, deliberately:
--   * INTEGER PRIMARY KEY AUTOINCREMENT -> INTEGER GENERATED ALWAYS AS IDENTITY
--     (int4 — postgres.js returns int8 as strings, and board-scale row counts
--     never approach 2^31).
--   * Booleans are real BOOLEAN (SQLite stores INTEGER 0/1); the driver maps.
--   * Timestamps stay ISO-8601 strings in TEXT columns, exactly like SQLite —
--     occurred_at preserves the provider's original UTC offset, and the driver
--     orders by instant with ::timestamptz where SQLite uses julianday().
--   * Schema version lives in meta (key 'schema_version'); Postgres has no
--     PRAGMA user_version. The migration applier owns writing it.
--
-- Migrations are append-only; never edit an applied file.

-- ---------------------------------------------------------------------------
-- meta: DB-level key/value (schema version, provenance).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- source: every registered record source (a provider instance). source_id
-- MUST NOT contain '|' (the contract composite ref splits on the first '|').
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source (
  source_id    TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  host         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- raw: LAYER 1. The provider payload, stored opaque. One row per
-- (source_id, external_id): the latest snapshot. content_hash lets a sync
-- skip re-normalizing an unchanged payload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw (
  raw_id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  entity_kind  TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  api_version  TEXT,
  content_hash TEXT,
  fetched_at   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS raw_by_kind ON raw (source_id, entity_kind);

-- ---------------------------------------------------------------------------
-- item: LAYER 2. The canonical, normalized work item. last_seen_at and
-- deleted_at implement disappearance handling; only a successful FULL run may
-- soft-delete items it did not see.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item (
  item_id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  project_path    TEXT,
  iid             INTEGER,
  url             TEXT,
  title           TEXT,
  state           TEXT NOT NULL,
  state_raw       TEXT,
  state_reason    TEXT,
  is_draft        BOOLEAN,
  author          TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  closed_at       TEXT,
  merged_at       TEXT,
  review_state    TEXT,
  ci_state        TEXT,
  merge_state     TEXT,
  milestone       TEXT,
  demand          INTEGER,
  normalized_with TEXT,
  last_seen_at    TEXT NOT NULL,
  deleted_at      TEXT,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS item_by_state    ON item (state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS item_by_kind     ON item (kind);
CREATE INDEX IF NOT EXISTS item_by_project  ON item (source_id, project_path);
CREATE INDEX IF NOT EXISTS item_by_updated  ON item (updated_at);
CREATE INDEX IF NOT EXISTS item_by_closed   ON item (closed_at);
CREATE INDEX IF NOT EXISTS item_by_seen     ON item (source_id, last_seen_at);

-- ---------------------------------------------------------------------------
-- item_label: labels for an item, raw string preserved verbatim.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_label (
  item_id INTEGER NOT NULL REFERENCES item(item_id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  scope   TEXT,
  color   TEXT,
  PRIMARY KEY (item_id, name)
);
CREATE INDEX IF NOT EXISTS label_by_name ON item_label (name);

-- ---------------------------------------------------------------------------
-- edge: THE SPINE. Typed, directed, stateful, many-to-many, possibly
-- cross-source. Endpoints are (source_id, external_id) pairs so a link
-- survives an untracked endpoint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edge (
  edge_id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type             TEXT NOT NULL,
  from_source_id   TEXT NOT NULL,
  from_external_id TEXT NOT NULL,
  to_source_id     TEXT NOT NULL,
  to_external_id   TEXT NOT NULL,
  from_state       TEXT,
  to_state         TEXT,
  lifecycle        TEXT,
  discovered_from  TEXT,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  deleted_at       TEXT,
  UNIQUE (type, from_source_id, from_external_id, to_source_id, to_external_id)
);
CREATE INDEX IF NOT EXISTS edge_by_from ON edge (from_source_id, from_external_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_by_to   ON edge (to_source_id, to_external_id)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_by_life ON edge (lifecycle)                        WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- sync_run: append-only history of sync runs. The disappearance rule keys off
-- this; started_at is the cutoff for that run's sweep.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_run (
  run_id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  items_seen  INTEGER NOT NULL DEFAULT 0,
  edges_seen  INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS sync_run_by_source ON sync_run (source_id, started_at);

-- ---------------------------------------------------------------------------
-- sync_state: the latest per-source watermark + status. The driver's upsert
-- keeps the watermark monotonic (GREATEST), so an interleaved older run can
-- never regress it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_state (
  source_id       TEXT PRIMARY KEY REFERENCES source(source_id) ON DELETE CASCADE,
  watermark       TEXT,
  last_run_at     TEXT,
  last_success_at TEXT,
  last_status     TEXT,
  last_error      TEXT
);
