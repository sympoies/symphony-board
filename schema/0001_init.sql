-- symphony-board — canonical store schema (migration 0001).
--
-- This is the SECOND of the three layers (raw store -> canonical DB ->
-- versioned contract). It is provider-agnostic on purpose: nothing here bakes
-- in GitHub/GitLab assumptions. A new source (point 6) implements the Source
-- interface and writes into these same tables; the contract is derived from
-- them and versioned separately (see schema/contract.schema.json).
--
-- Conventions:
--   * Timestamps are ISO-8601 UTC strings (TEXT), never epoch ints, so the file
--     is human-readable and SQL date functions work.
--   * Booleans are stored as INTEGER 0/1 (node:sqlite has no bool type).
--   * `external_id` is the provider's IMMUTABLE global id (GitHub node id,
--     GitLab "gid://gitlab/Issue/123"). `project_path` / `iid` are mutable
--     human metadata — never key on them (repos get renamed/transferred).
--   * State model is normalized to open | closed | merged. The provider's raw
--     state string is preserved alongside (`*_raw`) as an escape hatch.
--
-- Migrations are tracked with PRAGMA user_version (set to 1 by this file's
-- applier). ALTER TABLE in SQLite is limited; later migrations that change a
-- column use the create-new / copy / drop-old / rename rebuild pattern.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- meta: DB-level key/value (schema provenance, generator version, etc.).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- source: every registered record source (a provider instance). source_id is
-- the stable handle used everywhere else, e.g. "github:github.com",
-- "gitlab:gitlab.gamania.com". source_id MUST NOT contain the '|' character —
-- the contract composite ref ("<source_id>|<external_id>") splits on the first
-- '|', and external_id (GitLab gids) may itself contain ':' and '/'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source (
  source_id    TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,          -- github | gitlab | ... (open vocabulary)
  host         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- raw: LAYER 1. The provider payload, stored opaque. This is the insurance
-- policy behind both contract versioning (replay normalization offline when
-- rules change — no re-fetch) and new sources. The normalized layer below must
-- NEVER assume this blob is stable across provider API changes; `api_version`
-- and `fetched_at` tag what produced it.
--
-- One row per (source_id, external_id): the latest snapshot. History is a
-- deliberate non-goal for v1 (replaying present state needs only the latest
-- raw); a future migration can add a raw_history table without touching this.
-- `content_hash` lets a sync skip re-normalizing an unchanged payload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw (
  raw_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  entity_kind  TEXT NOT NULL,          -- issue | change_request | ... (open vocabulary)
  external_id  TEXT NOT NULL,
  api_version  TEXT,                   -- source's API/schema tag at fetch time
  content_hash TEXT,                   -- hash of payload, to detect no-op updates
  fetched_at   TEXT NOT NULL,
  payload      TEXT NOT NULL,          -- opaque JSON (query with json_extract)
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS raw_by_kind ON raw (source_id, entity_kind);

-- ---------------------------------------------------------------------------
-- item: LAYER 2. The canonical, normalized work item (issue or change request).
-- Provider-agnostic core + nullable extension fields. `last_seen_at` and
-- `deleted_at` implement disappearance handling: a sync sets last_seen_at on
-- every observed item, and ONLY a successful FULL run may soft-delete items it
-- did not see (deleted_at = now). A partial/failed fetch (VPN blip, lost auth)
-- never deletes — "not fetched this run" must not look like "deleted".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item (
  item_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- issue | change_request
  project_path    TEXT,                -- human path (mutable metadata)
  iid             INTEGER,             -- per-project number (mutable metadata)
  url             TEXT,
  title           TEXT,
  state           TEXT NOT NULL,       -- open | closed | merged (normalized)
  state_raw       TEXT,                -- provider's raw state string (escape hatch)
  state_reason    TEXT,                -- completed | not_planned | duplicate | NULL
  is_draft        INTEGER,             -- 0 | 1 | NULL (change requests)
  author          TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  closed_at       TEXT,
  merged_at       TEXT,
  -- extension layer (nullable; derivation differs per provider, see DESIGN.md)
  review_state    TEXT,                -- approved | changes_requested | review_required | NULL
  ci_state        TEXT,                -- passing | failing | pending | none | NULL
  merge_state     TEXT,                -- mergeable | conflicting | blocked | unknown | NULL
  milestone       TEXT,
  demand          INTEGER,             -- comments + reactions
  -- bookkeeping
  normalized_with TEXT,                -- normalizer version that produced this row
  last_seen_at    TEXT NOT NULL,       -- last successful observation
  deleted_at      TEXT,                -- soft-delete tombstone (NULL = live)
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS item_by_state    ON item (state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS item_by_kind     ON item (kind);
CREATE INDEX IF NOT EXISTS item_by_project  ON item (source_id, project_path);
CREATE INDEX IF NOT EXISTS item_by_updated  ON item (updated_at);
CREATE INDEX IF NOT EXISTS item_by_closed   ON item (closed_at);
CREATE INDEX IF NOT EXISTS item_by_seen     ON item (source_id, last_seen_at);

-- ---------------------------------------------------------------------------
-- item_label: labels for an item. Raw label string preserved verbatim; `scope`
-- is the optionally-parsed prefix of a "scope::value" label. NOTE the same
-- string is semantically different per provider — in GitLab "scope::value"
-- labels are MUTUALLY EXCLUSIVE within a scope; in GitHub the "::" is just
-- characters. The contract carries both name and scope; the consumer decides.
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
-- edge: THE SPINE (point 1). The issue <-> PR/MR relationship, modeled as a
-- typed, directed, stateful, many-to-many, possibly cross-source link. An edge
-- is RECONCILED from both endpoints (a PR declares "Closes #5"; the issue
-- reports "closed by !12") and may be seen from either side at different times.
--
-- Direction: `from` asserts the relationship about `to`. For type='closes',
-- from = the change request, to = the issue. Endpoints are stored as
-- (source_id, external_id) pairs so the link survives even when one endpoint is
-- in an untracked project (e.g. a PR closing an issue we don't sync). Endpoint
-- states are cached for lifecycle/contract without a join; the item table is
-- still the source of truth when both ends are tracked.
--
-- lifecycle (derived): declared (PR open / not yet resolved) -> fulfilled
-- (change request merged AND issue closed) -> broken (change request closed
-- without merging). This is exactly the "in-progress" / "Tracking" signal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edge (
  edge_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL,        -- closes | relates | mentions | blocks | blocked_by | parent | child (open vocab)
  from_source_id TEXT NOT NULL,
  from_external_id TEXT NOT NULL,
  to_source_id   TEXT NOT NULL,
  to_external_id TEXT NOT NULL,
  from_state     TEXT,                 -- cached normalized state of the `from` endpoint
  to_state       TEXT,                 -- cached normalized state of the `to` endpoint
  lifecycle      TEXT,                 -- declared | fulfilled | broken
  discovered_from TEXT,                -- from | to | both (reconciliation provenance)
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  deleted_at     TEXT,                 -- soft-delete (the link disappeared from both ends)
  UNIQUE (type, from_source_id, from_external_id, to_source_id, to_external_id)
);
CREATE INDEX IF NOT EXISTS edge_by_from ON edge (from_source_id, from_external_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_by_to   ON edge (to_source_id, to_external_id)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_by_life ON edge (lifecycle)                        WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- sync_run: append-only history of sync runs. The disappearance rule keys off
-- this: a soft-delete sweep is allowed only for the source of a run whose
-- mode='full' AND status='ok'. `started_at` is the cutoff — items of that
-- source with last_seen_at < started_at are tombstoned by that run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_run (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL REFERENCES source(source_id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,           -- full | incremental
  status      TEXT NOT NULL,           -- ok | partial | error
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  items_seen  INTEGER NOT NULL DEFAULT 0,
  edges_seen  INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS sync_run_by_source ON sync_run (source_id, started_at);

-- ---------------------------------------------------------------------------
-- sync_state: the latest per-source watermark + status, for incremental sync
-- and quick health display. Updated at the end of each run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_state (
  source_id       TEXT PRIMARY KEY REFERENCES source(source_id) ON DELETE CASCADE,
  watermark       TEXT,                -- e.g. max(updated_at) seen — feeds incremental fetch
  last_run_at     TEXT,
  last_success_at TEXT,
  last_status     TEXT,                -- ok | partial | error
  last_error      TEXT
);
