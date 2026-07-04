import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createRangeApiServer } from "../src/cli/range-api.ts";
import { SyncController } from "../src/cli/sync-daemon.ts";
import { createAppServer, type AppServerOptions } from "../src/cli/app-server.ts";
import { buildActionableProjection, parseActionableOptions } from "../src/server/actionable.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import type { ItemRow, LabelRow, SourceRow } from "../src/db/store.ts";
import type { CanonicalItem, CanonicalLabel } from "../src/model/types.ts";
import type { SyncRunResult } from "../src/sync-runner.ts";

const SOURCE = "github:github.com";
const OTHER_SOURCE = "gitlab:gitlab.com";
const NOW = Date.parse("2026-07-04T12:00:00Z");

function sourceRow(over: Partial<SourceRow> = {}): SourceRow {
  return {
    source_id: SOURCE,
    kind: "github",
    host: "github.com",
    display_name: "GitHub",
    last_success_at: null,
    last_status: "ok",
    ...over,
  };
}

function row(over: Partial<ItemRow> = {}): ItemRow {
  return {
    item_id: 1,
    source_id: SOURCE,
    external_id: "ISSUE_1",
    kind: "issue",
    project_path: "example/repo",
    iid: 1,
    url: "https://example.test/1",
    title: "Example issue",
    body: null,
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "dev-a",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    review_state: null,
    ci_state: null,
    merge_state: null,
    open_review_threads: null,
    total_review_threads: null,
    comment_total: null,
    milestone: null,
    demand: 0,
    last_seen_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function label(item_id: number, name: string, color: string | null = null): LabelRow {
  const scope = name.includes("::") ? name.slice(0, name.indexOf("::")) : null;
  return {
    item_id,
    name,
    scope,
    color,
  };
}

function canonicalItem(over: Partial<CanonicalItem> = {}): CanonicalItem {
  return {
    sourceId: SOURCE,
    externalId: "ISSUE_1",
    kind: "issue",
    projectPath: "example/repo",
    iid: 1,
    url: "https://example.test/1",
    title: "Example issue",
    body: null,
    state: "open",
    stateRaw: "OPEN",
    stateReason: null,
    isDraft: null,
    author: "dev-a",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    reviewState: null,
    ciState: null,
    mergeState: null,
    openReviewThreads: null,
    totalReviewThreads: null,
    commentTotal: null,
    milestone: null,
    demand: 0,
    ...over,
  };
}

function canonicalLabel(name: string, color: string | null = null): CanonicalLabel {
  return { name, scope: name.includes("::") ? name.slice(0, name.indexOf("::")) : null, color };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function bucketItems(result: ReturnType<typeof buildActionableProjection>, bucket: string) {
  return result.buckets.find((g) => g.bucket === bucket)?.items ?? [];
}

test("actionable projection buckets open work and sorts within buckets", () => {
  const result = buildActionableProjection({
    sources: [sourceRow()],
    items: [
      row({
        item_id: 1,
        external_id: "PR_READY",
        kind: "change_request",
        iid: 10,
        title: "Ready PR",
        review_state: "approved",
        ci_state: "passing",
        merge_state: "mergeable",
        updated_at: "2026-07-03T00:00:00Z",
      }),
      row({
        item_id: 2,
        external_id: "PR_FAILING",
        kind: "change_request",
        iid: 11,
        title: "Failing PR",
        review_state: "approved",
        ci_state: "failing",
        merge_state: "mergeable",
        updated_at: "2026-06-15T00:00:00Z",
      }),
      row({
        item_id: 3,
        external_id: "PR_WAITING",
        kind: "change_request",
        iid: 12,
        title: "Waiting PR",
        review_state: "review_required",
        ci_state: "passing",
        merge_state: "mergeable",
      }),
      row({ item_id: 4, external_id: "PR_DRAFT", kind: "change_request", iid: 13, title: "Draft PR", is_draft: true }),
      row({ item_id: 5, external_id: "ISSUE_HIGH", iid: 20, title: "High demand issue", demand: 5, created_at: "2026-06-10T00:00:00Z" }),
      row({ item_id: 6, external_id: "ISSUE_LOW", iid: 21, title: "Low demand issue", demand: 1, created_at: "2026-06-01T00:00:00Z" }),
      row({ item_id: 7, external_id: "ISSUE_PARKED", iid: 22, title: "Parked issue" }),
      row({ item_id: 8, external_id: "CLOSED", iid: 23, title: "Closed issue", state: "closed" }),
    ],
    labels: [label(1, "priority::p2"), label(7, "state::needs-decision")],
    configuredRepos: [{ source_id: SOURCE, project_path: "example/repo" }],
    nowMs: NOW,
    staleDays: 14,
  });

  assert.equal(result.total, 7, "closed rows are not candidates");
  assert.deepEqual(bucketItems(result, "ready-to-merge").map((i) => i.title), ["Ready PR"]);
  assert.deepEqual(bucketItems(result, "needs-work").map((i) => i.title), ["Failing PR"]);
  assert.deepEqual(bucketItems(result, "awaiting-review").map((i) => i.title), ["Waiting PR"]);
  assert.deepEqual(bucketItems(result, "draft-prs").map((i) => i.title), ["Draft PR"]);
  assert.deepEqual(bucketItems(result, "ready-to-pick-up").map((i) => i.title), ["High demand issue", "Low demand issue"]);
  assert.deepEqual(bucketItems(result, "parked").map((i) => i.title), ["Parked issue"]);
  assert.ok(bucketItems(result, "ready-to-merge")[0]?.flags.includes("priority:priority::p2"));
  assert.ok(bucketItems(result, "needs-work")[0]?.flags.includes("ci:failing"));
});

test("actionable projection defaults to active configured repos", () => {
  const items = [
    row({ item_id: 1, external_id: "CONFIGURED", project_path: "example/repo", title: "Configured issue" }),
    row({ item_id: 2, external_id: "OLD", project_path: "old/repo", title: "Old issue" }),
    row({ item_id: 3, external_id: "OTHER_SOURCE", source_id: OTHER_SOURCE, project_path: "group/project", title: "Other source issue" }),
  ];
  const configuredRepos = [
    { source_id: SOURCE, project_path: "example/repo" },
    { source_id: OTHER_SOURCE, project_path: "group/project" },
  ];

  const filtered = buildActionableProjection({
    sources: [sourceRow(), sourceRow({ source_id: OTHER_SOURCE, kind: "gitlab", host: "gitlab.com", display_name: "GitLab" })],
    items,
    labels: [],
    configuredRepos,
    includeUnconfigured: false,
    nowMs: NOW,
  });
  assert.deepEqual(bucketItems(filtered, "ready-to-pick-up").map((i) => i.title), ["Configured issue", "Other source issue"]);

  const all = buildActionableProjection({
    sources: [sourceRow()],
    items,
    labels: [],
    configuredRepos,
    includeUnconfigured: true,
    nowMs: NOW,
  });
  assert.equal(all.total, 3);
  assert.ok(bucketItems(all, "ready-to-pick-up").find((i) => i.title === "Old issue")?.flags.includes("unconfigured"));
});

test("actionable query parser validates limit and stale_days", () => {
  assert.deepEqual(parseActionableOptions(new URL("http://x.test/api/actionable?limit=3&stale_days=9&include_unconfigured=1")), {
    limit: 3,
    staleDays: 9,
    repo: null,
    source: null,
    includeUnconfigured: true,
  });
  assert.throws(() => parseActionableOptions(new URL("http://x.test/api/actionable?limit=0")), /limit must be a positive integer/);
  assert.throws(() => parseActionableOptions(new URL("http://x.test/api/actionable?stale_days=-1")), /stale_days must be a non-negative number/);
});

async function sandbox(): Promise<{ dir: string; configPath: string; dbPath: string; contractOut: string }> {
  const dir = mkdtempSync(join(tmpdir(), "actionable-test-"));
  const dbPath = join(dir, "data", "board.db");
  const configPath = join(dir, "config", "sources.json");
  const contractOut = join(dir, "data", "contract.json");
  const db = await openSqliteStore(dbPath);
  try {
    await db.ensureSource({ sourceId: SOURCE, kind: "github", host: "github.com", displayName: "GitHub" }, "2026-07-04T00:00:00Z");
    const configured = await db.upsertItem(canonicalItem({ externalId: "CONFIGURED", title: "Configured issue", demand: 2 }), "test", "2026-07-04T00:00:00Z");
    await db.replaceLabels(configured, [canonicalLabel("priority::p2", "fbca04")]);
    await db.upsertItem(canonicalItem({ externalId: "OLD", projectPath: "old/repo", iid: 2, title: "Old issue" }), "test", "2026-07-04T00:00:00Z");
    await db.upsertItem(canonicalItem({ externalId: "CLOSED", iid: 3, title: "Closed issue", state: "closed", closedAt: "2026-07-04T00:00:00Z" }), "test", "2026-07-04T00:00:00Z");
  } finally {
    await db.close();
  }
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      db_path: dbPath,
      timezone: "UTC",
      sources: [
        {
          source_id: SOURCE,
          kind: "github",
          host: "github.com",
          token_env: "ACTIONABLE_TEST_TOKEN_UNSET",
          graphql_url: "https://api.github.com/graphql",
          projects: ["example/repo"],
        },
      ],
    }),
  );
  return { dir, configPath, dbPath, contractOut };
}

