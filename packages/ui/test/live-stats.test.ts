// Pure stats helpers behind the Live tab's "pulse" strip and feed (the repo's
// "test the pure logic, smoke the render" convention): the readouts (rate,
// rolling histogram buckets, category/active counts) and the relative-age label
// are derived here from the in-memory event buffer so the render stays a thin
// transcription. The render smoke walks #/live; these pin the math.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actorKey,
  actorActivityRanks,
  eventInstant,
  eventRepo,
  countInWindow,
  rateBuckets,
  bucketRange,
  categoryCounts,
  distinctCount,
  distinctValues,
  eventMatchesFilters,
  repoActivityRanks,
  relativeAge,
  visibleByCategory,
  LIVE_CATEGORY_ORDER,
  humanizeCategory,
} from "../src/live-stats.ts";
import type { LiveEvent } from "../src/model.ts";

// Minimal LiveEvent factory: fills the required fields, overrides via `over`.
let seqCounter = 0;
function ev(over: Partial<LiveEvent> = {}): LiveEvent {
  seqCounter += 1;
  return {
    seq: seqCounter,
    event_id: `e${seqCounter}`,
    source_id: "github:github.com",
    provider: "github",
    received_at: "2026-06-20T12:00:00.000Z",
    event_type: "push",
    category: "push",
    ...over,
  };
}

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const at = (msBeforeNow: number): string => new Date(NOW - msBeforeNow).toISOString();

test("eventInstant prefers occurred_at, falls back to received_at, else null", () => {
  assert.equal(
    eventInstant(ev({ occurred_at: at(0), received_at: at(5000) })),
    NOW,
  );
  assert.equal(
    eventInstant(ev({ occurred_at: null, received_at: at(1000) })),
    NOW - 1000,
  );
  assert.equal(eventInstant(ev({ occurred_at: "not-a-date", received_at: "also-bad" })), null);
});

test("eventRepo is project_path, then source_id, then null", () => {
  assert.equal(
    eventRepo(ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "sympoies/nils-cli" } })),
    "sympoies/nils-cli",
  );
  assert.equal(
    eventRepo(ev({ target: { kind: "repo", source_id: "github:github.com", project_path: null } })),
    "github:github.com",
  );
  assert.equal(eventRepo(ev({ target: null })), null);
});

test("countInWindow counts events within the trailing window, boundary inclusive", () => {
  const events = [
    ev({ received_at: at(0) }),
    ev({ received_at: at(30_000) }),
    ev({ received_at: at(59_999) }),
    ev({ received_at: at(60_000) }), // exactly at the edge — included
    ev({ received_at: at(61_000) }), // older — excluded
  ];
  assert.equal(countInWindow(events, NOW, 60_000), 4);
});

test("rateBuckets distributes events oldest-first; current bucket is last; out-of-window dropped", () => {
  // window = 10 buckets * 1000ms = 10s, start = NOW-10000 (exclusive)
  const events = [
    ev({ received_at: at(0) }), // current bucket (last)
    ev({ received_at: at(500) }), // still last bucket
    ev({ received_at: at(9_500) }), // oldest bucket (index 0)
    ev({ received_at: at(10_000) }), // == start, excluded
    ev({ received_at: at(20_000) }), // older, excluded
  ];
  const buckets = rateBuckets(events, NOW, 1000, 10);
  assert.equal(buckets.length, 10);
  assert.equal(buckets[9], 2); // the two near-now events
  assert.equal(buckets[0], 1); // the 9.5s-old event
  assert.equal(buckets.reduce((a, b) => a + b, 0), 3); // 2 dropped
});

