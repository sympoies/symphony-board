-- symphony-board — review-thread counts for change requests (migration 0004).
--
-- Open/total resolvable review threads on a change_request, derived per
-- provider (GitHub PR `reviewThreads.isResolved`; GitLab MR
-- resolvable/resolvedDiscussionsCount). A point-in-time snapshot refreshed each
-- sync, exactly like review_state/ci_state — not the state at any one review
-- event's time. NULL for issues and for any provider/row that did not report
-- them.
--
-- Additive + nullable: existing rows backfill on the next upsert. Mirrors
-- schema/sqlite/0004_review_threads.sql.

ALTER TABLE item ADD COLUMN open_review_threads  INTEGER;
ALTER TABLE item ADD COLUMN total_review_threads INTEGER;
