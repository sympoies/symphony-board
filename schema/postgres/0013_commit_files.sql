-- Per-commit changed files. One row per commit activity the enrichment pass has
-- an answer for: the file list ("ok"), a note that the provider no longer has
-- the commit ("unavailable"), or a note that the commit is a merge, whose diff
-- is against its first parent and is never read ("merge"). Any row takes the
-- commit out of the pass's queue.
--
-- Its own table rather than a key on activity.details: an activity upsert
-- replaces details wholesale, so a sweep that did not re-read the files would
-- erase them. Keyed by the commit activity's identity (source_id, external_id).
-- Only path, status and line counts are stored; patch text never is.

CREATE TABLE IF NOT EXISTS commit_files (
  source_id    TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,        -- the commit activity's external_id
  project_path TEXT,
  sha          TEXT NOT NULL,
  state        TEXT NOT NULL,        -- ok | unavailable | merge
  truncated    BOOLEAN NOT NULL DEFAULT FALSE,  -- the provider capped the file list
  files        TEXT NOT NULL DEFAULT '[]',  -- JSON [{path,status,additions,deletions}]
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