test("bucketRange gives the [start,end] window of a rateBuckets index; last bucket ends at now", () => {
  const NOW2 = 5_000_000;
  const bucketMs = 1000;
  const count = 10;
  // The last bucket ends exactly at now and spans the trailing bucketMs.
  assert.deepEqual(bucketRange(NOW2, bucketMs, count, count - 1), { start: NOW2 - 1000, end: NOW2 });
  // The oldest bucket is the 5h-ago end of the window.
  assert.deepEqual(bucketRange(NOW2, bucketMs, count, 0), { start: NOW2 - 10_000, end: NOW2 - 9_000 });
  // Consistent with rateBuckets: an event that lands in bucket i (the 9.5s-old
  // case from the test above) falls inside bucketRange(i)'s window.
  const t = NOW2 - 9_500;
  const r0 = bucketRange(NOW2, bucketMs, count, 0);
  assert.ok(t > r0.start && t <= r0.end, "event instant falls within its bucket's range");
});

test("categoryCounts orders by the canonical order, only present categories", () => {
  const events = [
    ev({ category: "push" }),
    ev({ category: "push" }),
    ev({ category: "review" }),
    ev({ category: "comment" }),
  ];
  const order = ["push", "pull_request", "review", "comment", "issue"] as const;
  assert.deepEqual(categoryCounts(events, order), [
    { category: "push", count: 2 },
    { category: "review", count: 1 },
    { category: "comment", count: 1 },
  ]);
});

test("categoryCounts appends categories not in the canonical order by count desc", () => {
  const events = [
    ev({ category: "push" }),
    ev({ category: "deployment" }),
    ev({ category: "deployment" }),
    ev({ category: "wiki" }),
  ];
  const order = ["push"] as const;
  assert.deepEqual(categoryCounts(events, order), [
    { category: "push", count: 1 },
    { category: "deployment", count: 2 },
    { category: "wiki", count: 1 },
  ]);
});

test("distinctCount counts distinct non-empty keys", () => {
  const events = [
    ev({ actor: { login: "graysurf" } }),
    ev({ actor: { login: "graysurf" } }),
    ev({ actor: { login: "dobi-bot" } }),
    ev({ actor: { login: null } }),
    ev({ actor: null }),
  ];
  assert.equal(distinctCount(events, (e) => e.actor?.login), 2);
});

test("relativeAge renders compact units and clamps the future to 'now'", () => {
  assert.equal(relativeAge(NOW - 500, NOW), "now");
  assert.equal(relativeAge(NOW - 5_000, NOW), "5s");
  assert.equal(relativeAge(NOW - 90_000, NOW), "1m");
  assert.equal(relativeAge(NOW - 2 * 3_600_000, NOW), "2h");
  assert.equal(relativeAge(NOW - 50 * 3_600_000, NOW), "2d");
  assert.equal(relativeAge(NOW + 5_000, NOW), "now"); // clock skew → never negative
});

test("distinctValues returns sorted distinct non-empty keys (for the filter dropdowns)", () => {
  const events = [
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "o/zeta" } }),
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "o/alpha" } }),
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "o/zeta" } }),
    ev({ target: null }),
  ];
  assert.deepEqual(distinctValues(events, eventRepo), ["o/alpha", "o/zeta"]);
  assert.deepEqual(
    distinctValues([ev({ actor: { login: "bob" } }), ev({ actor: { login: null } })], (e) => e.actor?.login),
    ["bob"],
  );
});

