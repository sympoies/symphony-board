-- Current review-thread detail rows. This is a read model for the Review tab:
-- one row per provider review thread, with a compact JSON preview of comments.
-- It is current-state data refreshed by sync, not an activity/event stream.

CREATE TABLE IF NOT EXISTS review_thread (
  source_id          TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  project_path       TEXT,
  target_source_id   TEXT NOT NULL,
  target_external_id TEXT NOT NULL,
  target_iid         INTEGER,
  title              TEXT,
  url                TEXT,
  is_resolved        INTEGER NOT NULL,
  is_outdated        INTEGER,
  resolved_by        TEXT,
  path               TEXT,
  line               INTEGER,
  start_line         INTEGER,
  comments_total     INTEGER NOT NULL DEFAULT 0,
  comments_json      TEXT NOT NULL DEFAULT '[]',
  last_seen_at       TEXT NOT NULL,
  deleted_at         TEXT,
  PRIMARY KEY (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS review_thread_by_target
  ON review_thread (target_source_id, target_external_id);

CREATE INDEX IF NOT EXISTS review_thread_by_project
  ON review_thread (source_id, project_path);
