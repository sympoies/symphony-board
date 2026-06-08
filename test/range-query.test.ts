import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, openDbReadOnly } from "../src/db/open.ts";
import { ensureSource, listActivities, listLabels, listLiveEdges, listLiveItems, listSources, replaceLabels, upsertActivity, upsertEdge, upsertItem } from "../src/db/repo.ts";
import { buildRangeContract } from "../src/contract/build.ts";
import { validateContract } from "../src/contract/validate.ts";
import type { ActivityRow, EdgeRow, ItemRow, SourceRow } from "../src/db/repo.ts";
import type { CanonicalActivity, CanonicalItem } from "../src/model/types.ts";
import type { ReconciledEdge } from "../src/model/edges.ts";
import { toLabel } from "../src/model/labels.ts";

function item(over: Partial<CanonicalItem> = {}): CanonicalItem {
  return {
    sourceId: "github:github.com",
    externalId: "ISSUE_recent",
    kind: "issue",
    projectPath: "sympoies/symphony-board",
    iid: 1,
    url: "https://example/1",
    title: "Recent issue",
    state: "open",
    stateRaw: "OPEN",
    stateReason: null,
    isDraft: null,
    author: "graysurf",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-05-15T12:00:00Z",
    closedAt: null,
    mergedAt: null,
    reviewState: null,
    ciState: null,
    mergeState: null,
    milestone: null,
    demand: 0,
    ...over,
  };
}

function edge(over: Partial<ReconciledEdge> = {}): ReconciledEdge {
  return {
    type: "closes",
    from: { sourceId: "github:github.com", externalId: "PR_old" },
    to: { sourceId: "github:github.com", externalId: "ISSUE_recent" },
    fromState: "merged",
    toState: "open",
    lifecycle: "declared",
    discoveredFrom: "from",
    ...over,
  };
}

function activity(over: Partial<CanonicalActivity> = {}): CanonicalActivity {
  return {
    sourceId: "github:github.com",
    externalId: "activity-recent",
    kind: "issue",
    action: "closed",
    projectPath: "sympoies/symphony-board",
    targetKind: "issue",
    target: { sourceId: "github:github.com", externalId: "ISSUE_recent" },
    targetIid: 1,
    title: "Recent activity",
    url: "https://example/1",
    actor: "graysurf",
    actorKey: "provider-user:github:github.com:graysurf",
    occurredAt: "2026-05-16T12:00:00Z",
    summary: "Closed issue #1",
    details: { source: "test" },
    ...over,
  };
}

function itemRow(over: Partial<ItemRow> = {}): ItemRow {
  return {
    item_id: 1,
    source_id: "github:github.com",
    external_id: "ISSUE_recent",
    kind: "issue",
    project_path: "sympoies/symphony-board",
    iid: 1,
    url: "https://example/1",
    title: "Recent issue",
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "graysurf",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-05-15T12:00:00Z",
    closed_at: null,
    merged_at: null,
    review_state: null,
    ci_state: null,
    merge_state: null,
    milestone: null,
    demand: 0,
    last_seen_at: "2026-05-15T12:00:00Z",
    ...over,
  };
}

function activityRow(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    source_id: "github:github.com",
    external_id: "activity-recent",
    kind: "issue",
    action: "closed",
    project_path: "sympoies/symphony-board",
    target_kind: "issue",
    target_source_id: "github:github.com",
    target_external_id: "ISSUE_recent",
    target_iid: 1,
    title: "Recent activity",
    url: "https://example/1",
    actor: "graysurf",
    actor_key: "provider-user:github:github.com:graysurf",
    occurred_at: "2026-05-16T12:00:00Z",
    summary: "Closed issue #1",
    details: null,
    first_seen_at: null,
    last_seen_at: null,
    ...over,
  };
}