test("eventMatchesFilters ANDs category (single) with repo + people (multi, empty = all)", () => {
  const e = ev({
    category: "review",
    actor: { login: "graysurf" },
    target: { kind: "change_request", source_id: "github:github.com", project_path: "o/repo" },
  });
  const none = { category: null, repos: new Set<string>(), people: new Set<string>() };
  // no filters → everything matches
  assert.equal(eventMatchesFilters(e, none), true);
  // category mismatch fails; match passes
  assert.equal(eventMatchesFilters(e, { ...none, category: "push" }), false);
  assert.equal(eventMatchesFilters(e, { ...none, category: "review" }), true);
  // repo / people multi-select: present in the set passes, absent fails
  assert.equal(eventMatchesFilters(e, { ...none, repos: new Set(["o/repo"]) }), true);
  assert.equal(eventMatchesFilters(e, { ...none, repos: new Set(["o/other"]) }), false);
  assert.equal(eventMatchesFilters(e, { ...none, people: new Set(["graysurf"]) }), true);
  assert.equal(eventMatchesFilters(e, { ...none, people: new Set(["someone"]) }), false);
  // all three together must all pass
  assert.equal(
    eventMatchesFilters(e, { category: "review", repos: new Set(["o/repo"]), people: new Set(["graysurf"]) }),
    true,
  );
  assert.equal(
    eventMatchesFilters(e, { category: "review", repos: new Set(["o/repo"]), people: new Set(["someone"]) }),
    false,
  );
});

test("people filter matches a login-less commit author by display_name", () => {
  // A pushed commit whose author email GitHub could not map to an account has a
  // display_name but no login. It shows in the feed (via the row title) but, if
  // the people key is login-only, it cannot be filtered and is absent from the
  // People options/count. The people key must fall back to display_name.
  const commitAuthor = ev({
    category: "commit",
    actor: { login: null, display_name: "Robo Committer" },
  });
  const none = { category: null, repos: new Set<string>(), people: new Set<string>() };
  assert.equal(eventMatchesFilters(commitAuthor, none), true, "no filter → matches");
  assert.equal(
    eventMatchesFilters(commitAuthor, { ...none, people: new Set(["Robo Committer"]) }),
    true,
    "filterable by the display name when login is absent",
  );
  assert.equal(
    eventMatchesFilters(commitAuthor, { ...none, people: new Set(["someone-else"]) }),
    false,
    "a non-matching display name still excludes it",
  );
});

test("actorKey backs the people options/count with a display_name fallback", () => {
  // Options, count, and the filter all key off actorKey, so a login-less commit
  // author surfaces as a People option (and is counted) under its display_name.
  assert.equal(actorKey(ev({ actor: { login: "graysurf", display_name: "Gray Surf" } })), "graysurf");
  assert.equal(actorKey(ev({ actor: { login: null, display_name: "Robo Committer" } })), "Robo Committer");
  assert.equal(actorKey(ev({ actor: { login: null, display_name: null } })), null);
  assert.equal(actorKey(ev({ actor: null })), null);
  const events = [
    ev({ actor: { login: "graysurf" } }),
    ev({ actor: { login: null, display_name: "Robo Committer" } }),
    ev({ actor: { login: null, display_name: null } }),
  ];
  assert.deepEqual(distinctValues(events, actorKey), ["graysurf", "Robo Committer"]);
  assert.equal(distinctCount(events, actorKey), 2);
});

test("actorActivityRanks counts the retained buffer by actor, sorted busiest first", () => {
  const events = [
    ev({ actor: { login: "beta", avatar_url: null, profile_url: null } }),
    ev({ actor: { login: "alpha", display_name: "Alpha User", avatar_url: "https://example.test/a.png", profile_url: "https://example.test/alpha" } }),
    ev({ actor: { login: "beta", display_name: "Beta User", avatar_url: "https://example.test/b.png" } }),
    ev({ actor: { login: "beta" } }),
    ev({ actor: { login: "alpha" } }),
    ev({ actor: null }),
  ];
  const ranks = actorActivityRanks(events, 2);
  assert.deepEqual(
    ranks.map((rank) => [rank.label, rank.count, rank.actor?.avatar_url ?? null]),
    [
      ["Beta User", 3, "https://example.test/b.png"],
      ["Alpha User", 2, "https://example.test/a.png"],
    ],
  );
});

