// GET /api/stats store statistics (src/server/stats.ts): row counts and
// breakdowns over a seeded store, the sync-run history window, and the
// missing-store 404. The endpoint mounting itself is covered by
// app-server.test.ts (standalone) — the Docker api sidecar shares the handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { openSqliteStore, openSqliteStoreReadOnly } from "../src/db/sqlite.ts";
import { buildStoreStats, handleStatsRequest } from "../src/server/stats.ts";
import type { AppConfig } from "../src/config.ts";
import type { CanonicalActivity, CanonicalItem } from "../src/model/types.ts";
import type { ReconciledEdge } from "../src/model/edges.ts";

const SOURCE = "github:github.com";

function fixtureItem(over: Partial<CanonicalItem> = {}): CanonicalItem {
  return {
    sourceId: SOURCE,
    externalId: "ISSUE_1",
    kind: "issue",
    projectPath: "graysurf/repo",
    iid: 1,
    url: "https://example/1",
    title: "t",
    state: "open",
    stateRaw: "OPEN",
    stateReason: null,
    isDraft: null,
    author: "graysurf",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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

const FIXTURE_EDGE: ReconciledEdge = {
  type: "closes",
  from: { sourceId: SOURCE, externalId: "PR_1" },
  to: { sourceId: SOURCE, externalId: "ISSUE_1" },
  fromState: "merged",
  toState: "closed",
  lifecycle: "fulfilled",
  discoveredFrom: "from",
};

const FIXTURE_ACTIVITY: CanonicalActivity = {
  sourceId: SOURCE,
  externalId: "activity-1",
  kind: "issue",
  action: "opened",
  projectPath: "graysurf/repo",
  targetKind: "issue",
  target: { sourceId: SOURCE, externalId: "ISSUE_1" },
  targetIid: 1,
  title: "Opened an issue",
  url: "https://example/1",
  actor: "graysurf",
  actorKey: `provider-user:${SOURCE}:graysurf`,
  occurredAt: "2026-06-01T00:00:00Z",
  summary: "Opened issue #1",
  details: null,
};

test("buildStoreStats summarizes rows, breakdowns, tombstones, and sync runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-test-"));
  const path = join(dir, "stats.db");
  const db = await openSqliteStore(path);
  try {
    await db.ensureSource({ sourceId: SOURCE, kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");
    await db.upsertItem(fixtureItem(), "github/1", "2026-06-01T00:00:00Z");
    await db.upsertItem(fixtureItem({ externalId: "PR_1", kind: "change_request", state: "merged", mergedAt: "2026-05-30T00:00:00Z" }), "github/1", "2026-06-01T00:00:00Z");
    // Seen long before the cutoff, so the full-sweep rule tombstones it.
    await db.upsertItem(fixtureItem({ externalId: "ISSUE_OLD" }), "github/1", "2026-05-01T00:00:00Z");
    await db.softDeleteUnseenItems(SOURCE, "2026-05-15T00:00:00Z", "2026-06-01T00:00:00Z");
    await db.upsertEdge(FIXTURE_EDGE, "2026-06-01T00:00:00Z");
    await db.upsertActivity(FIXTURE_ACTIVITY, "2026-06-01T00:00:00Z");

    const ok = await db.startRun(SOURCE, "full", "2026-06-01T00:00:00Z");
    await db.finishRun(ok, "ok", "2026-06-01T00:00:30Z", 2, 1, 1, null);
    const failed = await db.startRun(SOURCE, "incremental", "2026-06-01T00:02:00Z");
    await db.finishRun(failed, "error", "2026-06-01T00:02:05Z", 0, 0, 0, "boom");
  } finally {
    await db.close();
  }

  const ro = await openSqliteStoreReadOnly(path);
  const stats = await buildStoreStats(ro, 10);
  const newestOnly = await buildStoreStats(ro, 1);
  await ro.close();
  rmSync(dir, { recursive: true, force: true });

  assert.ok(Number(stats.db.size_bytes) > 0, "store file size is reported");
  assert.ok(Number(stats.db.page_size) > 0 && Number(stats.db.page_count) > 0);
  assert.ok(Number(stats.db.schema_version) >= 3, "PRAGMA user_version rides along");

  assert.equal(stats.tables.item, 3, "table rows include tombstoned");
  assert.equal(stats.tables.sync_run, 2);

  assert.equal(stats.items.live, 2);
  assert.equal(stats.items.tombstoned, 1);
  assert.deepEqual(stats.items.by_kind, { change_request: 1, issue: 1 });
  assert.deepEqual(stats.items.by_state, { merged: 1, open: 1 });
  assert.deepEqual(stats.items.by_source, { [SOURCE]: 2 });

  assert.equal(stats.edges.live, 1);
  assert.equal(stats.edges.tombstoned, 0);
  assert.deepEqual(stats.edges.by_type, { closes: 1 });
  assert.deepEqual(stats.edges.by_lifecycle, { fulfilled: 1 });

  assert.equal(stats.activities.total, 1);
  assert.equal(stats.activities.earliest, "2026-06-01T00:00:00Z");
  assert.equal(stats.activities.latest, "2026-06-01T00:00:00Z");

  // Newest run first, with totals and the error text intact.
  assert.equal(stats.sync_runs.length, 2);
  assert.equal(stats.sync_runs[0]!.status, "error");
  assert.equal(stats.sync_runs[0]!.error, "boom");
  assert.equal(stats.sync_runs[1]!.status, "ok");
  assert.equal(stats.sync_runs[1]!.items_seen, 2);

  assert.equal(newestOnly.sync_runs.length, 1, "runsLimit bounds the history window");
  assert.equal(newestOnly.sync_runs[0]!.status, "error");
});

function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(chunk?: string) {
      out.body += chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, out };
}

test("handleStatsRequest maps a store that does not exist yet to 404 no_database", async () => {
  const { res, out } = fakeRes();
  const cfg = { db_path: join(tmpdir(), "stats-test-definitely-missing.db"), sources: [] } as unknown as AppConfig;
  await handleStatsRequest(cfg, new URL("http://localhost/api/stats"), res);
  assert.equal(out.status, 404);
  assert.equal((JSON.parse(out.body) as { error: string }).error, "no_database");
});

test("a Postgres-configured request never maps a missing db_path file to 404", async () => {
  const { res, out } = fakeRes();
  delete process.env.SYMPHONY_TEST_UNSET_DB_URL;
  const cfg = {
    db_path: join(tmpdir(), "stats-test-definitely-missing.db"),
    db_url_env: "SYMPHONY_TEST_UNSET_DB_URL",
    sources: [],
  } as unknown as AppConfig;
  await handleStatsRequest(cfg, new URL("http://localhost/api/stats"), res);
  assert.equal(out.status, 500, "the file precheck is SQLite-only; the pg path fails loudly at open");
  assert.match((JSON.parse(out.body) as { message: string }).message, /db_url_env/);
});
