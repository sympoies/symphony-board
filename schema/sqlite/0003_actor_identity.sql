-- symphony-board — canonical actor identity for activity rows (migration 0003).
--
-- `actor` stays the raw provider display string. `actor_key` is the stable
-- identity key derived at normalization time (src/model/actor.ts): a
-- `provider-user:<source_id>:<username>` key, a hashed `email:<hash>` key for
-- account-less commits, or a `name:<normalized>` fallback. Repo-metric actor
-- aggregation groups on this key so one human collapses to one row instead of
-- duplicating across a provider username and several commit author names.
--
-- Additive + nullable: existing rows backfill on the next upsert (the activity
-- upsert writes actor_key on conflict). Item authors are always a provider
-- username, so their key is recomputed at contract-build time and needs no
-- column here.

PRAGMA foreign_keys = ON;

ALTER TABLE activity ADD COLUMN actor_key TEXT;

CREATE INDEX IF NOT EXISTS activity_by_actor_key ON activity (actor_key);
