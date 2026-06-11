-- symphony-board — additive activity store, Postgres dialect (migration 0002).
-- Mirrors schema/sqlite/0002_activity.sql. occurred_at stays TEXT and keeps
-- the provider's original UTC offset; the driver orders by instant with
-- ::timestamptz.

ALTER TABLE sync_run ADD COLUMN activities_seen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS activity (
  activity_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id          TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  external_id        TEXT NOT NULL,
  kind               TEXT NOT NULL,
  action             TEXT NOT NULL,
  project_path       TEXT,
  target_kind        TEXT,
  target_source_id   TEXT,
  target_external_id TEXT,
  -- BIGINT: gitlab.com target/event identifiers exceed 2^31 in the wild.
  target_iid         BIGINT,
  title              TEXT,
  url                TEXT,
  actor              TEXT,
  occurred_at        TEXT NOT NULL,
  summary            TEXT,
  details            TEXT,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS activity_by_time    ON activity (occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_by_kind    ON activity (kind, action);
CREATE INDEX IF NOT EXISTS activity_by_project ON activity (source_id, project_path, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_by_target  ON activity (target_source_id, target_external_id);
