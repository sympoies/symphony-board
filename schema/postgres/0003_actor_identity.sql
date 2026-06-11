-- symphony-board — canonical actor identity for activity rows, Postgres
-- dialect (migration 0003). Mirrors schema/sqlite/0003_actor_identity.sql:
-- additive + nullable; existing rows backfill on the next upsert.

ALTER TABLE activity ADD COLUMN actor_key TEXT;

CREATE INDEX IF NOT EXISTS activity_by_actor_key ON activity (actor_key);
