import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityDTO, ReviewThreadDTO } from "@symphony-board/contract";
import {
  actorAvatarIndex,
  actorDetails,
  actorIndex,
  actorsOf,
  branchDetails,
  churnByDay,
  commitAuthorOptions,
  commitScopeOf,
  commitSizeSummary,
  commitTypeOf,
  countsByDay,
  countsByHour,
  dayAxisTicks,
  largestCommits,
  punchCard,
  rankActions,
  rankActors,
  rankBranches,
  rankCommitScopes,
  rankCommitTypes,
  rankKinds,
  rankRepos,
  repoDetails,
  shortRepoLabel,
  sparkBuckets,
  stackedDays,
} from "../src/rail-stats.ts";

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

test("rankBranches counts a commit once per branch it belongs to", () => {
  const rows = rankBranches(
    [
      activity({ details: { branches: ["main", "release"] } }),
      activity({ details: { branch: "main" } }),
      activity({ details: { ref: "refs/heads/feature/x" } }),
    ],
    5,
  );
  // The first commit is on two branches, so it contributes to both — the number
  // beside a branch is "commits on this branch", not a partition of the range.
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [["main", 2], ["feature/x", 1], ["release", 1]]);
});

test("rankBranches ignores commits with no branch refs", () => {
  assert.deepEqual(rankBranches([activity({ details: null }), activity({ details: {} })], 5), []);
});

test("commitTypeOf reads the conventional-commit prefix", () => {
  assert.equal(commitTypeOf("feat: add a rail"), "feat");
  assert.equal(commitTypeOf("fix(ui): repair the split"), "fix");
  assert.equal(commitTypeOf("feat(api)!: breaking change"), "feat");
  assert.equal(commitTypeOf("CHORE: shouty but still conventional"), "chore");
});

test("commitTypeOf buckets anything unconventional as other rather than dropping it", () => {
  // A provider-neutral board cannot assume the convention. A repo that does not
  // use it must show one honest "other" bar, not an empty panel implying there
  // was nothing to measure.
  assert.equal(commitTypeOf("Merge pull request #12 from x"), "other");
  assert.equal(commitTypeOf("update readme"), "other");
  assert.equal(commitTypeOf(""), "other");
  // A colon alone is not enough — the prefix has to look like a type token.
  assert.equal(commitTypeOf("WIP stuff: more"), "other");
  assert.equal(commitTypeOf("feat:no-space"), "other");
});

test("rankCommitTypes ranks by type over the visible rows", () => {
  const rows = rankCommitTypes(
    [
      activity({ title: "feat: one" }),
      activity({ title: "feat: two" }),
      activity({ title: "fix: three" }),
      activity({ title: "random message" }),
    ],
    5,
  );
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [["feat", 2], ["fix", 1], ["other", 1]]);
});

test("rankKinds and rankActions count the vocabulary the filter chips use", () => {
  const rows = [
    activity({ kind: "commit", action: "committed" }),
    activity({ kind: "commit", action: "committed" }),
    activity({ kind: "change_request", action: "merged" }),
    activity({ kind: "review", action: "approved" }),
  ];
  assert.deepEqual(rankKinds(rows, 5).map((r) => [r.label, r.count]), [["commit", 2], ["change_request", 1], ["review", 1]]);
  assert.deepEqual(rankActions(rows, 5).map((r) => [r.label, r.count]), [["committed", 2], ["approved", 1], ["merged", 1]]);
  assert.equal(rankKinds(rows, 0).length, 3, "limit 0 backs the 'N kinds' header");
});

function thread(comments: Array<{ author: string | null; avatar_url?: string | null }>): ReviewThreadDTO {
  return {
    id: "gh|t1",
    source_id: "gh",
    external_id: "t1",
    project_path: "acme/api",
    target_ref: "gh|1",
    target_iid: 1,
    title: null,
    url: null,
    is_resolved: false,
    is_outdated: null,
    resolved_by: null,
    path: null,
    line: null,
    start_line: null,
    comments_total: comments.length,
    comments: comments.map((c, i) => ({
      id: `c${i}`,
      author: c.author,
      avatar_url: c.avatar_url,
      body: null,
      url: null,
      created_at: null,
      updated_at: null,
    })),
  } as ReviewThreadDTO;
}

