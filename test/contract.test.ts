import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContract } from "../src/contract/build.ts";
import { CONTRACT_VERSION } from "../src/contract/version.ts";
import { validateContract } from "../src/contract/validate.ts";
import { deriveActorKey } from "../src/model/actor.ts";
import type { ActivityRow, ItemRow, LabelRow, EdgeRow, ReviewThreadRow, SourceRow } from "../src/db/store.ts";

function itemRow(over: Partial<ItemRow>): ItemRow {
  return {
    item_id: 1,
    source_id: "github:github.com",
    external_id: "ISSUE_abc",
    kind: "issue",
    project_path: "dev-a/repo",
    iid: 7,
    url: "https://github.com/dev-a/repo/issues/7",
    title: "An issue",
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "dev-a",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    review_state: null,
    ci_state: null,
    merge_state: null,
    open_review_threads: null,
    total_review_threads: null,
    milestone: null,
    demand: 3,
    last_seen_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function activityRow(over: Partial<ActivityRow> = {}): ActivityRow {
  const merged: ActivityRow = {
    source_id: "github:github.com",
    external_id: "activity-1",
    kind: "issue",
    action: "opened",
    project_path: "dev-a/repo",
    target_kind: "issue",
    target_source_id: "github:github.com",
    target_external_id: "ISSUE_abc",
    target_iid: 7,
    title: "An issue",
    url: "https://github.com/dev-a/repo/issues/7",
    actor: "dev-a",
    actor_key: null,
    occurred_at: "2026-01-01T00:00:00Z",
    summary: "Opened issue #7",
    details: "{\"source\":\"test\"}",
    first_seen_at: "2026-06-01T00:00:00Z",
    last_seen_at: "2026-06-01T00:00:00Z",
    ...over,
  };
  // Default the actor key from the (possibly overridden) actor as a provider
  // username, so a fixture only has to set `actor_key` when exercising email /
  // name identities. Matches the key build.ts recomputes for item authors.
  if (!("actor_key" in over)) {
    merged.actor_key = deriveActorKey({ sourceId: merged.source_id, username: merged.actor });
  }
  return merged;
}

function reviewThreadRow(over: Partial<ReviewThreadRow> = {}): ReviewThreadRow {
  return {
    source_id: "github:github.com",
    external_id: "PRRT_1",
    project_path: "dev-a/repo",
    target_source_id: "github:github.com",
    target_external_id: "PR_open",
    target_iid: 8,
    title: "Reviewable PR",
    url: "https://github.com/dev-a/repo/pull/8#discussion_r1",
    is_resolved: false,
    is_outdated: false,
    resolved_by: null,
    path: "src/app.ts",
    line: 12,
    start_line: 10,
    comments_total: 1,
    comments_json: JSON.stringify([
      {
        id: "PRRC_1",
        author: "reviewer",
        body: "Please cover this branch.",
        url: "https://github.com/dev-a/repo/pull/8#discussion_r1",
        createdAt: "2026-06-01T01:00:00Z",
        updatedAt: "2026-06-01T01:05:00Z",
      },
    ]),
    last_seen_at: "2026-06-01T02:00:00Z",
    ...over,
  };
}

test("buildContract emits a versioned envelope with composite-ref ids", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: "2026-06-01T00:00:00Z", last_status: "ok" },
  ];
  const items: ItemRow[] = [itemRow({ item_id: 1 }), itemRow({ item_id: 2, external_id: "PR_xyz", kind: "change_request", state: "merged", is_draft: false })];
  const labels: LabelRow[] = [{ item_id: 1, name: "bug", scope: null, color: "red" }];
  const edges: EdgeRow[] = [
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_xyz", to_source_id: "github:github.com", to_external_id: "ISSUE_abc", from_state: "merged", to_state: "open", lifecycle: "declared" },
  ];

  const env = buildContract({ sources, items, labels, edges, generatedAt: "2026-06-02T00:00:00Z" });

  assert.equal(env.contract_version, CONTRACT_VERSION);
  assert.equal(env.items.length, 2);
  assert.equal(env.items[0]!.id, "github:github.com|ISSUE_abc");
  assert.equal(env.items[0]!.labels.length, 1);
  assert.equal(env.items[1]!.is_draft, false);
  assert.equal(env.edges.length, 1);
  assert.equal(env.edges[0]!.from, "github:github.com|PR_xyz");
  assert.equal(env.edges[0]!.to, "github:github.com|ISSUE_abc");
  assert.ok(env.aggregates?.some((a) => a.scope === "global" && a.window.kind === "full"));
});

test("buildContract emits the configured timezone, defaulting to UTC", () => {
  const items: ItemRow[] = [itemRow({ item_id: 1 })];

  const dflt = buildContract({ sources: [], items, labels: [], edges: [], generatedAt: "2026-06-02T00:00:00Z" });
  assert.equal(dflt.timezone, "UTC");
  assert.deepEqual(validateContract(dflt), []);

  const zoned = buildContract({ sources: [], items, labels: [], edges: [], generatedAt: "2026-06-02T00:00:00Z", timezone: "Asia/Taipei" });
  assert.equal(zoned.timezone, "Asia/Taipei");
  assert.deepEqual(validateContract(zoned), []);
});

test("buildContract groups labels by item and leaves label-less items empty", () => {
  const items: ItemRow[] = [itemRow({ item_id: 1 }), itemRow({ item_id: 2, external_id: "ISSUE_def" })];
  const labels: LabelRow[] = [
    { item_id: 1, name: "a", scope: null, color: null },
    { item_id: 1, name: "b", scope: null, color: null },
  ];
  const env = buildContract({ sources: [], items, labels, edges: [], generatedAt: "2026-06-02T00:00:00Z" });
  assert.equal(env.items[0]!.labels.length, 2);
  assert.equal(env.items[1]!.labels.length, 0);
});

test("buildContract applies source colors where set and emits the repos block verbatim", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
    { source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", display_name: "GitLab", last_success_at: null, last_status: "ok" },
  ];
  const env = buildContract({
    sources,
    items: [],
    labels: [],
    edges: [],
    generatedAt: "2026-06-02T00:00:00Z",
    sourceColors: { "github:github.com": "#1f6feb" },
    repoColors: [{ source_id: "github:github.com", project_path: "dev-a/repo", color: "#e0af68" }],
  });
  assert.equal(env.sources[0]!.color, "#1f6feb"); // set
  assert.equal(env.sources[1]!.color, null); // unset -> null
  assert.deepEqual(env.repos, [{ source_id: "github:github.com", project_path: "dev-a/repo", color: "#e0af68" }]);
});

