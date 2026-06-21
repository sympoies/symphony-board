-- Widen review_thread.target_iid from INTEGER to BIGINT.
--
-- upsertReviewThread writes the provider PR/MR `item.iid` into target_iid. The
-- sibling provider-derived id columns (item.iid, activity.target_iid) are
-- already BIGINT precisely to avoid int4 overflow; review_thread (added in 0006)
-- regressed to INTEGER. A synced change request whose iid exceeds 2^31-1 would
-- make PostgreSQL reject the insert/update with "integer out of range" and fail
-- the sync transaction for that source. Widening is non-destructive: every
-- existing row is preserved, the column only gains range.
ALTER TABLE review_thread ALTER COLUMN target_iid TYPE BIGINT;
