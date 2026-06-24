-- Add review_thread.last_comment_at: the thread's TRUE newest-comment instant.
--
-- The comment preview (comments_json) holds only the OLDEST `comments_total`
-- rows, so for a >preview-size thread it omits the newest comment, and recency
-- sorting fell back to last_seen_at (a sync-observation time). This column
-- carries the real latest-comment time the source captures independent of the
-- preview size. Additive and nullable: existing rows stay valid (NULL) until the
-- next sync re-upserts them. Stored as TEXT to mirror last_seen_at (ISO string).
ALTER TABLE review_thread ADD COLUMN last_comment_at TEXT;
