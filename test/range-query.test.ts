import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteStore, openSqliteStoreReadOnly } from "../src/db/sqlite.ts";
import { buildRangeContract } from "../src/contract/build.ts";
import { validateContract } from "../src/contract/validate.ts";
import type { ActivityRow, EdgeRow, ItemRow, SourceRow } from "../src/db/store.ts";
import type { CanonicalActivity, CanonicalItem } from "../src/model/types.ts";
import type { ReconciledEdge } from "../src/model/edges.ts";
import { toLabel } from "../src/model/labels.ts";

const SQLITE_SCHEMA_DIR = join(process.cwd(), "schema", "sqlite");
const SQLITE_V4_MIGRATIONS = [
  "0001_init.sql",
  "0002_activity.sql",
  "0003_actor_identity.sql",
  "0004_review_threads.sql",
];

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
    author: "dev-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-05-15T12:00:00Z",
    closedAt: null,
    mergedAt: null,
    reviewState: null,
    ciState: null,
    mergeState: null,
    openReviewThreads: null,
    totalReviewThreads: null,
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
    actor: "dev-a",
    actorKey: "provider-user:github:github.com:dev-a",
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
    author: "dev-a",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-05-15T12:00:00Z",
    closed_at: null,
    merged_at: null,
    review_state: null,
    ci_state: null,
    merge_state: null,
    open_review_threads: null,
    total_review_threads: null,
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
    actor: "dev-a",
    actor_key: "provider-user:github:github.com:dev-a",
    occurred_at: "2026-05-16T12:00:00Z",
    summary: "Closed issue #1",
    details: null,
    first_seen_at: null,
    last_seen_at: null,
    ...over,
  };
}