test("actorAvatarIndex maps a login to the first avatar the contract carries", () => {
  const index = actorAvatarIndex([
    thread([{ author: "ada", avatar_url: "https://img/ada.png" }, { author: "grace", avatar_url: "https://img/grace.png" }]),
  ]);
  assert.equal(index.get("ada"), "https://img/ada.png");
  assert.equal(index.get("grace"), "https://img/grace.png");
  assert.equal(index.size, 2);
});

test("actorAvatarIndex keeps the first URL for a login rather than the last", () => {
  // Stable across re-renders: a later comment must not swap the face mid-session.
  const index = actorAvatarIndex([
    thread([{ author: "ada", avatar_url: "https://img/first.png" }, { author: "ada", avatar_url: "https://img/second.png" }]),
  ]);
  assert.equal(index.get("ada"), "https://img/first.png");
});

test("actorAvatarIndex skips comments with no author or no avatar", () => {
  // avatar_url is optional-and-nullable in the contract (4.2.0 additive field),
  // so a pre-4.2.0 comment simply contributes nothing and the actor falls back
  // to initials.
  const index = actorAvatarIndex([
    thread([
      { author: null, avatar_url: "https://img/x.png" },
      { author: "ada" },
      { author: "grace", avatar_url: null },
      { author: "  ", avatar_url: "https://img/y.png" },
      { author: "linus", avatar_url: "  " },
    ]),
  ]);
  assert.equal(index.size, 0);
});

test("actorAvatarIndex tolerates a thread with no comments array", () => {
  const bare = { ...thread([]), comments: undefined } as unknown as ReviewThreadDTO;
  assert.equal(actorAvatarIndex([bare]).size, 0);
});

test("actorAvatarIndex maps a provider event photo to the merged author name", () => {
  const index = actorAvatarIndex(
    [],
    [activity({ source_id: "gl", actor: "terrylin", kind: "branch", details: { actor_avatar_url: "https://gitlab.example/uploads/terry.png" } })],
    actorIndex({ identities: [{ name: "Terry LIN", actors: ["terrylin", "Terry LIN"], bot: false }] }),
  );
  assert.equal(index.get("Terry LIN"), "https://gitlab.example/uploads/terry.png");
});

test("actorAvatarIndex uses review photos for merged names when events have none", () => {
  const index = actorAvatarIndex(
    [thread([{ author: "terrylin", avatar_url: "https://gitlab.example/uploads/terry.png" }])],
    [activity({ actor: "Terry LIN", details: null })],
    actorIndex({ identities: [{ name: "Terry LIN", actors: ["terrylin", "Terry LIN"], bot: false }] }),
  );
  assert.equal(index.get("Terry LIN"), "https://gitlab.example/uploads/terry.png");
});

test("actorAvatarIndex skips unsafe event URLs so a valid review photo can win", () => {
  const index = actorAvatarIndex(
    [thread([{ author: "ada", avatar_url: "https://img/ada.png" }])],
    [activity({ actor: "ada", details: { actor_avatar_url: "javascript:alert(1)" } })],
  );
  assert.equal(index.get("ada"), "https://img/ada.png");
});

const directory = {
  identities: [
    { name: "terrylin", actors: ["Terry LIN", "Terry LIN 林品澄", "terrylin"], bot: false },
    { name: "ada", actors: ["ada"], bot: false },
    { name: "dependabot", actors: ["dependabot"], bot: true },
    // Two entries sharing a display name: distinct producer identities the
    // config had no bridge for. The ranking counts them as one row.
    { name: "semantic-release", actors: ["semantic-release"], bot: true },
    { name: "semantic-release", actors: ["semantic-release-ci"], bot: true },
  ],
};

test("rankActors merges a person’s facets into one row and drops bots", () => {
  const rows = rankActors(
    [
      activity({ actor: "Terry LIN" }),
      activity({ actor: "Terry LIN 林品澄" }),
      activity({ actor: "terrylin" }),
      activity({ actor: "ada" }),
      activity({ actor: "dependabot" }),
      activity({ actor: "semantic-release" }),
    ],
    5,
    actorIndex(directory),
  );
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [["terrylin", 3], ["ada", 1]]);
});

