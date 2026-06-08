import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContract } from "../src/contract/build.ts";
import { CONTRACT_VERSION } from "../src/contract/version.ts";
import type { ActivityRow, ItemRow, LabelRow, EdgeRow, SourceRow } from "../src/db/repo.ts";

function itemRow(over: Partial<ItemRow>): ItemRow {
  return {
    item_id: 1,
    source_id: "github:github.com",
    external_id: "ISSUE_abc",
    kind: "issue",
    project_path: "graysurf/repo",
    iid: 7,
    url: "https://github.com/graysurf/repo/issues/7",
    title: "An issue",
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "graysurf",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    review_state: null,
    ci_state: null,
    merge_state: null,
    milestone: null,
    demand: 3,
    last_seen_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function activityRow(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    source_id: "github:github.com",
    external_id: "activity-1",
    kind: "issue",
    action: "opened",
    project_path: "graysurf/repo",
    target_kind: "issue",
    target_source_id: "github:github.com",
    target_external_id: "ISSUE_abc",
    target_iid: 7,
    title: "An issue",
    url: "https://github.com/graysurf/repo/issues/7",
    actor: "graysurf",
    occurred_at: "2026-01-01T00:00:00Z",
    summary: "Opened issue #7",
    details: "{\"source\":\"test\"}",
    first_seen_at: "2026-06-01T00:00:00Z",
    last_seen_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

test("buildContract emits a versioned envelope with composite-ref ids", () => {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: "2026-06-01T00:00:00Z", last_status: "ok" },
  ];
  const items: ItemRow[] = [itemRow({ item_id: 1 }), itemRow({ item_id: 2, external_id: "PR_xyz", kind: "change_request", state: "merged", is_draft: 0 })];
  const labels: LabelRow[] = [{ item_id: 1, name: "bug", scope: null, color: "red" }];
  const edges: EdgeRow[] = [
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_xyz", to_source_id: "github:github.com", to_external_id: "ISSUE_abc", from_state: "merged", to_state: "open", lifecycle: "declared" },
  ];

  const env = buildContract({ sources, items, labels, edges, generatedAt: "2026-06-02T00:00:00Z" });

  assert.equal(env.contract_version, CONTRACT_VERSION);
  assert.equal(env.items.length, 2);
  assert.equal(env.items[0]!.id, "github:github.com|ISSUE_abc");
  assert.equal(env.items[0]!.labels.length, 1);
  assert.equal(env.items[1]!.is_draft, false); // 0 -> false
  assert.equal(env.edges.length, 1);
  assert.equal(env.edges[0]!.from, "github:github.com|PR_xyz");
  assert.equal(env.edges[0]!.to, "github:github.com|ISSUE_abc");
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
    repoColors: [{ source_id: "github:github.com", project_path: "graysurf/repo", color: "#e0af68" }],
  });
  assert.equal(env.sources[0]!.color, "#1f6feb"); // set
  assert.equal(env.sources[1]!.color, null); // unset -> null
  assert.deepEqual(env.repos, [{ source_id: "github:github.com", project_path: "graysurf/repo", color: "#e0af68" }]);
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
    activities: [activityRow()],
    generatedAt: "2026-06-02T00:00:00Z",
  });
  assert.equal(env.activities?.length, 1);
  assert.equal(env.activities![0]!.id, "github:github.com|activity-1");
  assert.equal(env.activities![0]!.target_ref, "github:github.com|ISSUE_abc");
  assert.deepEqual(env.activities![0]!.details, { source: "test" });
});