test("buildContract defaults to no colors when none are supplied", () => {
  const sources: SourceRow[] = [
    { source_id: "s", kind: "github", host: "h", display_name: null, last_success_at: null, last_status: null },
  ];
  const env = buildContract({ sources, items: [], labels: [], edges: [], generatedAt: "2026-06-02T00:00:00Z" });
  assert.equal(env.sources[0]!.color, null);
  assert.deepEqual(env.repos, []);
});

test("buildContract emits activity records with refs and parsed details", () => {
  const env = buildContract({
    sources: [],
    items: [],
    labels: [],
    edges: [],
    // In the 30-day emit window (default activityRow occurred_at is months old,
    // which 4.0.0 windows out of the emitted activities[]).
    activities: [activityRow({ occurred_at: "2026-06-01T00:00:00Z" })],
    generatedAt: "2026-06-02T00:00:00Z",
  });
  assert.equal(env.activities?.length, 1);
  // 4.0.0 dropped the redundant `id`/`summary`; identity is source_id|external_id.
  assert.equal(env.activities![0]!.source_id, "github:github.com");
  assert.equal(env.activities![0]!.external_id, "activity-1");
  const firstActivity = env.activities![0]! as unknown as Record<string, unknown>;
  assert.equal("id" in firstActivity, false, "id is no longer emitted");
  assert.equal("summary" in firstActivity, false, "summary is no longer emitted");
  assert.equal(env.activities![0]!.target_ref, "github:github.com|ISSUE_abc");
  assert.deepEqual(env.activities![0]!.details, { source: "test" });
});

test("buildContract orders activities by instant across timezone offsets", () => {
  const env = buildContract({
    sources: [],
    items: [],
    labels: [],
    edges: [],
    activities: [
      activityRow({ external_id: "gitlab-local", occurred_at: "2026-06-08T16:59:35.000+08:00" }),
      activityRow({ external_id: "github-utc", occurred_at: "2026-06-08T09:45:23Z" }),
    ],
    generatedAt: "2026-06-08T10:00:00Z",
  });

  assert.deepEqual(env.activities?.map((activity) => activity.external_id), ["github-utc", "gitlab-local"]);
});

test("buildContract windows emitted activities to 30 days while activity_daily covers the full history (4.0.0)", () => {
  const generatedAt = "2026-06-08T00:00:00.000Z";
  const activities: ActivityRow[] = [
    activityRow({ external_id: "recent-1", kind: "commit", occurred_at: "2026-06-07T10:00:00Z" }), // in window
    activityRow({ external_id: "recent-2", kind: "review", occurred_at: "2026-05-20T10:00:00Z" }), // in window (19d)
    activityRow({ external_id: "old-1", kind: "commit", occurred_at: "2026-03-01T10:00:00Z" }), // out of window
    activityRow({ external_id: "old-2", kind: "issue", occurred_at: "2025-08-01T10:00:00Z" }), // far out of window
  ];
  const env = buildContract({ sources: [], items: [], labels: [], edges: [], activities, generatedAt });
  assert.deepEqual(validateContract(env), []);

  // Emitted activities[] is windowed to the trailing 30 days, anchored to generated_at.
  const emitted = new Set(env.activities?.map((a) => a.external_id));
  assert.deepEqual([...emitted].sort(), ["recent-1", "recent-2"], "only the last 30 days are emitted");

  // activity_daily reconciles with the FULL canonical set, by kind (acceptance 2.2).
  const daily = env.activity_daily!;
  assert.equal(daily.total, activities.length);
  assert.deepEqual(daily.by_kind, { commit: 2, review: 1, issue: 1 });
  let dayCountSum = 0;
  const dayKindSum: Record<string, number> = {};
  for (const d of daily.days) {
    dayCountSum += d.count;
    assert.equal(d.count, Object.values(d.by_kind).reduce((a, b) => a + b, 0), "bucket count == sum of its by_kind");
    for (const [k, n] of Object.entries(d.by_kind)) dayKindSum[k] = (dayKindSum[k] ?? 0) + n;
  }
  assert.equal(dayCountSum, daily.total, "sum of day counts == total");
  assert.deepEqual(dayKindSum, daily.by_kind, "sum of per-day by_kind == aggregate by_kind");

  // Anchored to generated_at; sparse, ascending days.
  assert.equal(daily.to, "2026-06-08");
  assert.equal(daily.from, daily.days[0]!.date);
  const dates = daily.days.map((d) => d.date);
  assert.deepEqual([...dates].sort(), dates, "days are ascending by date");
  assert.equal(daily.days.length, 4, "one bucket per distinct active day (sparse)");
});

test("activity_daily buckets by the contract timezone and is empty-safe", () => {
  // A late-UTC commit lands on the next LOCAL day in Asia/Taipei (+08:00).
  const env = buildContract({
    sources: [],
    items: [],
    labels: [],
    edges: [],
    activities: [activityRow({ external_id: "late", kind: "commit", occurred_at: "2026-06-07T17:00:00Z" })],
    generatedAt: "2026-06-08T00:00:00.000Z",
    timezone: "Asia/Taipei",
  });
  assert.deepEqual(validateContract(env), []);
  assert.equal(env.activity_daily?.timezone, "Asia/Taipei");
  assert.deepEqual(env.activity_daily?.days.map((d) => d.date), ["2026-06-08"]);

  // No activity at all: activity_daily is still present, empty, from == to == generated_at day.
  const empty = buildContract({ sources: [], items: [], labels: [], edges: [], activities: [], generatedAt: "2026-06-08T00:00:00.000Z" });
  assert.deepEqual(empty.activity_daily, { timezone: "UTC", from: "2026-06-08", to: "2026-06-08", total: 0, by_kind: {}, days: [] });
});

