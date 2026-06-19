-- symphony-board — cached per-repo all-time activity coverage bounds, Postgres.
--
-- Mirrors schema/sqlite/0005_repo_activity_bounds.sql. occurred_at remains TEXT
-- and bounds are picked by parsed instant with ::timestamptz.

CREATE TABLE IF NOT EXISTS repo_activity_bounds (
  source_id        TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  project_path     TEXT,
  project_key      TEXT NOT NULL,
  observed_since   TEXT,
  last_activity_at TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (source_id, project_key)
);

CREATE INDEX IF NOT EXISTS repo_activity_bounds_by_repo
  ON repo_activity_bounds (source_id, project_path);

INSERT INTO repo_activity_bounds (
  source_id,
  project_path,
  project_key,
  observed_since,
  last_activity_at,
  updated_at
)
SELECT DISTINCT
  source_id,
  project_path,
  CASE WHEN project_path IS NULL THEN 'null:' ELSE 'path:' || project_path END AS project_key,
  FIRST_VALUE(occurred_at) OVER (
    PARTITION BY source_id, project_path
    ORDER BY occurred_at::timestamptz ASC, activity_id ASC
  ) AS observed_since,
  FIRST_VALUE(occurred_at) OVER (
    PARTITION BY source_id, project_path
    ORDER BY occurred_at::timestamptz DESC, activity_id DESC
  ) AS last_activity_at,
  now()::text AS updated_at
FROM activity
ON CONFLICT (source_id, project_key) DO UPDATE SET
  project_path = excluded.project_path,
  observed_since = excluded.observed_since,
  last_activity_at = excluded.last_activity_at,
  updated_at = excluded.updated_at;