test("range-api mounts read-only actionable discovery", async () => {
  const { dir, configPath, contractOut } = await sandbox();
  const server = createRangeApiServer({ configPath, contractOut });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/actionable?limit=1&stale_days=1`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.total, 1);
    assert.deepEqual(body.bucket_order, ["ready-to-merge", "awaiting-review", "needs-work", "in-progress", "ready-to-pick-up", "draft-prs", "parked"]);
    assert.deepEqual(body.buckets.find((g: { bucket: string }) => g.bucket === "ready-to-pick-up").items.map((i: { title: string }) => i.title), ["Configured issue"]);
    assert.equal(body.buckets.find((g: { bucket: string }) => g.bucket === "ready-to-pick-up").more, 0);

    const withOld = await json(await fetch(`${base}/api/actionable?include_unconfigured=1`));
    assert.equal(withOld.total, 2);
    assert.ok(
      withOld.buckets
        .find((g: { bucket: string }) => g.bucket === "ready-to-pick-up")
        .items.find((i: { title: string; flags: string[] }) => i.title === "Old issue")
        .flags.includes("unconfigured"),
    );

    const bad = await fetch(`${base}/api/actionable?limit=0`);
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error, "bad_request");
    assert.equal((await fetch(`${base}/api/actionable`, { method: "POST" })).status, 404);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone app server mounts actionable discovery", async () => {
  const { dir, configPath, contractOut } = await sandbox();
  const opts: AppServerOptions = {
    configPath,
    contractOut,
    controlEnabled: false,
    configControlEnabled: false,
    logsEnabled: false,
    secretsPath: null,
    intervalSeconds: 120,
    fullEvery: 30,
    capabilities: {
      liveReadBaseUrl: null,
      providerWebhooks: [],
      allowlistProjects: [],
      webhookSetup: null,
    },
  };
  const okResult: SyncRunResult = { status: "ok", sources: [], totals: { items: 0, edges: 0, activities: 0, soft_deleted: 0, soft_deleted_edges: 0 }, emitted: true, error: null };
  const server = createAppServer(new SyncController({ run: () => Promise.resolve(okResult) }), opts);
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/actionable`);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).total, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