test("buildContract emits scoped full and active-since aggregates", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "ISSUE_recent", kind: "issue", state: "open", updated_at: "2026-06-07T00:00:00Z" }),
    itemRow({ item_id: 2, external_id: "PR_recent", kind: "change_request", state: "merged", updated_at: "2026-06-06T00:00:00Z" }),
    itemRow({ item_id: 3, external_id: "ISSUE_old", kind: "issue", state: "closed", updated_at: "2020-01-01T00:00:00Z" }),
    itemRow({ item_id: 4, external_id: "PR_old", kind: "change_request", state: "closed", updated_at: "2020-01-01T00:00:00Z" }),
  ];
  const edges: EdgeRow[] = [
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_recent", to_source_id: "github:github.com", to_external_id: "ISSUE_recent", from_state: "merged", to_state: "open", lifecycle: "fulfilled" },
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_old", to_source_id: "github:github.com", to_external_id: "ISSUE_old", from_state: "closed", to_state: "closed", lifecycle: "broken" },
    { type: "mentions", from_source_id: "github:github.com", from_external_id: "PR_recent", to_source_id: "github:github.com", to_external_id: "ISSUE_old", from_state: "merged", to_state: "closed", lifecycle: null },
  ];

  const env = buildContract({ sources, items, labels: [], edges, generatedAt: "2026-06-08T00:00:00.000Z" });
  const aggregates = env.aggregates ?? [];
  assert.equal(aggregates.length, 11, "global + board full + graph full + four board/graph active windows");

  const boardWeek = aggregates.find((a) => a.scope === "boardWindow" && a.window.days === 7);
  assert.equal(boardWeek?.window.basis, "item_updated_at");
  assert.equal(boardWeek?.window.since, "2026-06-01T00:00:00.000Z");
  assert.equal(boardWeek?.stats.items, 2, "Board windows count item-updated rows");
  assert.deepEqual(boardWeek?.stats.by_lifecycle, { fulfilled: 1, other: 1 }, "Board lifecycle counts edges touching windowed items");

  const graphWeek = aggregates.find((a) => a.scope === "graphWindow" && a.window.days === 7);
  assert.equal(graphWeek?.window.basis, "edge_endpoint_updated_at");
  assert.equal(graphWeek?.window.edge_filter, "no_mentions");
  assert.equal(graphWeek?.stats.items, 2, "Graph windows count rendered nodes");
  assert.deepEqual(graphWeek?.stats.by_lifecycle, { fulfilled: 1 }, "Graph default aggregates exclude mention edges");
});

test("buildContract emits a windowed item set with endpoint closure and full totals", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "ISSUE_recent", kind: "issue", state: "open", updated_at: "2026-06-07T00:00:00Z", project_path: "o/recent" }),
    itemRow({ item_id: 2, external_id: "PR_old_linked", kind: "change_request", state: "merged", updated_at: "2020-01-01T00:00:00Z", project_path: "o/old-linked" }),
    itemRow({ item_id: 3, external_id: "ISSUE_old_unlinked", kind: "issue", state: "closed", updated_at: "2020-01-01T00:00:00Z", project_path: "o/old-unlinked" }),
  ];
  const edges: EdgeRow[] = [
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_old_linked", to_source_id: "github:github.com", to_external_id: "ISSUE_recent", from_state: "merged", to_state: "open", lifecycle: "fulfilled" },
  ];

  const env = buildContract({ sources, items, labels: [], edges, generatedAt: "2026-06-08T00:00:00.000Z" });

  assert.equal(env.contract_version, CONTRACT_VERSION);
  assert.equal(env.item_window?.window.days, 90);
  assert.equal(env.item_window?.window.since, "2026-03-10T00:00:00.000Z");
  assert.equal(env.item_window?.primary_items, 1);
  assert.equal(env.item_window?.edge_endpoint_items, 1);
  assert.equal(env.item_window?.total_items, 3);
  assert.equal(env.item_window?.truncated, true);
  assert.deepEqual(env.items.map((it) => it.external_id).sort(), ["ISSUE_recent", "PR_old_linked"]);
  assert.deepEqual(env.items.find((it) => it.external_id === "ISSUE_recent")?.window_reasons, ["primary", "edge_endpoint"]);
  assert.deepEqual(env.items.find((it) => it.external_id === "PR_old_linked")?.window_reasons, ["edge_endpoint"]);
  assert.equal(env.aggregates?.find((a) => a.scope === "global")?.stats.items, 3, "aggregates still count the full canonical set");
  assert.deepEqual(
    env.repo_stats?.map((repo) => [repo.project_path, repo.items]).sort(),
    [["o/old-linked", 1], ["o/old-unlinked", 1], ["o/recent", 1]],
    "settings counts are full repo totals, not loaded item counts",
  );
});

