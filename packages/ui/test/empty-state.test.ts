import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityDTO } from "@symphony-board/contract";
import { activityOccurredExtent, boardCommitTotal, emptyStateKind, isBoardEmpty, rangeReachesDataTail } from "../src/model.ts";

// `emptyStateKind` is the single decision that picks which empty-state treatment
// a page renders. It is only ever consulted when the page has nothing to show
// (zero rows after every filter), so it answers "WHY is this empty?".

test("emptyStateKind: an empty board outranks every other signal", () => {
  assert.equal(emptyStateKind({ boardEmpty: true, total: 0, windowTotal: 0 }), "board-empty");
  // Even if a stale entity count looks non-zero, an empty board still wins.
  assert.equal(emptyStateKind({ boardEmpty: true, total: 5, windowTotal: 3 }), "board-empty");
});

test("emptyStateKind: board has data but none of this entity exists", () => {
  assert.equal(emptyStateKind({ boardEmpty: false, total: 0, windowTotal: 0 }), "entity-empty");
});

test("emptyStateKind: the entity exists but the selected range holds none of it", () => {
  assert.equal(emptyStateKind({ boardEmpty: false, total: 100, windowTotal: 0 }), "range-empty");
});

test("emptyStateKind: the range has data but the active filters hid all of it", () => {
  assert.equal(emptyStateKind({ boardEmpty: false, total: 100, windowTotal: 12 }), "filtered");
});

// `rangeReachesDataTail` decides the range-empty sub-mode: when the selected
// range still reaches the newest data day, emptiness is the "new day / quiet
// period" case (suggest WIDENING); otherwise the range sits off to one side of
// the data and the user is lost (suggest JUMPING to where the data is).
const EXTENT = { from: "2025-06-15", to: "2026-06-18" };

test("rangeReachesDataTail: a range covering the newest data day is the widen case", () => {
  // today == data tail
  assert.equal(rangeReachesDataTail({ from: "2026-06-18", to: "2026-06-18" }, EXTENT), true);
  // this-week spanning up to the data tail
  assert.equal(rangeReachesDataTail({ from: "2026-06-14", to: "2026-06-18" }, EXTENT), true);
  // "Show all": a range that strictly contains the extent on both sides still
  // reaches the tail (both clauses true via from < extent.from)
  assert.equal(rangeReachesDataTail({ from: "2024-01-01", to: "2027-01-01" }, EXTENT), true);
});

test("rangeReachesDataTail: a stale historical range before the data is the jump case", () => {
  assert.equal(rangeReachesDataTail({ from: "2020-11-03", to: "2020-11-03" }, EXTENT), false);
  // ends before the newest data — there is newer data to jump forward to
  assert.equal(rangeReachesDataTail({ from: "2025-06-15", to: "2025-07-01" }, EXTENT), false);
});

test("rangeReachesDataTail: a future range past the data is the jump case", () => {
  assert.equal(rangeReachesDataTail({ from: "2030-01-01", to: "2030-01-02" }, EXTENT), false);
});

test("rangeReachesDataTail: with no known data extent, default to the widen case", () => {
  assert.equal(rangeReachesDataTail({ from: "2026-06-18", to: "2026-06-18" }, null), true);
});

// `activityOccurredExtent` is the true (unwindowed) span the Activity / Commits
// empty states advertise, instead of the 90-day item window.
const act = (occurred_at: string, kind = "issue"): ActivityDTO => ({ occurred_at, kind }) as unknown as ActivityDTO;

test("activityOccurredExtent: spans earliest..latest occurred_at as date-only in the contract tz", () => {
  const ext = activityOccurredExtent(
    [act("2025-06-15T10:00:00Z"), act("2026-06-18T09:00:00Z"), act("2025-12-01T00:00:00Z")],
    "UTC",
  );
  assert.deepEqual(ext, { from: "2025-06-15", to: "2026-06-18" });
});

test("activityOccurredExtent: a predicate scopes the extent to a subset", () => {
  const ext = activityOccurredExtent(
    [act("2020-01-01T00:00:00Z", "push"), act("2025-06-15T00:00:00Z", "commit"), act("2026-06-18T00:00:00Z", "commit")],
    "UTC",
    (a) => a.kind === "commit",
  );
  assert.deepEqual(ext, { from: "2025-06-15", to: "2026-06-18" });
});

test("activityOccurredExtent: null for an empty set", () => {
  assert.equal(activityOccurredExtent([], "UTC"), null);
});

// `isBoardEmpty` decides the fresh/unsynced board-empty treatment. 4.0.0 windows
// `activities` to ~30 days, so an empty `activities` array no longer implies
// "no activity ever" — a dormant board still carries full history in
// `activity_daily`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (over: any) => over as Parameters<typeof isBoardEmpty>[0];

test("isBoardEmpty: a dormant board with windowed-out activities but activity_daily history is NOT empty", () => {
  assert.equal(isBoardEmpty(env({ items: [], activities: [], activity_daily: { total: 42 } })), false, "full-history total keeps it non-empty");
});

test("isBoardEmpty: a genuinely fresh board (no items, no activity, zero/absent aggregate) is empty", () => {
  assert.equal(isBoardEmpty(env({ items: [], activities: [], activity_daily: { total: 0 } })), true);
  // pre-4.0.0 contract without activity_daily falls back to the windowed array.
  assert.equal(isBoardEmpty(env({ items: [], activities: [] })), true);
});

test("isBoardEmpty: any item means the board is not empty", () => {
  assert.equal(isBoardEmpty(env({ items: [{}], activities: [], activity_daily: { total: 0 } })), false);
});

// `boardCommitTotal` is the board-wide commit count for the Commits header /
// empty state. 4.0.0 windows `activities`, so it prefers the full-history
// `activity_daily.by_kind.commit`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cenv = (over: any) => over as Parameters<typeof boardCommitTotal>[0];

test("boardCommitTotal: prefers full-history activity_daily.by_kind.commit over the windowed feed", () => {
  assert.equal(boardCommitTotal(cenv({ activities: [{ kind: "commit" }], activity_daily: { by_kind: { commit: 137 } } })), 137);
});

test("boardCommitTotal: falls back to the windowed commit count without an aggregate, 0 when absent", () => {
  assert.equal(boardCommitTotal(cenv({ activities: [{ kind: "commit" }, { kind: "issue" }, { kind: "commit" }] })), 2);
  assert.equal(boardCommitTotal(null), 0);
});