test("commitAuthorOptions merges facets like the ranking but KEEPS bot accounts", () => {
  // The rail ranks people, so a CI account is noise there. The toolbar filter
  // is a picker: dropping bots would leave their rows visible in the list with
  // no way to select them.
  const rows = commitAuthorOptions(
    [
      activity({ actor: "Terry LIN" }),
      activity({ actor: "terrylin" }),
      activity({ actor: "ada" }),
      activity({ actor: "dependabot" }),
      activity({ actor: "dependabot" }),
      activity({ actor: " " }),
      activity({ actor: null }),
    ],
    actorIndex(directory),
  );
  assert.deepEqual(
    rows.map((r) => [r.author, r.count]),
    [["dependabot", 2], ["terrylin", 2], ["ada", 1]],
    "count desc, then name; unattributed rows are not a person and are dropped",
  );
});

test("commitAuthorOptions is unlimited, unlike the ranked rail list", () => {
  const rows = commitAuthorOptions(
    Array.from({ length: 12 }, (_, i) => activity({ actor: `dev-${i}` })),
  );
  assert.equal(rows.length, 12, "a picker that omits the author you want is worse than a long list");
});

test("rankActors without a directory keeps the raw strings (pre-4.7.0 contract)", () => {
  const rows = rankActors([activity({ actor: "Terry LIN" }), activity({ actor: "terrylin" })], 5);
  assert.deepEqual(rows.map((r) => r.label).sort(), ["Terry LIN", "terrylin"]);
});

test("actorIndex ignores an absent directory rather than throwing", () => {
  const index = actorIndex(null);
  assert.equal(index.canonical.size, 0);
  assert.equal(index.bots.size, 0);
});

test("actorsOf resolves a ranked row back to every raw actor it covers", () => {
  assert.deepEqual(actorsOf(directory, "terrylin"), ["Terry LIN", "Terry LIN 林品澄", "terrylin"]);
  // Both entries, not just the first: the row the viewer clicked counted both.
  assert.deepEqual(actorsOf(directory, "semantic-release"), ["semantic-release", "semantic-release-ci"]);
  // An unknown name filters by itself, which is what a pre-4.7.0 payload needs.
  assert.deepEqual(actorsOf(directory, "nobody"), ["nobody"]);
  assert.deepEqual(actorsOf(null, "ada"), ["ada"]);
});

test("dayAxisTicks labels every day of a short range and only the ends of a long one", () => {
  const span = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), count: i }));

  // A week: one label per bar, so each bar can be read against its own date.
  assert.deepEqual(dayAxisTicks(span(7)).map((t) => t.label), ["09-01", "09-02", "09-03", "09-04", "09-05", "09-06", "09-07"]);
  assert.deepEqual(dayAxisTicks(span(7)).map((t) => t.index), [0, 1, 2, 3, 4, 5, 6]);

  // A month: thirty labels would collide, so only the ends and the middle stay.
  assert.deepEqual(dayAxisTicks(span(30)), [
    { index: 0, label: "09-01" },
    { index: 14, label: "09-15" },
    { index: 29, label: "09-30" },
  ]);

  assert.deepEqual(dayAxisTicks(span(1)), [{ index: 0, label: "09-01" }]);
  assert.deepEqual(dayAxisTicks([]), []);
});

// ---- wide-panes aggregates ---------------------------------------------------

const sized = (over: Partial<ActivityDTO>, additions?: number, deletions?: number): ActivityDTO =>
  activity({ ...over, details: { ...(over.details ?? {}), ...(additions === undefined ? {} : { additions, deletions }) } });

