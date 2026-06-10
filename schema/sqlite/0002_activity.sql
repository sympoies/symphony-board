-- symphony-board — additive activity store (migration 0002).
--
-- Activity is append/upsert history derived from provider event surfaces and
-- stable item timestamps. It is deliberately separate from item/edge rows: an
-- item is current state, while an activity row is something that happened.
-- Providers differ heavily, so `kind` / `action` are open strings and details
-- remains opaque JSON for provider-specific escape hatches.

PRAGMA foreign_keys = ON;

ALTER TABLE sync_run ADD COLUMN activities_seen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS activity (
  activity_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id          TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  external_id        TEXT NOT NULL,
  kind               TEXT NOT NULL,       -- issue | change_request | commit | push | branch | tag | ...
  action             TEXT NOT NULL,       -- opened | closed | merged | pushed | created | deleted | ...
  project_path       TEXT,
  target_kind        TEXT,                -- issue | change_request | commit | branch | tag | ...
  target_source_id   TEXT,
  target_external_id TEXT,
  target_iid         INTEGER,
  title              TEXT,
  url                TEXT,
  actor              TEXT,
  occurred_at        TEXT NOT NULL,
  summary            TEXT,
  details            TEXT,                -- provider-specific JSON object, serialized
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS activity_by_time    ON activity (occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_by_kind    ON activity (kind, action);
CREATE INDEX IF NOT EXISTS activity_by_project ON activity (source_id, project_path, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_by_target  ON activity (target_source_id, target_external_id);