test("buildContract emits repo metrics for the static default window", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({
      item_id: 1,
      external_id: "ISSUE_recent",
      kind: "issue",
      state: "open",
      author: "alice",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-07T00:00:00Z",
      project_path: "o/repo",
    }),
    itemRow({
      item_id: 2,
      external_id: "PR_recent",
      kind: "change_request",
      state: "merged",
      author: "bob",
      created_at: "2026-06-02T00:00:00Z",
      updated_at: "2026-06-06T00:00:00Z",
      closed_at: "2026-06-06T00:00:00Z",
      merged_at: "2026-06-06T00:00:00Z",
      review_state: "approved",
      ci_state: "passing",
      merge_state: "mergeable",
      open_review_threads: 2,
      total_review_threads: 3,
      project_path: "o/repo",
    }),
  ];
  const labels: LabelRow[] = [{ item_id: 1, name: "type::feature", scope: "type", color: null }];
  const edges: EdgeRow[] = [
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_recent", to_source_id: "github:github.com", to_external_id: "ISSUE_recent", from_state: "merged", to_state: "open", lifecycle: "fulfilled" },
  ];
  const activities: ActivityRow[] = [
    activityRow({
      external_id: "commit-1",
      kind: "commit",
      action: "committed",
      project_path: "o/repo",
      actor: "alice",
      occurred_at: "2026-06-07T10:00:00Z",
    }),
    activityRow({
      external_id: "push-1",
      kind: "push",
      action: "pushed",
      project_path: "o/repo",
      actor: "bob",
      occurred_at: "2026-06-07T11:00:00Z",
    }),
  ];

  const env = buildContract({ sources, items, labels, edges, activities, generatedAt: "2026-06-08T00:00:00.000Z" });

  assert.deepEqual(validateContract(env), []);
  assert.equal(env.contract_version, CONTRACT_VERSION);
  const metric = env.repo_metrics?.[0];
  assert.equal(metric?.source_id, "github:github.com");
  assert.equal(metric?.project_path, "o/repo");
  assert.equal(metric?.repo_url, "https://github.com/o/repo");
  assert.deepEqual(metric?.window, {
    kind: "active_since",
    basis: "repo_activity",
    from: "2026-03-10T00:00:00.000Z",
    to: "2026-06-08T00:00:00.000Z",
    bucket: "week",
  });
  assert.equal(metric?.totals.items_active, 2);
  assert.equal(metric?.totals.items_opened, 2);
  assert.equal(metric?.totals.change_requests_opened, 1);
  assert.equal(metric?.totals.change_requests_merged, 1);
  assert.equal(metric?.totals.activities, 2);
  // Unweighted sum of in-window event counts: commits(1) + issues_opened(1)
  // + change_requests_opened(1) + change_requests_merged(1) = 4.
  assert.equal(metric?.totals.activity_score, 4);
  assert.equal(metric?.totals.commits, 1);
  assert.equal(metric?.totals.pushes, 1);
  assert.equal(metric?.totals.unresolved_review_threads, 2);
  assert.equal(metric?.totals.edge_fulfilled, 1);
  assert.deepEqual(metric?.totals.by_label_scope, { type: 1 });
  assert.equal(metric?.data_quality.activity_available, true);
  assert.equal(metric?.data_quality.observed_since, "2026-06-07T10:00:00Z");
  assert.equal(metric?.data_quality.last_activity_at, "2026-06-07T11:00:00Z");
  assert.ok(metric?.series.some((bucket) => bucket.stats.commits === 1 && bucket.stats.pushes === 1));
  assert.deepEqual(metric?.top_actors?.map((actor) => actor.actor).sort(), ["alice", "bob"]);
  // Each provider-user actor links to its provider profile page.
  const actorsByName = new Map((metric?.top_actors ?? []).map((actor) => [actor.actor, actor]));
  assert.equal(actorsByName.get("alice")?.profile_url, "https://github.com/alice");
  assert.equal(actorsByName.get("bob")?.profile_url, "https://github.com/bob");
});

test("review_threads folds the two columns into a nested DTO, null for issues and unreported rows", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const env = buildContract({
    sources,
    items: [
      // issue: never has threads.
      itemRow({ item_id: 1, external_id: "ISSUE_1", kind: "issue" }),
      // change_request with open + resolved threads.
      itemRow({ item_id: 2, external_id: "PR_open", kind: "change_request", open_review_threads: 2, total_review_threads: 3 }),
      // change_request, all resolved (distinct from "unreported").
      itemRow({ item_id: 3, external_id: "PR_resolved", kind: "change_request", open_review_threads: 0, total_review_threads: 4 }),
      // change_request the provider never reported threads for -> null, not {0,0}.
      itemRow({ item_id: 4, external_id: "PR_unknown", kind: "change_request", open_review_threads: null, total_review_threads: null }),
    ],
    labels: [],
    edges: [],
    generatedAt: "2026-06-08T00:00:00.000Z",
  });
  assert.deepEqual(validateContract(env), []);
  const byExt = new Map(env.items.map((it) => [it.external_id, it]));
  assert.equal(byExt.get("ISSUE_1")?.review_threads, null);
  assert.deepEqual(byExt.get("PR_open")?.review_threads, { open: 2, total: 3 });
  assert.deepEqual(byExt.get("PR_resolved")?.review_threads, { open: 0, total: 4 });
  assert.equal(byExt.get("PR_unknown")?.review_threads, null);
});