test("stackedDays keeps the top series, folds the rest into one bucket, and zero-fills the span", () => {
  const typeOf = (a: ActivityDTO) => {
    const type = commitTypeOf(a.title ?? "");
    return { key: type, label: type };
  };
  const rows = [
    ...Array.from({ length: 4 }, () => activity({ title: "fix: a", occurred_at: "2026-09-01T10:00:00Z" })),
    ...Array.from({ length: 3 }, () => activity({ title: "feat: b", occurred_at: "2026-09-01T11:00:00Z" })),
    ...Array.from({ length: 2 }, () => activity({ title: "docs: c", occurred_at: "2026-09-03T11:00:00Z" })),
    activity({ title: "ci: d", occurred_at: "2026-09-03T12:00:00Z" }),
    activity({ title: "not conventional", occurred_at: "2026-09-03T12:00:00Z" }),
  ];

  const stack = stackedDays(rows, "UTC", "2026-09-01", "2026-09-03", typeOf, 2);

  // Two named series by total, then ONE fold. The unparsed type is itself called
  // "other", and must land in the fold rather than beside it as a second "other".
  assert.deepEqual(stack.series, [
    { key: "fix", label: "fix", count: 4 },
    { key: "feat", label: "feat", count: 3 },
    { key: "other", label: "other", count: 4 },
  ]);
  assert.deepEqual(stack.days, [
    { date: "2026-09-01", total: 7, segments: [4, 3, 0] },
    { date: "2026-09-02", total: 0, segments: [0, 0, 0] },
    { date: "2026-09-03", total: 4, segments: [0, 0, 4] },
  ]);
  assert.equal(stack.max, 7);
  // Every day's segments add up to its total: nothing is dropped by the fold.
  for (const day of stack.days) assert.equal(day.segments.reduce((a, b) => a + b, 0), day.total);
});

test("stackedDays keeps a key that is literally the fold's out of the named series", () => {
  // The common real case: unconventional subjects outnumber every type, so
  // "other" would rank FIRST among the named series. It must still be the one
  // trailing fold -- kept as a named series it would be drawn twice, once under
  // its own colour and once as the fold, with the same key and the same name.
  const typeOf = (a: ActivityDTO) => {
    const type = commitTypeOf(a.title ?? "");
    return { key: type, label: type };
  };
  const rows = [
    ...Array.from({ length: 5 }, () => activity({ title: "plain subject" })),
    ...Array.from({ length: 3 }, () => activity({ title: "fix: a" })),
    activity({ title: "feat: b" }),
  ];
  const stack = stackedDays(rows, "UTC", "2026-09-10", "2026-09-10", typeOf, 4);
  assert.deepEqual(stack.series, [
    { key: "fix", label: "fix", count: 3 },
    { key: "feat", label: "feat", count: 1 },
    { key: "other", label: "other", count: 5 },
  ]);
  assert.deepEqual(stack.days[0]?.segments, [3, 1, 5]);
  assert.equal(new Set(stack.series.map((s) => s.key)).size, stack.series.length, "series keys are unique");
});

test("stackedDays adds no fold when every key fits", () => {
  const stack = stackedDays(
    [activity({ title: "fix: a" }), activity({ title: "feat: b" })],
    "UTC", "2026-09-10", "2026-09-10",
    (a) => ({ key: commitTypeOf(a.title ?? ""), label: commitTypeOf(a.title ?? "") }),
    4,
  );
  assert.deepEqual(stack.series.map((s) => s.key), ["feat", "fix"]);
  assert.deepEqual(stack.days[0]?.segments, [1, 1]);
});

test("churnByDay sums line counts per day and counts only the commits that carry them", () => {
  const rows = [
    sized({ occurred_at: "2026-09-01T10:00:00Z" }, 10, 4),
    sized({ occurred_at: "2026-09-01T12:00:00Z" }, 5, 0),
    // A merge, or a commit the producer could not read: no counts at all.
    activity({ occurred_at: "2026-09-01T13:00:00Z" }),
    sized({ occurred_at: "2026-09-02T09:00:00Z" }, 0, 7),
  ];
  assert.deepEqual(churnByDay(rows, "UTC", "2026-09-01", "2026-09-03"), [
    { date: "2026-09-01", additions: 15, deletions: 4, counted: 2, commits: 3 },
    { date: "2026-09-02", additions: 0, deletions: 7, counted: 1, commits: 1 },
    { date: "2026-09-03", additions: 0, deletions: 0, counted: 0, commits: 0 },
  ]);
});

test("punchCard draws one row per day for a short range", () => {
  const rows = [
    activity({ occurred_at: "2026-09-24T21:10:00Z" }),
    activity({ occurred_at: "2026-09-24T21:50:00Z" }),
    activity({ occurred_at: "2026-09-25T03:00:00Z" }),
  ];
  const card = punchCard(rows, "UTC", "2026-09-24", "2026-09-26");
  assert.equal(card.byWeekday, false);
  assert.deepEqual(card.rows.map((r) => [r.key, r.weekday, r.total]), [
    ["2026-09-24", "Thu", 2],
    ["2026-09-25", "Fri", 1],
    ["2026-09-26", "Sat", 0],
  ]);
  assert.equal(card.rows[0]?.hours.length, 24);
  assert.equal(card.rows[0]?.hours[21], 2);
  assert.equal(card.max, 2);
  assert.deepEqual(card.peak, { key: "2026-09-24", weekday: "Thu", hour: 21, count: 2 });
});

