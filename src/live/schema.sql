-- Dedicated append-only live-event store schema (live-event/1). This store is
-- OWNED by the least-privilege live receiver and is entirely separate from the
-- canonical store: no shared tables, no writer lease, no soft-delete. Applied
-- verbatim at open via CREATE ... IF NOT EXISTS; the store stamps its own
-- version through PRAGMA user_version (see src/live/store.ts). Timestamps are
-- ISO-8601 TEXT (never epoch ints), matching the canonical store convention.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS live_event (
  -- Monotonic append id. Surfaced as the SSE `id:` / `Last-Event-ID` cursor;
  -- AUTOINCREMENT so a seq is never reused, even after a prune.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Provider source vocabulary, e.g. "github:github.com".
  source_id TEXT NOT NULL,
  -- Provider delivery GUID (X-GitHub-Delivery / GitLab webhook-id): the dedupe
  -- key. NOT unique on its own — see `ordinal`.
  event_id TEXT NOT NULL,
  -- Ordinal within a single provider delivery. One delivery may adapt to
  -- multiple neutral events (e.g. a GitLab push with several commits), so the
  -- dedupe key is (source_id, event_id, ordinal): a redelivery is still a no-op
  -- while every event of a multi-event delivery is retained. 0 for the common
  -- single-event delivery.
  ordinal INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  -- ISO-8601 UTC (Z): the instant the receiver accepted the delivery.
  received_at TEXT NOT NULL,
  -- Provider event time when available; may carry a non-UTC offset, so compare
  -- by instant (julianday), never by raw string.
  occurred_at TEXT,
  event_type TEXT NOT NULL,
  action TEXT,
  -- Neutral category (issue | change_request | comment | review | ...).
  category TEXT NOT NULL,
  actor_json TEXT,
  target_json TEXT,
  title TEXT,
  body TEXT,
  url TEXT,
  -- Provider-specific verdict (e.g. review state). A dedicated column so a
  -- snapshot/SSE read never has to dig it out of `raw`.
  review_state TEXT,
  delivery_json TEXT,
  provider_details_json TEXT,
  raw_json TEXT,
  -- ISO-8601 UTC (Z): the DB insert instant.
  created_at TEXT NOT NULL
);

-- Idempotent append: a redelivery of the same (source_id, event_id, ordinal) is
-- ignored.
CREATE UNIQUE INDEX IF NOT EXISTS live_event_delivery
  ON live_event (source_id, event_id, ordinal);

-- TTL prune scans walk received_at by instant.
CREATE INDEX IF NOT EXISTS live_event_received_at
  ON live_event (received_at);