test("buildRangeContract returns explicit range rows with endpoint closure and activity filtering", () => {
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "ISSUE_recent", updated_at: "2026-05-31T23:59:59Z" }),
    itemRow({ item_id: 2, external_id: "PR_old", kind: "change_request", iid: 2, title: "Old PR", state: "merged", state_raw: "MERGED", is_draft: 0, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", merged_at: "2025-01-02T00:00:00Z" }),
    itemRow({ item_id: 3, external_id: "ISSUE_older", iid: 3, title: "Older issue", state: "closed", state_raw: "CLOSED", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", closed_at: "2025-01-02T00:00:00Z" }),
  ];
  const edges: EdgeRow[] = [
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_old", to_source_id: "github:github.com", to_external_id: "ISSUE_recent", from_state: "merged", to_state: "open", lifecycle: "declared" },
  ];
  const activities: ActivityRow[] = [
    activityRow({ occurred_at: "2026-05-31T23:59:59Z" }),
    activityRow({ external_id: "activity-old", target_source_id: null, target_external_id: null, target_iid: null, occurred_at: "2025-01-01T00:00:00Z" }),
  ];
  const env = buildRangeContract({
    sources: [source],
    items,
    labels: [{ item_id: 1, name: "type::feature", scope: "type", color: null }],
    edges,
    activities,
    generatedAt: "2026-06-08T00:00:00Z",
    range: { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" },
  });

  assert.deepEqual(env.range_query, { kind: "time_range", timezone: "UTC", from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" });
  assert.deepEqual(validateContract(env), []);
  assert.deepEqual(env.items.map((it) => [it.external_id, it.window_reasons]).sort(), [
    ["ISSUE_recent", ["primary", "edge_endpoint"]],
    ["PR_old", ["edge_endpoint"]],
  ]);
  assert.equal(env.items.find((it) => it.external_id === "ISSUE_recent")?.labels[0]?.name, "type::feature");
  assert.equal(env.item_window?.primary_items, 1);
  assert.equal(env.item_window?.edge_endpoint_items, 1);
  assert.equal(env.item_window?.total_items, 3);
  assert.equal(env.edges.length, 1);
  assert.deepEqual(env.activities?.map((a) => a.external_id), ["activity-recent"]);
  assert.equal(env.repo_stats?.[0]?.items, 3, "repo stats remain full canonical counts");
  assert.equal(env.repo_metrics?.[0]?.window.kind, "time_range");
  assert.equal(env.repo_metrics?.[0]?.window.from, "2026-05-01T00:00:00.000Z");
  assert.equal(env.repo_metrics?.[0]?.window.to, "2026-05-31T23:59:59.999Z");
  assert.equal(env.repo_metrics?.[0]?.window.bucket, "day");
  assert.equal(env.repo_metrics?.[0]?.totals.items_active, 1);
  assert.equal(env.repo_metrics?.[0]?.totals.activities, 1);
  assert.equal(env.repo_metrics?.[0]?.totals.activity_score, 0);
});

test("buildRangeContract carries the configured timezone onto the envelope and range_query", () => {
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  const env = buildRangeContract({
    sources: [source],
    items: [itemRow({ item_id: 1, updated_at: "2026-05-15T00:00:00Z" })],
    labels: [],
    edges: [],
    activities: [],
    generatedAt: "2026-06-08T00:00:00Z",
    timezone: "Asia/Taipei",
    // The range-api expands date queries at the zone boundary; here we pass the
    // resulting instants and assert the zone label rides along on the response.
    range: { from: "2026-04-30T16:00:00.000Z", to: "2026-05-31T15:59:59.999Z" },
  });
  assert.equal(env.timezone, "Asia/Taipei");
  assert.deepEqual(env.range_query, { kind: "time_range", timezone: "Asia/Taipei", from: "2026-04-30T16:00:00.000Z", to: "2026-05-31T15:59:59.999Z" });
  assert.deepEqual(validateContract(env), []);
});

test("repo-metric series buckets align to the configured timezone", () => {
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  // One Taipei calendar day (2026-06-09), expanded at +08:00 by the range API:
  // 2026-06-08T16:00Z .. 2026-06-09T15:59:59.999Z. It straddles two UTC days.
  const range = { from: "2026-06-08T16:00:00.000Z", to: "2026-06-09T15:59:59.999Z" };
  const common = {
    sources: [source],
    items: [itemRow({ item_id: 1, updated_at: "2026-06-09T02:00:00Z" })],
    labels: [],
    edges: [],
    activities: [activityRow({ occurred_at: "2026-06-09T02:00:00Z" })],
    generatedAt: "2026-06-09T18:00:00Z",
    range,
  };

  const tpe = buildRangeContract({ ...common, timezone: "Asia/Taipei" });
  const tpeSeries = tpe.repo_metrics?.[0]?.series ?? [];
  assert.equal(tpeSeries.length, 1, "one local day is exactly one day bucket");
  assert.equal(tpeSeries[0]?.bucket_start, "2026-06-08T16:00:00.000Z");
  assert.equal(tpeSeries[0]?.bucket_end, "2026-06-09T15:59:59.999Z");

  const utc = buildRangeContract({ ...common, timezone: "UTC" });
  assert.equal(utc.repo_metrics?.[0]?.series.length, 2, "the same instants straddle two UTC days");
});

test("openDbReadOnly can read but cannot write or migrate", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-range-"));
  const dbPath = join(dir, "store.db");
  try {
    const db = openDb(dbPath);
    ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");
    const itemId = upsertItem(db, item(), "test", "2026-06-01T00:00:00Z");
    replaceLabels(db, itemId, [toLabel("state::ready")]);
    upsertItem(db, item({ externalId: "PR_old", kind: "change_request", state: "merged", updatedAt: "2025-01-01T00:00:00Z" }), "test", "2026-06-01T00:00:00Z");
    upsertEdge(db, edge(), "2026-06-01T00:00:00Z");
    upsertActivity(db, activity(), "2026-06-01T00:00:00Z");
    db.close();

    const ro = openDbReadOnly(dbPath);
    assert.equal(listSources(ro).length, 1);
    assert.equal(listLiveItems(ro).length, 2);
    assert.equal(listLabels(ro).length, 1);
    assert.equal(listLiveEdges(ro).length, 1);
    assert.equal(listActivities(ro).length, 1);
    assert.throws(() => ensureSource(ro, { sourceId: "x", kind: "github", host: "x", displayName: null }, "2026-06-01T00:00:00Z"), /readonly|read-only|attempt/i);
    ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