test("buildContract emits current review-thread detail rows for loaded change_requests", () => {
  const env = buildContract({
    sources: [
      { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
    ],
    items: [
      itemRow({ item_id: 1, external_id: "PR_open", kind: "change_request", iid: 8, open_review_threads: 1, total_review_threads: 1 }),
      itemRow({ item_id: 2, external_id: "ISSUE_1", kind: "issue" }),
    ],
    labels: [],
    edges: [],
    reviewThreads: [
      reviewThreadRow(),
      reviewThreadRow({ external_id: "PRRT_hidden", target_external_id: "PR_outside", target_iid: 99 }),
    ],
    generatedAt: "2026-06-08T00:00:00.000Z",
  });

  assert.deepEqual(validateContract(env), []);
  assert.equal(env.review_threads?.length, 1);
  const thread = env.review_threads![0]!;
  assert.equal(thread.id, "github:github.com|PRRT_1");
  assert.equal(thread.target_ref, "github:github.com|PR_open");
  assert.equal(thread.is_resolved, false);
  assert.equal(thread.path, "src/app.ts");
  assert.equal(thread.start_line, 10);
  assert.equal(thread.line, 12);
  assert.equal(thread.comments_total, 1);
  assert.equal(thread.comments[0]!.author, "reviewer");
  assert.equal(thread.comments[0]!.body, "Please cover this branch.");
});

test("review-thread comment carries the author avatar URL through to the contract DTO (4.2.0)", () => {
  const env = buildContract({
    sources: [
      { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
    ],
    items: [itemRow({ item_id: 1, external_id: "PR_open", kind: "change_request", iid: 8, open_review_threads: 1, total_review_threads: 1 })],
    labels: [],
    edges: [],
    reviewThreads: [
      reviewThreadRow({
        comments_json: JSON.stringify([
          {
            id: "PRRC_1",
            author: "reviewer",
            avatarUrl: "https://avatars.example/u/7.png",
            body: "Please cover this branch.",
            url: "https://github.com/dev-a/repo/pull/8#discussion_r1",
            createdAt: "2026-06-01T01:00:00Z",
            updatedAt: "2026-06-01T01:05:00Z",
          },
          {
            id: "PRRC_2",
            author: "maintainer",
            body: "No avatar synced for this one.",
            url: "https://github.com/dev-a/repo/pull/8#discussion_r2",
            createdAt: "2026-06-01T01:10:00Z",
            updatedAt: "2026-06-01T01:10:00Z",
          },
        ]),
        comments_total: 2,
      }),
    ],
    generatedAt: "2026-06-08T00:00:00.000Z",
  });

  // The schema (additionalProperties:false) must accept the new field, and the
  // producer must always emit it — present when synced, null when absent.
  assert.deepEqual(validateContract(env), []);
  const comments = env.review_threads![0]!.comments;
  assert.equal(comments[0]!.avatar_url, "https://avatars.example/u/7.png");
  assert.equal(comments[1]!.avatar_url, null);
});

test("review-thread comment schema tolerates a 4.1.0 comment with no avatar_url key (minor-version back-compat)", () => {
  // 4.2.0 is a minor bump, so the new avatar_url must be additive-optional: a
  // contract emitted under 4.1.0 (whose comments never had the key) must still
  // validate, instead of being rejected by a required avatar_url.
  const env = buildContract({
    sources: [
      { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
    ],
    items: [itemRow({ item_id: 1, external_id: "PR_open", kind: "change_request", iid: 8, open_review_threads: 1, total_review_threads: 1 })],
    labels: [],
    edges: [],
    reviewThreads: [
      reviewThreadRow({
        comments_json: JSON.stringify([
          {
            id: "PRRC_legacy",
            author: "reviewer",
            body: "A 4.1.0-shaped comment.",
            url: "https://github.com/dev-a/repo/pull/8#discussion_r1",
            createdAt: "2026-06-01T01:00:00Z",
            updatedAt: "2026-06-01T01:05:00Z",
          },
        ]),
        comments_total: 1,
      }),
    ],
    generatedAt: "2026-06-08T00:00:00.000Z",
  });
  // Drop the producer-emitted key to simulate a contract from before 4.2.0.
  delete (env.review_threads![0]!.comments[0] as { avatar_url?: unknown }).avatar_url;
  assert.deepEqual(validateContract(env), [], "a comment without avatar_url must still validate under 4.2.0");
});

test("repo metrics emit provider repo URLs for nested GitLab paths and null for malformed paths", () => {
  const sources: SourceRow[] = [
    { source_id: "gitlab:gitlab.internal", kind: "gitlab", host: "gitlab.internal", display_name: "GitLab", last_success_at: null, last_status: "ok" },
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const env = buildContract({
    sources,
    items: [
      itemRow({ item_id: 1, source_id: "gitlab:gitlab.internal", external_id: "GL_1", project_path: "group/sub/project" }),
      itemRow({ item_id: 2, source_id: "github:github.com", external_id: "GH_bad", project_path: "too/deep/for/github" }),
    ],
    labels: [],
    edges: [],
    generatedAt: "2026-06-08T00:00:00.000Z",
  });
  assert.deepEqual(validateContract(env), []);
  assert.equal(env.repo_metrics?.find((m) => m.project_path === "group/sub/project")?.repo_url, "https://gitlab.internal/group/sub/project");
  assert.equal(env.repo_metrics?.find((m) => m.project_path === "too/deep/for/github")?.repo_url, null);
});

test("repo metric data_quality timestamps are null when a repo has no activity rows", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  // An item creates the repo's metric row, but no activity rows exist for it, so
  // both the earliest and latest observed-activity timestamps fall back to null.
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "ISSUE_quiet", project_path: "o/quiet", created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-07T00:00:00Z" }),
  ];
  const env = buildContract({ sources, items, labels: [], edges: [], activities: [], generatedAt: "2026-06-08T00:00:00.000Z" });

  assert.deepEqual(validateContract(env), []);
  const metric = env.repo_metrics?.find((m) => m.project_path === "o/quiet");
  assert.equal(metric?.data_quality.activity_available, false);
  assert.equal(metric?.data_quality.observed_since, null);
  assert.equal(metric?.data_quality.last_activity_at, null);
});

test("buildContract counts review activity rows into reviews and approvals", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "PR_1", kind: "change_request", state: "merged", project_path: "o/repo", updated_at: "2026-06-06T00:00:00Z" }),
  ];
  // Three review events on PR_1: an approval, a changes-requested, and a plain
  // review comment. reviews counts all three; approvals counts only the first.
  const activities: ActivityRow[] = [
    activityRow({ external_id: "rev-approved", kind: "review", action: "approved", target_external_id: "PR_1", actor: "alice", project_path: "o/repo", occurred_at: "2026-06-05T09:00:00Z" }),
    activityRow({ external_id: "rev-changes", kind: "review", action: "changes_requested", target_external_id: "PR_1", actor: "bob", project_path: "o/repo", occurred_at: "2026-06-05T10:00:00Z" }),
    activityRow({ external_id: "rev-comment", kind: "review", action: "reviewed", target_external_id: "PR_1", actor: "carol", project_path: "o/repo", occurred_at: "2026-06-05T11:00:00Z" }),
  ];

  const env = buildContract({ sources, items, labels: [], edges: [], activities, generatedAt: "2026-06-08T00:00:00.000Z" });
  assert.deepEqual(validateContract(env), []);
  const metric = env.repo_metrics?.find((m) => m.project_path === "o/repo");
  assert.equal(metric?.totals.reviews, 3, "every review activity counts as a review");
  assert.equal(metric?.totals.approvals, 1, "only the approved review counts as an approval");
  assert.equal(metric?.totals.by_activity_kind.review, 3);
  assert.equal(metric?.totals.by_activity_action.approved, 1);
});