test("punchCard folds a long range onto the seven weekdays, Monday first", () => {
  const rows = [
    activity({ occurred_at: "2026-09-07T09:00:00Z" }), // Mon
    activity({ occurred_at: "2026-09-14T09:30:00Z" }), // Mon
    activity({ occurred_at: "2026-09-13T23:00:00Z" }), // Sun
  ];
  const card = punchCard(rows, "UTC", "2026-09-01", "2026-09-30");
  assert.equal(card.byWeekday, true);
  assert.deepEqual(card.rows.map((r) => r.weekday), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(card.rows[0]?.hours[9], 2);
  assert.equal(card.rows[6]?.hours[23], 1);
  assert.deepEqual(card.peak, { key: "Mon", weekday: "Mon", hour: 9, count: 2 });
});

test("punchCard has no peak when nothing landed in the range", () => {
  assert.equal(punchCard([], "UTC", "2026-09-01", "2026-09-02").peak, null);
});

test("largestCommits ranks by lines changed and skips commits without counts", () => {
  const rows = [
    sized({ external_id: "small" }, 1, 1),
    sized({ external_id: "big" }, 400, 90),
    activity({ external_id: "merge" }),
    sized({ external_id: "mid", occurred_at: "2026-09-10T12:00:00Z" }, 30, 20),
    // Same size as `mid` but newer: the newer one leads.
    sized({ external_id: "mid-newer", occurred_at: "2026-09-11T12:00:00Z" }, 25, 25),
  ];
  const top = largestCommits(rows, 3);
  assert.deepEqual(top.map((t) => [t.commit.external_id, t.lines]), [["big", 490], ["mid-newer", 50], ["mid", 50]]);
  assert.deepEqual([top[0]?.additions, top[0]?.deletions], [400, 90]);
  assert.equal(largestCommits(rows, 0).length, 4, "0 means no limit, like the rankings");
});

test("commitSizeSummary reports the middle and the largest of the commits that carry counts", () => {
  assert.deepEqual(commitSizeSummary([sized({}, 100, 100), sized({}, 1, 1), sized({}, 10, 0), activity({})]), {
    median: 10,
    largest: 200,
  });
  assert.deepEqual(commitSizeSummary([activity({})]), { median: null, largest: null }, "no counts, no figures");
});

test("sparkBuckets keeps a bar per day while they fit and sums runs of days beyond that", () => {
  // Within the budget: untouched, one bar per day.
  assert.deepEqual(sparkBuckets([1, 0, 2], 30), [1, 0, 2]);
  // Beyond it: the bar count is the budget, whatever the range, and nothing is
  // lost -- the buckets add up to the series.
  const year = Array.from({ length: 365 }, (_, i) => (i % 7 === 0 ? 3 : 1));
  const bars = sparkBuckets(year, 30);
  assert.equal(bars.length, 30);
  assert.equal(bars.reduce((a, b) => a + b, 0), year.reduce((a, b) => a + b, 0));
  // Runs, in order: the first six days land in the first of three bars.
  assert.deepEqual(sparkBuckets([1, 1, 1, 1, 1, 1, 5, 5, 5], 3), [3, 3, 15]);
  assert.deepEqual(sparkBuckets([], 30), []);
});

test("commitScopeOf reads the conventional-commit scope and nothing else", () => {
  assert.equal(commitScopeOf("fix(agent-session): recover sessions"), "agent-session");
  assert.equal(commitScopeOf("feat(UI)!: breaking"), "ui");
  assert.equal(commitScopeOf("fix: no scope"), null);
  assert.equal(commitScopeOf("Update (notes): not conventional"), null);
  assert.equal(commitScopeOf("chore(): empty"), null);
});

test("rankCommitScopes counts scoped commits only", () => {
  const rows = [
    activity({ title: "fix(ui): a" }),
    activity({ title: "feat(ui): b" }),
    activity({ title: "fix(api): c" }),
    activity({ title: "docs: d" }),
  ];
  assert.deepEqual(rankCommitScopes(rows, 5), [
    { key: "ui", label: "ui", count: 2 },
    { key: "api", label: "api", count: 1 },
  ]);
});

test("actorDetails merges identities and reports lines, repos, active days and a per-day series", () => {
  const index = actorIndex(directory);
  const rows = [
    sized({ actor: "terrylin", project_path: "acme/api", occurred_at: "2026-09-01T10:00:00Z" }, 10, 2),
    sized({ actor: "Terry LIN", project_path: "acme/web", occurred_at: "2026-09-03T10:00:00Z" }, 5, 5),
    activity({ actor: "terrylin", project_path: "acme/api", occurred_at: "2026-09-03T11:00:00Z" }),
    sized({ actor: "ada", occurred_at: "2026-09-02T10:00:00Z" }, 1, 0),
  ];
  const details = actorDetails(rows, index, "UTC", "2026-09-01", "2026-09-03");
  assert.deepEqual(details.get("terrylin"), {
    additions: 15,
    deletions: 7,
    counted: 2,
    repos: 2,
    activeDays: 2,
    perDay: [1, 0, 2],
  });
  assert.deepEqual(details.get("ada")?.perDay, [0, 1, 0]);
  assert.equal(details.has("Terry LIN"), false, "a facet is not a second person");
});

test("repoDetails counts distinct people and keeps the newest commit instant", () => {
  const index = actorIndex(directory);
  const rows = [
    activity({ actor: "terrylin", occurred_at: "2026-09-01T10:00:00Z" }),
    activity({ actor: "Terry LIN", occurred_at: "2026-09-04T10:00:00Z" }),
    activity({ actor: "ada", occurred_at: "2026-09-02T10:00:00Z" }),
    activity({ actor: "ada", source_id: "gl", occurred_at: "2026-09-03T10:00:00Z" }),
  ];
  const details = repoDetails(rows, index);
  assert.deepEqual(details.get("gh|acme/api"), { authors: 2, lastAt: "2026-09-04T10:00:00Z" });
  assert.deepEqual(details.get("gl|acme/api"), { authors: 1, lastAt: "2026-09-03T10:00:00Z" });
});

test("branchDetails counts the repositories a branch name appears in", () => {
  const rows = [
    activity({ project_path: "acme/api", details: { branch: "main" } }),
    activity({ project_path: "acme/web", details: { branch: "main" } }),
    activity({ project_path: "acme/web", details: { branch: "feat/x" } }),
  ];
  const details = branchDetails(rows);
  assert.deepEqual(details.get("main"), { repos: 2 });
  assert.deepEqual(details.get("feat/x"), { repos: 1 });
});

test("a row's zoned day is remembered per zone, not across zones", () => {
  // The per-row day and hour are cached on the row object, because the wide
  // Commits tier asks for them seven times over. 20:30 UTC is already the next
  // day in Taipei, so reusing the UTC answer for the second zone would put the
  // commit on the wrong bar -- and asking for UTC again afterwards must not get
  // the Taipei one back.
  const rows = [activity({ occurred_at: "2026-09-10T20:30:00Z" })];
  assert.deepEqual(countsByDay(rows, "UTC", "2026-09-10", "2026-09-11").map((d) => d.count), [1, 0]);
  assert.deepEqual(countsByDay(rows, "Asia/Taipei", "2026-09-10", "2026-09-11").map((d) => d.count), [0, 1]);
  assert.equal(countsByHour(rows, "Asia/Taipei")[4]?.count, 1);
  assert.equal(countsByHour(rows, "UTC")[20]?.count, 1);
  assert.deepEqual(countsByDay(rows, "UTC", "2026-09-10", "2026-09-11").map((d) => d.count), [1, 0]);
  // An unparseable instant is remembered as unparseable, in every zone.
  const broken = [activity({ occurred_at: "not a date" })];
  assert.deepEqual(countsByDay(broken, "UTC", "2026-09-10", "2026-09-10").map((d) => d.count), [0]);
  assert.deepEqual(countsByDay(broken, "Asia/Taipei", "2026-09-10", "2026-09-10").map((d) => d.count), [0]);
});