test("actorActivityRanks separates identical logins across sources", () => {
  // Two providers can mint the same login. They are distinct people and must not
  // be merged into one bar with whichever avatar/profile happened to win.
  const events = [
    ev({ source_id: "github:github.com", provider: "github", actor: { login: "alice", profile_url: "https://github.com/alice" } }),
    ev({ source_id: "github:github.com", provider: "github", actor: { login: "alice", profile_url: "https://github.com/alice" } }),
    ev({ source_id: "gitlab:gitlab.com", provider: "gitlab", actor: { login: "alice", profile_url: "https://gitlab.com/alice" } }),
  ];
  const ranks = actorActivityRanks(events, 5);
  assert.equal(ranks.length, 2, "same login on two sources stays two distinct people");
  assert.deepEqual(
    ranks.map((rank) => [rank.label, rank.count, rank.actor?.profile_url ?? null]),
    [
      ["alice", 2, "https://github.com/alice"],
      ["alice", 1, "https://gitlab.com/alice"],
    ],
  );
});

test("repoActivityRanks counts buffer events by repo, sorted by count then name", () => {
  const events = [
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "o/zeta" } }),
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "o/alpha" } }),
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "o/zeta" } }),
    ev({ target: { kind: "repo", source_id: "github:github.com", project_path: null } }),
    ev({ target: { kind: "repo", source_id: "github:github.com", project_path: null } }),
    ev({ target: null }),
  ];
  assert.deepEqual(
    repoActivityRanks(events).map((rank) => [rank.label, rank.count]),
    [
      ["github:github.com", 2],
      ["o/zeta", 2],
      ["o/alpha", 1],
    ],
  );
});

test("repoActivityRanks separates an identical project_path across sources", () => {
  // A GitHub repo and a GitLab mirror can share `owner/repo`. They are different
  // repos and must rank as two bars, not be merged into one (source_id, path) bucket.
  const events = [
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "owner/repo" } }),
    ev({ target: { kind: "issue", source_id: "github:github.com", project_path: "owner/repo" } }),
    ev({ target: { kind: "issue", source_id: "gitlab:gitlab.com", project_path: "owner/repo" } }),
  ];
  const ranks = repoActivityRanks(events, 5);
  assert.equal(ranks.length, 2, "same project_path on two sources stays two distinct repos");
  assert.deepEqual(
    ranks.map((rank) => [rank.label, rank.count]),
    [
      ["owner/repo", 2],
      ["owner/repo", 1],
    ],
  );
  // The grouping keys differ even though the labels match.
  assert.notEqual(ranks[0]!.key, ranks[1]!.key, "the rank keys must be source-scoped");
});

test("LIVE_CATEGORY_ORDER is the canonical provider-neutral filter order", () => {
  assert.deepEqual([...LIVE_CATEGORY_ORDER], [
    "commit",
    "change_request",
    "issue",
    "review",
    "review_comment",
    "review_thread",
    "comment",
    "pipeline",
  ]);
});

test("humanizeCategory turns the snake_case category into a display label", () => {
  assert.equal(humanizeCategory("change_request"), "change request");
  assert.equal(humanizeCategory("review_thread"), "review thread");
  assert.equal(humanizeCategory("commit"), "commit");
});

test("visibleByCategory drops events whose category the viewer has hidden", () => {
  const events = [
    ev({ category: "commit" }),
    ev({ category: "review" }),
    ev({ category: "comment" }),
    ev({ category: "commit" }),
  ];
  // Empty hidden set → everything visible (and the SAME array reference, so the
  // common no-filter case allocates nothing).
  assert.equal(visibleByCategory(events, new Set()), events);
  // Hiding a category removes exactly its events, order preserved.
  assert.deepEqual(
    visibleByCategory(events, new Set(["commit"])).map((e) => e.category),
    ["review", "comment"],
  );
  // Hiding several leaves only the rest.
  assert.deepEqual(
    visibleByCategory(events, new Set(["commit", "comment"])).map((e) => e.category),
    ["review"],
  );
  // A hidden category that is not present is a no-op.
  assert.equal(visibleByCategory(events, new Set(["pipeline"])).length, 4);
});