test("repo metrics group top_actors by canonical identity", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  // One issue authored by the username "carol". Its account-linked commit below
  // must merge into the SAME actor identity, not a separate row.
  const items: ItemRow[] = [
    itemRow({
      item_id: 1,
      external_id: "ISSUE_carol",
      kind: "issue",
      state: "open",
      author: "carol",
      created_at: "2026-06-05T00:00:00Z",
      updated_at: "2026-06-06T00:00:00Z",
      project_path: "o/repo",
    }),
  ];

  const emailA = deriveActorKey({ sourceId: "github:github.com", email: "user@example.com", name: "Example User" });
  const emailB = deriveActorKey({ sourceId: "github:github.com", email: "other@example.com", name: "Example User" });
  const carolKey = deriveActorKey({ sourceId: "github:github.com", username: "carol" });

  const activities: ActivityRow[] = [
    // Same email, two display-name variants -> one actor identity.
    activityRow({ external_id: "c1", kind: "commit", action: "committed", project_path: "o/repo", actor: "Example User", actor_key: emailA, occurred_at: "2026-06-07T10:00:00Z" }),
    activityRow({ external_id: "c2", kind: "commit", action: "committed", project_path: "o/repo", actor: "Example User Alt", actor_key: emailA, occurred_at: "2026-06-07T11:00:00Z" }),
    // A different email that happens to share a display name -> must NOT merge.
    activityRow({ external_id: "c3", kind: "commit", action: "committed", project_path: "o/repo", actor: "Example User", actor_key: emailB, occurred_at: "2026-06-07T12:00:00Z" }),
    // An account-linked commit by the issue author "carol" -> merges with the issue.
    activityRow({ external_id: "c4", kind: "commit", action: "committed", project_path: "o/repo", actor: "carol", actor_key: carolKey, occurred_at: "2026-06-07T13:00:00Z" }),
  ];

  const env = buildContract({ sources, items, activities, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z" });
  assert.deepEqual(validateContract(env), []);

  const actors = env.repo_metrics?.[0]?.top_actors ?? [];
  const byKey = new Map(actors.map((a) => [a.actor_key, a]));

  // Same email, multiple display names -> one row; deterministic display name +
  // aliases.
  assert.equal([...byKey.keys()].filter((k) => k === emailA).length, 1);
  const a = byKey.get(emailA!);
  assert.equal(a?.display_name, "Example User", "most frequent / lexicographically-first name wins");
  assert.deepEqual(a?.aliases, ["Example User Alt"]);
  assert.equal(a?.commits, 2);
  assert.equal(a?.activities, 2);

  // Two different emails with the same display name stay separate.
  assert.notEqual(emailA, emailB);
  assert.ok(byKey.has(emailB!), "different email is its own identity");
  assert.equal(byKey.get(emailB!)?.commits, 1);

  // Username identity is stable and merges the issue with the account-linked commit.
  const carol = byKey.get(carolKey!);
  assert.equal(carol?.display_name, "carol");
  assert.equal(carol?.items_opened, 1, "issue authored by carol");
  assert.equal(carol?.commits, 1, "commit by carol merges into the same identity");

  // Three identities total (emailA, emailB, carol); the two "Example User"
  // display names are distinct rows keyed by identity.
  assert.equal(actors.length, 3);
  assert.equal(actors.filter((x) => x.display_name === "Example User").length, 2);
});

test("config identities collapse a GitLab username and commit-email facet into one actor", () => {
  const sources: SourceRow[] = [
    { source_id: "gitlab:gitlab.internal", kind: "gitlab", host: "gitlab.internal", display_name: "GitLab", last_success_at: null, last_status: "ok" },
  ];
  // An MR authored by the username "dev-b" (provider-user key) ...
  const items: ItemRow[] = [
    itemRow({
      item_id: 1, source_id: "gitlab:gitlab.internal", external_id: "MR_1", kind: "change_request",
      state: "merged", author: "dev-b", project_path: "g/p",
      created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-06T00:00:00Z", closed_at: "2026-06-06T00:00:00Z", merged_at: "2026-06-06T00:00:00Z",
    }),
  ];
  // ... and a commit by the same human, which GitLab only gives an email + name.
  const commitKey = deriveActorKey({ sourceId: "gitlab:gitlab.internal", email: "dev-a@example.com", name: "DEV A" });
  const activities: ActivityRow[] = [
    activityRow({ external_id: "commit-1", kind: "commit", action: "committed", project_path: "g/p", actor: "DEV A", actor_key: commitKey, source_id: "gitlab:gitlab.internal", target_source_id: "gitlab:gitlab.internal", occurred_at: "2026-06-07T10:00:00Z" }),
  ];

  // Without a declared identity the two facets are separate rows.
  const split = buildContract({ sources, items, activities, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z" });
  const splitRows = split.repo_metrics?.[0]?.top_actors ?? [];
  assert.equal(splitRows.length, 2);
  // The provider-user facet links to the GitLab profile on the source's host ...
  const username = splitRows.find((r) => r.actor_key.startsWith("provider-user:"));
  assert.equal(username?.profile_url, "https://gitlab.internal/dev-b");
  // ... while the account-less commit-email facet has no linkable username.
  const emailFacet = splitRows.find((r) => r.actor_key.startsWith("email:"));
  assert.equal(emailFacet?.profile_url, undefined);

  // The config identity merges them: username match OR commit-name match.
  const merged = buildContract({
    sources, items, activities, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z",
    identities: [{ name: "Dev A", usernames: ["dev-b"], names: ["DEV A"] }],
  });
  assert.deepEqual(validateContract(merged), []);
  const rows = merged.repo_metrics?.[0]?.top_actors ?? [];
  assert.equal(rows.length, 1, "one canonical actor");
  const row = rows[0]!;
  assert.equal(row.actor_key, "person:dev-a", "canonical person key, not a raw username/email key");
  assert.equal(row.profile_url, "https://gitlab.internal/dev-b", "the merged person links to the username observed on this source");
  assert.equal(row.display_name, "Dev A", "config display name wins");
  assert.equal(row.commits, 1, "commit counted");
  assert.equal(row.change_requests_merged, 1, "MR merge counted under the same identity");
  assert.ok((row.aliases ?? []).includes("DEV A"), "observed commit name kept as an alias");
});

test("source-scoped config identities do not merge same-name actors from other sources", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
    { source_id: "gitlab:gitlab.internal", kind: "gitlab", host: "gitlab.internal", display_name: "GitLab", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({
      item_id: 1, source_id: "gitlab:gitlab.internal", external_id: "MR_1", kind: "change_request",
      state: "merged", author: "dev-b", project_path: "g/p",
      created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-06T00:00:00Z", closed_at: "2026-06-06T00:00:00Z", merged_at: "2026-06-06T00:00:00Z",
    }),
  ];
  const githubCommitKey = deriveActorKey({ sourceId: "github:github.com", email: "github-dev-a@example.com", name: "Dev A" });
  const gitlabCommitKey = deriveActorKey({ sourceId: "gitlab:gitlab.internal", email: "dev-b@example.com", name: "Dev A" });
  const activities: ActivityRow[] = [
    activityRow({ external_id: "gh-commit", kind: "commit", action: "committed", project_path: "o/repo", actor: "Dev A", actor_key: githubCommitKey, source_id: "github:github.com", target_source_id: "github:github.com", occurred_at: "2026-06-07T10:00:00Z" }),
    activityRow({ external_id: "gl-commit", kind: "commit", action: "committed", project_path: "g/p", actor: "Dev A", actor_key: gitlabCommitKey, source_id: "gitlab:gitlab.internal", target_source_id: "gitlab:gitlab.internal", occurred_at: "2026-06-07T11:00:00Z" }),
  ];

  const env = buildContract({
    sources, items, activities, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z",
    identities: [{ name: "dev-b", usernames: ["dev-b"], names: ["Dev A"], source_ids: ["gitlab:gitlab.internal"] }],
  });
  assert.deepEqual(validateContract(env), []);

  const githubActors = env.repo_metrics?.find((m) => m.source_id === "github:github.com" && m.project_path === "o/repo")?.top_actors ?? [];
  assert.equal(githubActors.length, 1);
  assert.equal(githubActors[0]!.actor_key, githubCommitKey, "GitHub same-name commit stays on its own email identity");
  assert.equal(githubActors[0]!.display_name, "Dev A");

  const gitlabActors = env.repo_metrics?.find((m) => m.source_id === "gitlab:gitlab.internal" && m.project_path === "g/p")?.top_actors ?? [];
  assert.equal(gitlabActors.length, 1);
  assert.equal(gitlabActors[0]!.actor_key, "person:dev-b", "scoped source still applies inside the declared source");
  assert.equal(gitlabActors[0]!.commits, 1);
  assert.equal(gitlabActors[0]!.change_requests_merged, 1);
});

test("a name-only merged person is not linked (config usernames are host-agnostic, so no guess)", () => {
  const sources: SourceRow[] = [
    { source_id: "gitlab:gitlab.internal", kind: "gitlab", host: "gitlab.internal", display_name: "GitLab", last_success_at: null, last_status: "ok" },
  ];
  // Only commit activity, carrying a name and email but no provider username.
  const commitKey = deriveActorKey({ sourceId: "gitlab:gitlab.internal", email: "dev-d@example.com", name: "Dev D" });
  const activities: ActivityRow[] = [
    activityRow({ external_id: "commit-1", kind: "commit", action: "committed", project_path: "g/p", actor: "Dev D", actor_key: commitKey, source_id: "gitlab:gitlab.internal", target_source_id: "gitlab:gitlab.internal", occurred_at: "2026-06-07T10:00:00Z" }),
  ];
  const env = buildContract({
    sources, items: [], activities, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z",
    identities: [{ name: "dev-d", usernames: ["dev-d"], names: ["Dev D"] }],
  });
  assert.deepEqual(validateContract(env), []);
  const row = (env.repo_metrics?.[0]?.top_actors ?? [])[0]!;
  assert.equal(row.actor_key, "person:dev-d");
  // No provider username was observed on this source. The config declares one, but
  // it is host-agnostic, so applying it here could link a wrong-host profile — the
  // row stays unlinked rather than guess.
  assert.equal(row.profile_url, undefined);
});

test("two identities whose names slug alike stay distinct people (no collision merge)", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "I_a", author: "alice", project_path: "o/repo", created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-06T00:00:00Z" }),
    itemRow({ item_id: 2, external_id: "I_b", author: "bob", project_path: "o/repo", created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-06T00:00:00Z" }),
  ];
  // "Dev A" and "dev-a" both slug to person:dev-a — they MUST NOT merge.
  const env = buildContract({
    sources, items, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z",
    identities: [
      { name: "Dev A", usernames: ["alice"] },
      { name: "dev-a", usernames: ["bob"] },
    ],
  });
  assert.deepEqual(validateContract(env), []);
  const rows = env.repo_metrics?.[0]?.top_actors ?? [];
  assert.equal(rows.length, 2, "distinct declared people remain two rows");
  assert.equal(new Set(rows.map((r) => r.actor_key)).size, 2, "canonical keys are unique");
  assert.equal(rows.reduce((n, r) => n + r.items_opened, 0), 2, "each person keeps their own item");
});

test("bot actors are filtered from top_actors but still count in totals", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  // One human plus four bots: two with official markers ([bot] suffix, GitLab
  // service-account username) and two unmarked (need the config list).
  const commit = (id: string, actor: string) =>
    activityRow({ external_id: id, kind: "commit", action: "committed", project_path: "o/repo", actor, occurred_at: "2026-06-07T10:00:00Z" });
  const activities: ActivityRow[] = [
    commit("c-human", "dev-a"),
    commit("c-dependabot-bot", "dependabot[bot]"),
    commit("c-gl-service", "project_1936_bot_f58c77dbc1"),
    commit("c-ghcq", "github-code-quality"),
    commit("c-dependabot", "dependabot"),
  ];

  // Auto-detection alone drops the two marked bots; the two unmarked ones remain.
  const auto = buildContract({ sources, items: [], activities, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z" });
  const autoRows = auto.repo_metrics?.[0]?.top_actors ?? [];
  assert.deepEqual(autoRows.map((r) => r.display_name).sort(), ["dependabot", "dev-a", "github-code-quality"], "marked bots auto-dropped; unmarked remain");

  // The config list removes the unmarked bots too, leaving only the human.
  const filtered = buildContract({
    sources, items: [], activities, labels: [], edges: [], generatedAt: "2026-06-08T00:00:00.000Z",
    excludeActors: ["dependabot", "github-code-quality"],
  });
  assert.deepEqual(validateContract(filtered), []);
  const metric = filtered.repo_metrics?.[0];
  const rows = metric?.top_actors ?? [];
  assert.deepEqual(rows.map((r) => r.display_name), ["dev-a"], "only the human remains");
  assert.equal(metric?.totals.commits, 5, "bot commits still count in totals");
  assert.equal(metric?.totals.activities, 5, "bot activity still counts in totals");
});

test("repo metric series buckets tile the 90-day window deterministically (no fence-post drift)", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "ISSUE_recent", project_path: "o/repo", created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-07T00:00:00Z" }),
  ];
  const activities: ActivityRow[] = [
    activityRow({ external_id: "commit-1", kind: "commit", action: "committed", project_path: "o/repo", actor: "alice", occurred_at: "2026-06-07T10:00:00Z" }),
    activityRow({ external_id: "push-1", kind: "push", action: "pushed", project_path: "o/repo", actor: "bob", occurred_at: "2026-06-07T11:00:00Z" }),
  ];
  const env = buildContract({ sources, items, labels: [], edges: [], activities, generatedAt: "2026-06-08T00:00:00.000Z" });
  const metric = env.repo_metrics?.[0];
  assert.equal(metric?.window.bucket, "week");
  const series = metric?.series ?? [];
  assert.equal(series.length, 13, "a 90-day window tiles into 12 full weeks + 1 clipped bucket");
  assert.equal(series[0]?.bucket_start, "2026-03-10T00:00:00.000Z");
  assert.equal(series[0]?.bucket_end, "2026-03-16T23:59:59.999Z");
  // Buckets are gap-free and overlap-free: each starts exactly 1ms after the
  // previous one ends. A fence-post regression in bucketRanges breaks this.
  for (let i = 1; i < series.length; i++) {
    assert.equal(
      Date.parse(series[i]!.bucket_start),
      Date.parse(series[i - 1]!.bucket_end) + 1,
      `bucket ${i} starts 1ms after bucket ${i - 1} ends`,
    );
  }
  assert.equal(series[12]?.bucket_start, "2026-06-02T00:00:00.000Z");
  assert.equal(series[12]?.bucket_end, "2026-06-08T00:00:00.000Z", "the last bucket is clipped to the window end, not a full week");
  // The two activities land in EXACTLY the last bucket — every other bucket is zero.
  series.forEach((p, i) => {
    assert.equal(p.stats.commits, i === 12 ? 1 : 0, `commits in bucket ${i}`);
    assert.equal(p.stats.pushes, i === 12 ? 1 : 0, `pushes in bucket ${i}`);
  });
});

test("malformed or non-object activity details degrade to null (and the envelope still validates)", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const activities: ActivityRow[] = [
    activityRow({ external_id: "a-bad", details: "{not json" }),
    activityRow({ external_id: "a-array", details: "[1,2]" }),
    activityRow({ external_id: "a-scalar", details: "42" }),
    activityRow({ external_id: "a-null", details: null }),
    activityRow({ external_id: "a-ok", details: "{\"sha\":\"abc1234\"}" }),
  ];
  // generatedAt kept near the default activityRow occurred_at (2026-01-01) so all
  // rows stay inside the 30-day emit window — this test is about details, not the
  // 4.0.0 windowing.
  const env = buildContract({ sources, items: [], labels: [], edges: [], activities, generatedAt: "2026-01-15T00:00:00.000Z" });
  const details = new Map(env.activities?.map((a) => [a.external_id, a.details]));
  assert.equal(details.get("a-bad"), null, "unparseable JSON degrades to null");
  assert.equal(details.get("a-array"), null, "a JSON array is not an object map");
  assert.equal(details.get("a-scalar"), null, "a JSON scalar is not an object map");
  assert.equal(details.get("a-null"), null);
  assert.deepEqual(details.get("a-ok"), { sha: "abc1234" });
  assert.deepEqual(validateContract(env), [], "the degraded envelope still passes the producer guard");
});