function createLegacySqliteV4Store(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    SQLITE_V4_MIGRATIONS.forEach((file, index) => {
      db.exec(readFileSync(join(SQLITE_SCHEMA_DIR, file), "utf8"));
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
    db.prepare(`INSERT INTO source (source_id, kind, host, display_name, created_at) VALUES (?,?,?,?,?)`)
      .run("github:github.com", "github", "github.com", "GitHub", "2026-06-01T00:00:00Z");
    const insertActivity = db.prepare(
      `INSERT INTO activity (
         source_id, external_id, kind, action, project_path, target_kind,
         target_source_id, target_external_id, target_iid, title, url, actor,
         occurred_at, summary, details, first_seen_at, last_seen_at, actor_key
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insertActivity.run(
      "github:github.com",
      "legacy-earliest",
      "commit",
      "committed",
      "sympoies/symphony-board",
      "commit",
      null,
      null,
      null,
      "Legacy earliest",
      "https://example/commit/1",
      "dev-a",
      "2026-01-01T05:00:00.000+08:00",
      null,
      "{}",
      "2026-06-01T00:00:00Z",
      "2026-06-01T00:00:00Z",
      "provider-user:github:github.com:dev-a",
    );
    insertActivity.run(
      "github:github.com",
      "legacy-latest",
      "commit",
      "committed",
      "sympoies/symphony-board",
      "commit",
      null,
      null,
      null,
      "Legacy latest",
      "https://example/commit/2",
      "dev-a",
      "2026-05-31T20:00:00.000-10:00",
      null,
      "{}",
      "2026-06-01T00:00:00Z",
      "2026-06-01T00:00:00Z",
      "provider-user:github:github.com:dev-a",
    );
  } finally {
    db.close();
  }
}

test("buildRangeContract returns explicit range rows with endpoint closure and activity filtering", () => {
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  const items: ItemRow[] = [
    itemRow({ item_id: 1, external_id: "ISSUE_recent", updated_at: "2026-05-31T23:59:59Z" }),
    itemRow({ item_id: 2, external_id: "PR_old", kind: "change_request", iid: 2, title: "Old PR", state: "merged", state_raw: "MERGED", is_draft: false, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", merged_at: "2025-01-02T00:00:00Z" }),
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
  // A windowed range response now also carries the board-wide aggregates and a
  // calendar activity_daily so a mobile client that loads it AS its primary env
  // (the board-scope setting) gets working Board/Graph stat bars and an Activity
  // Overview instead of blank panels. activity_daily counts the SAME in-range
  // activities the response emits (one here), never the out-of-range rows.
  assert.ok((env.aggregates?.length ?? 0) > 0, "range response carries board-wide aggregates");
  assert.ok(env.activity_daily != null, "range response carries activity_daily");
  assert.equal(env.activity_daily?.total, 1, "activity_daily reconciles with the in-range activities (the out-of-range row is excluded)");
});

test("buildRangeContract keeps data_quality coverage all-time when no activity falls inside the range", () => {
  // Repo coverage (observed_since / last_activity_at / activity_available) is a
  // documented ALL-TIME bound (docs/CONTRACT.md). On /api/range the response
  // activity list is range-bounded, so coverage must come from the separate
  // all-time bounds (Store.listRepoActivityBounds), not the windowed rows —
  // otherwise a repo with history but no in-range events wrongly reports
  // "No activity rows observed" and a null coverage badge.
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  const env = buildRangeContract({
    sources: [source],
    items: [itemRow({ item_id: 1, updated_at: "2026-05-15T00:00:00Z" })],
    labels: [],
    edges: [],
    activities: [], // range-bounded read: no activity inside the selected range
    repoActivityBounds: [
      { source_id: "github:github.com", project_path: "sympoies/symphony-board", observed_since: "2025-01-01T00:00:00Z", last_activity_at: "2026-02-01T00:00:00Z" },
    ],
    generatedAt: "2026-06-08T00:00:00Z",
    range: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-07T23:59:59.999Z" },
  });
  const metric = env.repo_metrics?.[0];
  const dq = metric?.data_quality;
  assert.equal(dq?.activity_available, true, "coverage stays all-time, not range-bounded");
  assert.equal(dq?.observed_since, "2025-01-01T00:00:00Z");
  assert.equal(dq?.last_activity_at, "2026-02-01T00:00:00Z");
  assert.equal(metric?.totals.activities, 0, "in-window activity totals stay range-scoped");
  assert.equal(dq?.notes.some((n) => n.includes("No activity rows observed")) ?? false, false, "no missing-activity note when all-time activity exists");
  // activity_daily follows the IN-RANGE activities (none here), while aggregates
  // follows the FULL item set — the two must not be conflated. With no in-range
  // activity but a (full-set) item present, activity_daily is an empty-but-valid
  // panel and aggregates still populate, so the mobile windowed board renders.
  assert.equal(env.activity_daily?.total, 0, "activity_daily counts only in-range activities (none)");
  assert.equal(env.activity_daily?.days.length, 0, "no in-range activity -> no day buckets");
  assert.equal(env.activity_daily?.to, "2026-06-08", "activity_daily anchors to the generatedAt calendar day");
  assert.ok((env.aggregates?.length ?? 0) > 0, "aggregates stay full-set even when no activity is in range");
  assert.deepEqual(validateContract(env), []);
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

test("buildRangeContract buckets activity_daily by the configured zone's calendar day", () => {
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  // Two events 1h apart that straddle Taipei (+08:00) midnight: 15:30Z is
  // 2026-06-08 23:30 local, 16:30Z is 2026-06-09 00:30 local. Under UTC both land
  // on 2026-06-08; under Asia/Taipei they split across two calendar days. This
  // pins activity_daily's zone bucketing (distinct from repo_metrics, covered
  // separately), and that `to` anchors to the zoned generatedAt day.
  const env = buildRangeContract({
    sources: [source],
    items: [itemRow({ item_id: 1, updated_at: "2026-06-09T00:00:00Z" })],
    labels: [],
    edges: [],
    activities: [
      activityRow({ external_id: "before-midnight", occurred_at: "2026-06-08T15:30:00Z" }),
      activityRow({ external_id: "after-midnight", occurred_at: "2026-06-08T16:30:00Z" }),
    ],
    generatedAt: "2026-06-09T12:00:00Z",
    timezone: "Asia/Taipei",
    range: { from: "2026-06-08T00:00:00.000Z", to: "2026-06-09T23:59:59.999Z" },
  });
  assert.equal(env.activity_daily?.timezone, "Asia/Taipei");
  assert.equal(env.activity_daily?.total, 2, "both in-range events are counted");
  assert.equal(env.activity_daily?.to, "2026-06-09", "to anchors to the zoned generatedAt day");
  assert.deepEqual(
    env.activity_daily?.days.map((d) => d.date),
    ["2026-06-08", "2026-06-09"],
    "events split across the Taipei midnight boundary, not bucketed as one UTC day",
  );
  assert.deepEqual(validateContract(env), []);
});

test("repo-metric sub-day series tiles a single local day into 12 two-hour buckets aligned to the zone", () => {
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  // One Taipei calendar day (2026-06-09), expanded at +08:00 by the range API:
  // 2026-06-08T16:00Z .. 2026-06-09T15:59:59.999Z. A single day now resolves the
  // TREND sparkline at 2-hour granularity (12 bars) instead of one flat bucket.
  const range = { from: "2026-06-08T16:00:00.000Z", to: "2026-06-09T15:59:59.999Z" };
  const tpe = buildRangeContract({
    sources: [source],
    items: [itemRow({ item_id: 1, updated_at: "2026-06-09T02:00:00Z" })],
    labels: [],
    edges: [],
    // Taipei 10:00 (UTC 02:00) -> the 10:00-12:00 local bucket (index 5).
    activities: [activityRow({ occurred_at: "2026-06-09T02:00:00Z", kind: "commit", action: "committed" })],
    generatedAt: "2026-06-09T18:00:00Z",
    timezone: "Asia/Taipei",
    range,
  });
  const metric = tpe.repo_metrics?.[0];
  assert.deepEqual(validateContract(tpe), []);
  assert.equal(metric?.window.bucket, "2h");
  const series = metric?.series ?? [];
  assert.equal(series.length, 12, "one local day tiles into 12 two-hour buckets");
  assert.equal(series[0]?.bucket_start, "2026-06-08T16:00:00.000Z", "first bucket starts at the local day start");
  assert.equal(series[11]?.bucket_end, "2026-06-09T15:59:59.999Z", "last bucket ends at the local day end");
  // Each 2h bucket starts exactly 1ms after the previous ends (no fence-post drift).
  for (let i = 1; i < series.length; i++) {
    assert.equal(Date.parse(series[i]!.bucket_start), Date.parse(series[i - 1]!.bucket_end) + 1, `bucket ${i} is contiguous`);
  }
  // The single commit lands in exactly one bucket (Taipei 10:00 -> index 5); the rest are zero.
  series.forEach((p, i) => assert.equal(p.stats.commits, i === 5 ? 1 : 0, `commits in bucket ${i}`));
});

test("repo-metric sub-day buckets widen with the range: 2 days -> 4h, 3 days -> 6h, 4 days -> day", () => {
  const source: SourceRow = { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
  // One item is enough to materialize a repo row; series length is range-driven,
  // not data-driven, so the exact item instant does not matter here.
  const common = { sources: [source], items: [itemRow({ item_id: 1, updated_at: "2026-06-10T05:00:00Z" })], labels: [], edges: [], activities: [], generatedAt: "2026-06-14T00:00:00Z", timezone: "UTC" };

  // 2 UTC days (48h) -> 4-hour buckets -> 12 bars.
  const twoDay = buildRangeContract({ ...common, range: { from: "2026-06-10T00:00:00.000Z", to: "2026-06-11T23:59:59.999Z" } });
  assert.deepEqual(validateContract(twoDay), []);
  assert.equal(twoDay.repo_metrics?.[0]?.window.bucket, "4h");
  assert.equal(twoDay.repo_metrics?.[0]?.series.length, 12);

  // 3 UTC days (72h) -> 6-hour buckets -> 12 bars.
  const threeDay = buildRangeContract({ ...common, range: { from: "2026-06-10T00:00:00.000Z", to: "2026-06-12T23:59:59.999Z" } });
  assert.deepEqual(validateContract(threeDay), []);
  assert.equal(threeDay.repo_metrics?.[0]?.window.bucket, "6h");
  assert.equal(threeDay.repo_metrics?.[0]?.series.length, 12);

  // 4 days falls back to whole-day buckets (the prior behavior, capped to 16 bars in the UI).
  const fourDay = buildRangeContract({ ...common, range: { from: "2026-06-10T00:00:00.000Z", to: "2026-06-13T23:59:59.999Z" } });
  assert.equal(fourDay.repo_metrics?.[0]?.window.bucket, "day");
  assert.equal(fourDay.repo_metrics?.[0]?.series.length, 4);
});

test("openSqliteStoreReadOnly can read but cannot write or migrate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-range-"));
  const dbPath = join(dir, "store.db");
  try {
    const db = await openSqliteStore(dbPath);
    await db.ensureSource({ sourceId: "github:github.com", kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");
    const itemId = await db.upsertItem(item(), "test", "2026-06-01T00:00:00Z");
    await db.replaceLabels(itemId, [toLabel("state::ready")]);
    await db.upsertItem(item({ externalId: "PR_old", kind: "change_request", state: "merged", updatedAt: "2025-01-01T00:00:00Z" }), "test", "2026-06-01T00:00:00Z");
    await db.upsertEdge(edge(), "2026-06-01T00:00:00Z");
    await db.upsertActivity(activity(), "2026-06-01T00:00:00Z");
    await db.close();

    const ro = await openSqliteStoreReadOnly(dbPath);
    assert.equal((await ro.listSources()).length, 1);
    assert.equal((await ro.listLiveItems()).length, 2);
    assert.equal((await ro.listLabels()).length, 1);
    assert.equal((await ro.listLiveEdges()).length, 1);
    assert.equal((await ro.listActivities()).length, 1);
    await assert.rejects(
      ro.ensureSource({ sourceId: "x", kind: "github", host: "x", displayName: null }, "2026-06-01T00:00:00Z"),
      /readonly|read-only|attempt/i,
    );
    await ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite migrations from v4 backfill cached repo activity bounds and review-thread detail schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-bounds-migration-"));
  const dbPath = join(dir, "store.db");
  try {
    createLegacySqliteV4Store(dbPath);

    const db = await openSqliteStore(dbPath);
    const diag = await db.diagnostics();
    assert.equal(diag.schema_version, 7, "opening a v4 store applies later migrations");
    assert.equal((await db.overview(1)).tables.repo_activity_bounds, 1, "the summary table is backfilled once per repo");
    const bounds = await db.listRepoActivityBounds();
    assert.equal(bounds.length, 1);
    assert.equal(bounds[0]?.observed_since, "2026-01-01T05:00:00.000+08:00", "backfill preserves instant-earliest row text");
    assert.equal(bounds[0]?.last_activity_at, "2026-05-31T20:00:00.000-10:00", "backfill preserves instant-latest row text");
    await db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRepoActivityBounds skips activity rows whose occurred_at does not parse (SQLite)", async () => {
  // occurred_at is stored as TEXT and upsertActivity does not validate it. An
  // unparsable instant makes julianday() NULL, which SQLite would sort FIRST for
  // the ascending bound — so the bad string could surface as observed_since. The
  // bounds query must skip such rows, matching the prior JS coverage helper.
  const dir = mkdtempSync(join(tmpdir(), "sb-bounds-"));
  const dbPath = join(dir, "store.db");
  try {
    const db = await openSqliteStore(dbPath);
    await db.ensureSource({ sourceId: "github:github.com", kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");
    await db.upsertActivity(activity({ externalId: "good", occurredAt: "2026-05-16T12:00:00Z" }), "2026-06-01T00:00:00Z");
    await db.upsertActivity(activity({ externalId: "bad", occurredAt: "not-a-timestamp" }), "2026-06-01T00:00:00Z");
    await db.close();

    const ro = await openSqliteStoreReadOnly(dbPath);
    const bounds = await ro.listRepoActivityBounds();
    assert.equal(bounds.length, 1, "one repo row");
    assert.equal(bounds[0]?.observed_since, "2026-05-16T12:00:00Z", "the unparsable row is skipped, not surfaced as the earliest bound");
    assert.equal(bounds[0]?.last_activity_at, "2026-05-16T12:00:00Z");
    await ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
