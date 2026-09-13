import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityDTO } from "@symphony-board/contract";
import { countsByDay, countsByHour, rankActors, rankRepos, shortRepoLabel } from "../src/rail-stats.ts";

function activity(over: Partial<ActivityDTO>): ActivityDTO {
  return {
    source_id: "gh",
    external_id: "x",
    kind: "commit",
    action: "committed",
    project_path: "acme/api",
    target_kind: null,
    target_ref: null,
    target_iid: null,
    title: null,
    url: null,
    actor: "ada",
    occurred_at: "2026-09-10T12:00:00Z",
    details: null,
    first_seen_at: null,
    last_seen_at: null,
    ...over,
  };
}

test("rankActors orders by count and truncates to the limit", () => {
  const rows = rankActors(
    [
      ...Array.from({ length: 3 }, () => activity({ actor: "ada" })),
      ...Array.from({ length: 5 }, () => activity({ actor: "grace" })),
      activity({ actor: "linus" }),
    ],
    2,
  );
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [["grace", 5], ["ada", 3]]);
});

test("rankActors drops unattributed rows rather than inventing a contributor", () => {
  const rows = rankActors(
    [activity({ actor: null }), activity({ actor: "   " }), activity({ actor: "ada" })],
    5,
  );
  assert.deepEqual(rows.map((r) => r.label), ["ada"]);
});

test("rankActors breaks ties on the label so ranking is stable", () => {
  const forward = rankActors([activity({ actor: "zoe" }), activity({ actor: "ada" })], 5);
  const reverse = rankActors([activity({ actor: "ada" }), activity({ actor: "zoe" })], 5);
  assert.deepEqual(forward.map((r) => r.label), ["ada", "zoe"]);
  assert.deepEqual(forward, reverse, "insertion order must not change the ranking");
});

test("rankRepos keeps the same path on two sources as two rows", () => {
  const rows = rankRepos(
    [
      activity({ source_id: "gh", project_path: "acme/api" }),
      activity({ source_id: "gh", project_path: "acme/api" }),
      activity({ source_id: "gl", project_path: "acme/api" }),
    ],
    5,
  );
  // Identity is (source_id, project_path); collapsing them would merge two
  // different repositories that happen to share a path.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.key, r.count]), [["gh|acme/api", 2], ["gl|acme/api", 1]]);
  assert.deepEqual(rows.map((r) => r.label), ["acme/api", "acme/api"]);
});

test("rankRepos skips rows with no repository", () => {
  const rows = rankRepos([activity({ project_path: null }), activity({ project_path: "acme/api" })], 5);
  assert.deepEqual(rows.map((r) => r.label), ["acme/api"]);
});

test("countsByHour always returns 24 zero-filled buckets in the viewer's zone", () => {
  const rows = countsByHour([activity({ occurred_at: "2026-09-10T12:00:00Z" })], "UTC");
  assert.equal(rows.length, 24);
  assert.deepEqual(rows.map((r) => r.hour), Array.from({ length: 24 }, (_, i) => i));
  assert.equal(rows[12].count, 1);
  assert.equal(rows.reduce((sum, r) => sum + r.count, 0), 1);
});

test("countsByHour buckets by the viewer's zone, not UTC", () => {
  // 23:00 UTC is 08:00 the next morning in Taipei: the whole point of the panel
  // is when the viewer was working, so the bucket must follow the zone.
  const utc = countsByHour([activity({ occurred_at: "2026-09-10T23:00:00Z" })], "UTC");
  const taipei = countsByHour([activity({ occurred_at: "2026-09-10T23:00:00Z" })], "Asia/Taipei");
  assert.equal(utc[23].count, 1);
  assert.equal(taipei[7].count, 1);
});

test("countsByHour ignores unparseable timestamps", () => {
  const rows = countsByHour([activity({ occurred_at: "not-a-date" }), activity({})], "UTC");
  assert.equal(rows.reduce((sum, r) => sum + r.count, 0), 1);
});

test("countsByDay zero-fills the selected span so quiet days stay visible", () => {
  const rows = countsByDay(
    [activity({ occurred_at: "2026-09-07T01:00:00Z" }), activity({ occurred_at: "2026-09-09T01:00:00Z" })],
    "UTC",
    "2026-09-07",
    "2026-09-10",
  );
  assert.deepEqual(rows, [
    { date: "2026-09-07", count: 1 },
    { date: "2026-09-08", count: 0 },
    { date: "2026-09-09", count: 1 },
    { date: "2026-09-10", count: 0 },
  ]);
});

test("countsByDay spans the range, not the data", () => {
  // A range wider than the events must still render its full width, or a 1w
  // selection with two busy days would draw as if the week were two days long.
  const rows = countsByDay([activity({ occurred_at: "2026-09-09T01:00:00Z" })], "UTC", "2026-09-07", "2026-09-13");
  assert.equal(rows.length, 7);
  assert.equal(rows.reduce((sum, r) => sum + r.count, 0), 1);
});

test("countsByDay returns nothing for an inverted or unparseable span", () => {
  assert.deepEqual(countsByDay([], "UTC", "2026-09-13", "2026-09-07"), []);
  assert.deepEqual(countsByDay([], "UTC", "nope", "2026-09-07"), []);
});

test("countsByDay counts a day boundary in the viewer's zone", () => {
  // 22:00 UTC on the 9th is already the 10th in Taipei.
  const rows = countsByDay([activity({ occurred_at: "2026-09-09T22:00:00Z" })], "Asia/Taipei", "2026-09-09", "2026-09-10");
  assert.deepEqual(rows, [
    { date: "2026-09-09", count: 0 },
    { date: "2026-09-10", count: 1 },
  ]);
});

test("limit 0 returns the full ranking, which is what the rail 'N total' headers count", () => {
  // Both rails render their header as rankX(source, 0).length. If this ever
  // became an unconditional slice(0, limit) every header would silently read
  // "0 total" with the rest of the suite green.
  const rows = [
    activity({ actor: "ada", project_path: "acme/api" }),
    activity({ actor: "grace", project_path: "acme/web" }),
    activity({ actor: "linus", project_path: "acme/cli" }),
    activity({ actor: "ada", project_path: "acme/api" }),
  ];
  assert.equal(rankActors(rows, 0).length, 3);
  assert.equal(rankRepos(rows, 0).length, 3);
  // And a limit still truncates, so 0 is the special case rather than the rule.
  assert.equal(rankActors(rows, 2).length, 2);
  assert.equal(rankRepos(rows, 2).length, 2);
});

test("shortRepoLabel keeps the identifying half of a path", () => {
  assert.equal(shortRepoLabel("sympoies/symphony-board"), "symphony-board");
  assert.equal(shortRepoLabel("group/sub/project"), "project");
  assert.equal(shortRepoLabel("standalone"), "standalone");
  assert.equal(shortRepoLabel(""), "");
});