test("top_actors is capped at 5, ordered by activity volume, dropping the tail", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const activities: ActivityRow[] = [];
  for (let u = 1; u <= 7; u++) {
    for (let k = 0; k < 8 - u; k++) {
      // user1 gets 7 commits … user7 gets 1.
      activities.push(activityRow({
        external_id: `c-${u}-${k}`,
        kind: "commit",
        action: "committed",
        actor: `user${u}`,
        occurred_at: "2026-06-07T10:00:00Z",
      }));
    }
  }
  const env = buildContract({ sources, items: [], labels: [], edges: [], activities, generatedAt: "2026-06-08T00:00:00.000Z" });
  const actors = env.repo_metrics?.[0]?.top_actors ?? [];
  assert.deepEqual(
    actors.map((a) => [a.actor, a.activities]),
    [["user1", 7], ["user2", 6], ["user3", 5], ["user4", 4], ["user5", 3]],
    "exactly the 5 highest-volume actors, in order; user6/user7 are trimmed",
  );
});

test("buildContract drops repo_metrics for repos no longer in config that carry no items", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" },
  ];
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "ISSUE_cfg", project_path: "o/configured" }),
    // A repo dropped from config but whose synced items still live on the board.
    itemRow({ item_id: 2, external_id: "ISSUE_kept", project_path: "o/removed-has-items" }),
  ];
  // A repo dropped from config with NO items, surviving only via activity rows
  // (the activity table has no tombstone) — the "ghost" a removal should clear.
  const activities: ActivityRow[] = [
    activityRow({ external_id: "push-ghost", kind: "push", action: "pushed", project_path: "o/ghost", actor: "alice", occurred_at: "2026-06-07T10:00:00Z" }),
  ];

  // No configured set: every repo present in the data is emitted (historical
  // behavior — nothing is filtered).
  const unfiltered = buildContract({ sources, items, labels: [], edges: [], activities, generatedAt: "2026-06-08T00:00:00.000Z" });
  assert.deepEqual(
    (unfiltered.repo_metrics ?? []).map((m) => m.project_path).sort(),
    ["o/configured", "o/ghost", "o/removed-has-items"],
  );

  // With the configured set, a repo that is neither configured NOR item-bearing
  // (the activity-only ghost) drops out; configured repos and repos that still
  // carry items stay (board consistency).
  const filtered = buildContract({
    sources,
    items,
    labels: [],
    edges: [],
    activities,
    generatedAt: "2026-06-08T00:00:00.000Z",
    configuredRepos: [{ source_id: "github:github.com", project_path: "o/configured" }],
  });
  assert.deepEqual(
    (filtered.repo_metrics ?? []).map((m) => m.project_path).sort(),
    ["o/configured", "o/removed-has-items"],
  );
});
