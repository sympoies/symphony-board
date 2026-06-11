// Store conformance suite: behavior every Store driver must satisfy, run
// against each registered driver. This suite — not the type signatures — is the
// swap guarantee: a new driver (e.g. Postgres) is acceptable when it passes
// here unchanged. Driver-specific behavior (read-only open semantics,
// diagnostics keys, file layout) belongs in driver tests, not here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../src/db/store.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import type { CanonicalActivity, CanonicalItem } from "../src/model/types.ts";
import type { ReconciledEdge } from "../src/model/edges.ts";
import { toLabel } from "../src/model/labels.ts";

// Two handles on the SAME logical store (a temp file for SQLite; the shared
// test database for a server driver), for behavior that only exists across
// handles — the writer lease. cleanup() tolerates handles the test already
// closed.
interface SharedHandles {
  a: Store;
  b: Store;
  cleanup: () => Promise<void>;
}

const DRIVERS: Array<{
  name: string;
  open: () => Promise<Store>;
  openShared: () => Promise<SharedHandles>;
}> = [
  {
    name: "sqlite",
    open: () => openSqliteStore(":memory:"),
    openShared: async () => {
      const dir = mkdtempSync(join(tmpdir(), "symphony-store-"));
      const a = await openSqliteStore(join(dir, "store.db"));
      const b = await openSqliteStore(join(dir, "store.db"));
      const close = async (s: Store) => {
        try {
          await s.close();
        } catch {
          // already closed by the test
        }
      };
      return {
        a,
        b,
        cleanup: async () => {
          await close(a);
          await close(b);
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

const SOURCE = "github:github.com";

function fixtureEdge(over: Partial<ReconciledEdge> = {}): ReconciledEdge {
  return {
    type: "closes",
    from: { sourceId: SOURCE, externalId: "PR_1" },
    to: { sourceId: SOURCE, externalId: "ISSUE_1" },
    fromState: "merged",
    toState: "closed",
    lifecycle: "fulfilled",
    discoveredFrom: "from",
    ...over,
  };
}

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

function fixtureActivity(over: Partial<CanonicalActivity> = {}): CanonicalActivity {
  return {
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
    details: { source: "test" },
    ...over,
  };
}

for (const driver of DRIVERS) {
  // Each test opens a fresh store seeded with the canonical source row.
  async function fresh(): Promise<Store> {
    const store = await driver.open();
    await store.ensureSource({ sourceId: SOURCE, kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");
    return store;
  }
  const t = (title: string, fn: () => Promise<void>) => test(`[${driver.name}] ${title}`, fn);

  t("upsertItem is idempotent on (source_id, external_id) and resurrects on re-seen", async () => {
    const store = await fresh();
    const id1 = await store.upsertItem(fixtureItem(), "github/1", "2026-06-01T00:00:00Z");
    const id2 = await store.upsertItem(fixtureItem({ title: "updated" }), "github/1", "2026-06-01T00:01:00Z");
    assert.equal(id1, id2, "same row id on re-upsert");
    assert.equal((await store.listLiveItems()).length, 1);
    assert.equal((await store.listLiveItems())[0]!.title, "updated");
    await store.close();
  });

  t("is_draft round-trips as a boolean", async () => {
    const store = await fresh();
    await store.upsertItem(fixtureItem({ externalId: "PR_DRAFT", isDraft: true }), "github/1", "2026-06-01T00:00:00Z");
    await store.upsertItem(fixtureItem({ externalId: "PR_READY", isDraft: false }), "github/1", "2026-06-01T00:00:00Z");
    const byId = new Map((await store.listLiveItems()).map((r) => [r.external_id, r.is_draft]));
    assert.equal(byId.get("PR_DRAFT"), true);
    assert.equal(byId.get("PR_READY"), false);
    assert.equal(byId.get("ISSUE_1"), undefined);
    await store.close();
  });

  t("listLiveItems orders by resolution recency, NOT by closed_at presence", async () => {
    // Regression: GitLab carries merged_at (not closed_at) for a merged MR. An
    // ORDER BY that floats closed_at-IS-NULL rows first — or omits merged_at —
    // scatters every GitLab merged MR ahead of dated items in the Closed column.
    // Expected order is purely by most-recent resolution: open(updated) > the
    // newer merge > the older merge, regardless of which timestamp carries it.
    const store = await fresh();
    // GitHub-style merged PR: closed_at AND merged_at set, merged 2026-06-07.
    await store.upsertItem(fixtureItem({ externalId: "PR_GH", state: "merged", closedAt: "2026-06-07T00:00:00Z", mergedAt: "2026-06-07T00:00:00Z", updatedAt: "2026-06-07T00:00:00Z" }), "github/gh", "2026-06-08T00:00:00Z");
    // GitLab-style merged MR: closed_at NULL, merged_at set, merged 2026-05-01 —
    // and a LATER updated_at to prove merged_at (resolution time), not updated_at,
    // drives its position.
    await store.upsertItem(fixtureItem({ externalId: "MR_GL", state: "merged", closedAt: null, mergedAt: "2026-05-01T00:00:00Z", updatedAt: "2026-06-09T00:00:00Z" }), "github/gl", "2026-06-08T00:00:00Z");
    // Open item, freshly updated — sorts first by updated_at.
    await store.upsertItem(fixtureItem({ externalId: "ISSUE_OPEN", state: "open", updatedAt: "2026-06-10T00:00:00Z" }), "github/open", "2026-06-08T00:00:00Z");

    const order = (await store.listLiveItems()).filter((r) => r.external_id !== "ISSUE_1").map((r) => r.external_id);
    assert.deepEqual(order, ["ISSUE_OPEN", "PR_GH", "MR_GL"], "open(06-10) > GitHub merge(06-07) > GitLab merge(05-01)");
    await store.close();
  });

  t("labels are replaced wholesale", async () => {
    const store = await fresh();
    const id = await store.upsertItem(fixtureItem(), "github/1", "2026-06-01T00:00:00Z");
    await store.replaceLabels(id, [toLabel("bug"), toLabel("priority::high")]);
    assert.equal((await store.listLabels()).length, 2);
    await store.replaceLabels(id, [toLabel("bug")]);
    assert.equal((await store.listLabels()).length, 1);
    await store.close();
  });

  t("upsertRaw reports whether the payload changed by content hash", async () => {
    const store = await fresh();
    const first = await store.upsertRaw(SOURCE, "issue", "ISSUE_1", "v1", "hash-a", "2026-06-01T00:00:00Z", "{}");
    const unchanged = await store.upsertRaw(SOURCE, "issue", "ISSUE_1", "v1", "hash-a", "2026-06-01T00:01:00Z", "{}");
    const changed = await store.upsertRaw(SOURCE, "issue", "ISSUE_1", "v1", "hash-b", "2026-06-01T00:02:00Z", "{}");
    assert.equal(first, true, "a never-seen record counts as changed");
    assert.equal(unchanged, false, "same content_hash is a no-op for normalization");
    assert.equal(changed, true, "a new content_hash must trigger re-normalization");
    await store.close();
  });

  t("soft-delete tombstones items not seen since the cutoff, and re-seen items revive", async () => {
    const store = await fresh();
    await store.upsertItem(fixtureItem(), "github/1", "2026-01-01T00:00:00Z"); // last_seen far in the past

    const removed = await store.softDeleteUnseenItems(SOURCE, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    assert.equal(removed, 1);
    assert.equal((await store.listLiveItems()).length, 0, "tombstoned item is not live");

    // Re-seeing it clears the tombstone.
    await store.upsertItem(fixtureItem(), "github/1", "2026-06-02T00:00:00Z");
    assert.equal((await store.listLiveItems()).length, 1);
    await store.close();
  });

  t("edge soft-delete tombstones unseen intra-source edges, and re-seen edges revive", async () => {
    const store = await fresh();
    await store.upsertEdge(fixtureEdge(), "2026-01-01T00:00:00Z"); // last_seen far in the past

    const removed = await store.softDeleteUnseenEdges(SOURCE, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    assert.equal(removed, 1);
    assert.equal((await store.listLiveEdges()).length, 0, "tombstoned edge is not live");

    // Re-seeing the same (type, from, to) clears the tombstone.
    await store.upsertEdge(fixtureEdge(), "2026-06-02T00:00:00Z");
    assert.equal((await store.listLiveEdges()).length, 1);
    await store.close();
  });

  t("edge soft-delete is scoped to the source and never touches cross-source edges", async () => {
    const store = await fresh();
    // A cross-source edge (from GitHub PR, to a GitLab issue) seen long ago. A
    // GitHub-only sweep must NOT confirm it disappeared — the GitLab side is not
    // part of this sweep — so it stays live.
    await store.upsertEdge(fixtureEdge({ to: { sourceId: "gitlab:gitlab.com", externalId: "gid://gitlab/Issue/9" } }), "2026-01-01T00:00:00Z");
    const removed = await store.softDeleteUnseenEdges(SOURCE, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    assert.equal(removed, 0, "cross-source edge is left untouched by a single-source sweep");
    assert.equal((await store.listLiveEdges()).length, 1);
    await store.close();
  });

  t("activities are upserted by provider id and listed newest first", async () => {
    const store = await fresh();
    await store.upsertActivity(fixtureActivity(), "2026-06-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ title: "Updated title", summary: "Updated summary", actorKey: `provider-user:${SOURCE}:updated` }), "2026-06-01T00:01:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "activity-2", occurredAt: "2026-06-02T00:00:00Z", action: "closed" }), "2026-06-02T00:00:00Z");

    const rows = await store.listActivities();
    assert.equal(rows.length, 2, "same (source, external_id) updates in place");
    assert.equal(rows[0]!.external_id, "activity-2", "newest activity sorts first");
    assert.equal(rows[1]!.title, "Updated title");
    assert.equal(rows[1]!.actor_key, `provider-user:${SOURCE}:updated`, "actor_key persists and backfills on conflict");
    assert.deepEqual(JSON.parse(rows[1]!.details ?? "{}"), { source: "test" });
    await store.close();
  });

  t("activities are ordered by instant across timezone offsets", async () => {
    // occurred_at preserves the provider's original UTC offset (GitLab emits
    // +08:00 and friends), so a driver must order by the parsed instant — NOT
    // by string comparison, which would sort 16:59+08:00 after 09:45Z even
    // though it is the earlier instant.
    const store = await fresh();
    await store.upsertActivity(fixtureActivity({ externalId: "gitlab-local", occurredAt: "2026-06-08T16:59:35.000+08:00" }), "2026-06-08T09:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "github-utc", occurredAt: "2026-06-08T09:45:23Z" }), "2026-06-08T09:46:00Z");

    assert.deepEqual((await store.listActivities()).map((row) => row.external_id), ["github-utc", "gitlab-local"]);
    await store.close();
  });

  t("CI refresh candidates include unresolved or recently active change requests", async () => {
    const store = await fresh();
    await store.upsertItem(fixtureItem({ externalId: "PR_PENDING", kind: "change_request", iid: 1, state: "merged", ciState: "pending", updatedAt: "2026-06-08T00:00:00Z", mergedAt: "2026-06-08T00:00:00Z" }), "github/pr-pending", "2026-06-08T00:00:00Z");
    await store.upsertItem(fixtureItem({ externalId: "PR_OPEN", kind: "change_request", iid: 2, state: "open", ciState: "passing", updatedAt: "2026-05-01T00:00:00Z" }), "github/pr-open", "2026-06-08T00:00:00Z");
    await store.upsertItem(fixtureItem({ externalId: "PR_RECENT", kind: "change_request", iid: 3, state: "merged", ciState: "passing", updatedAt: "2026-06-08T00:00:00Z", mergedAt: "2026-06-08T00:00:00Z" }), "github/pr-recent", "2026-06-08T00:00:00Z");
    await store.upsertItem(fixtureItem({ externalId: "PR_OLD_PASSING", kind: "change_request", iid: 4, state: "merged", ciState: "passing", updatedAt: "2026-05-01T00:00:00Z", mergedAt: "2026-05-01T00:00:00Z" }), "github/pr-old", "2026-06-08T00:00:00Z");
    await store.upsertItem(fixtureItem({ externalId: "ISSUE_PENDING", kind: "issue", iid: 5, ciState: "pending", updatedAt: "2026-06-08T00:00:00Z" }), "github/issue", "2026-06-08T00:00:00Z");

    assert.deepEqual(
      (await store.listCiRefreshCandidates(SOURCE, "2026-06-07T00:00:00Z", 10)).map((row) => row.external_id),
      ["PR_PENDING", "PR_OPEN", "PR_RECENT"],
    );
    await store.close();
  });

  t("updateSyncState COALESCEs the watermark and last_success_at across failed runs", async () => {
    const store = await fresh();
    await store.updateSyncState(SOURCE, "2026-06-01T00:00:00Z", "ok", null, "2026-06-01T00:00:00Z");
    assert.equal(await store.getWatermark(SOURCE), "2026-06-01T00:00:00Z");

    // A failed run carries no watermark: the prior good one must survive.
    await store.updateSyncState(SOURCE, null, "error", "boom", "2026-06-02T00:00:00Z");
    assert.equal(await store.getWatermark(SOURCE), "2026-06-01T00:00:00Z", "a failed run never clobbers the watermark");

    const sources = await store.listSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.last_status, "error", "last_status reflects the latest run");
    assert.equal(sources[0]!.last_success_at, "2026-06-01T00:00:00Z", "last_success_at survives a failed run");
    await store.close();
  });

  t("a run starts 'partial' and finishRun records the outcome", async () => {
    // status defaults to 'partial' so a crash mid-run never enables a
    // soft-delete sweep on a later read of the run history.
    const store = await fresh();
    const runId = await store.startRun(SOURCE, "full", "2026-06-01T00:00:00Z");
    let runs = (await store.overview(10)).sync_runs;
    assert.equal(runs[0]!.run_id, runId);
    assert.equal(runs[0]!.status, "partial", "an unfinished run reads as partial");

    await store.finishRun(runId, "ok", "2026-06-01T00:00:30Z", 2, 1, 1, null);
    runs = (await store.overview(10)).sync_runs;
    assert.equal(runs[0]!.status, "ok");
    assert.equal(runs[0]!.items_seen, 2);
    await store.close();
  });

  t("overview reports live/tombstoned counts, breakdowns, and bounded run history", async () => {
    const store = await fresh();
    await store.upsertItem(fixtureItem(), "github/1", "2026-06-01T00:00:00Z");
    await store.upsertItem(fixtureItem({ externalId: "OLD" }), "github/1", "2026-01-01T00:00:00Z");
    await store.softDeleteUnseenItems(SOURCE, "2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z");
    await store.upsertEdge(fixtureEdge(), "2026-06-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity(), "2026-06-01T00:00:00Z");
    const r1 = await store.startRun(SOURCE, "full", "2026-06-01T00:00:00Z");
    await store.finishRun(r1, "ok", "2026-06-01T00:00:30Z", 1, 1, 1, null);
    const r2 = await store.startRun(SOURCE, "incremental", "2026-06-01T00:02:00Z");
    await store.finishRun(r2, "error", "2026-06-01T00:02:05Z", 0, 0, 0, "boom");

    const ov = await store.overview(10);
    assert.equal(ov.items.live, 1);
    assert.equal(ov.items.tombstoned, 1);
    assert.deepEqual(ov.items.by_kind, { issue: 1 });
    assert.deepEqual(ov.items.by_source, { [SOURCE]: 1 });
    assert.equal(ov.edges.live, 1);
    assert.deepEqual(ov.edges.by_lifecycle, { fulfilled: 1 });
    assert.equal(ov.activities.total, 1);
    assert.equal(ov.activities.earliest, "2026-06-01T00:00:00Z");
    assert.equal(ov.sync_runs.length, 2);
    assert.equal(ov.sync_runs[0]!.error, "boom", "newest run first");
    assert.equal((await store.overview(1)).sync_runs.length, 1, "runsLimit bounds the history window");
    await store.close();
  });

  t("transaction commits on resolve and rolls back on reject", async () => {
    const store = await fresh();
    await store.transaction(async (tx) => {
      await tx.upsertItem(fixtureItem({ externalId: "COMMITTED" }), "github/1", "2026-06-01T00:00:00Z");
    });
    assert.equal((await store.listLiveItems()).length, 1, "a resolved transaction persists");

    await assert.rejects(
      store.transaction(async (tx) => {
        await tx.upsertItem(fixtureItem({ externalId: "ROLLED_BACK" }), "github/1", "2026-06-01T00:00:00Z");
        throw new Error("abort");
      }),
      /abort/,
    );
    const ids = (await store.listLiveItems()).map((r) => r.external_id);
    assert.deepEqual(ids, ["COMMITTED"], "a rejected transaction persists nothing");
    await store.close();
  });

  t("the writer lease is exclusive across handles to the same store", async () => {
    // #164: "exactly one sync writer" as a per-driver obligation, not a
    // deployment convention. Try-lock semantics: a refused acquire returns
    // false immediately (the caller skips its run), never blocks.
    const { a, b, cleanup } = await driver.openShared();
    try {
      assert.equal(await a.acquireWriterLease(), true, "the first handle takes the lease");
      assert.equal(await a.acquireWriterLease(), true, "re-acquiring on the holder is idempotent");
      assert.equal(await b.acquireWriterLease(), false, "a second handle is refused while the lease is held");
      await a.releaseWriterLease();
      assert.equal(await b.acquireWriterLease(), true, "an explicit release frees the lease");
      await b.releaseWriterLease();
    } finally {
      await cleanup();
    }
  });

  t("close() releases a held writer lease", async () => {
    // A holder that goes away cleanly must free the lease; a crashed holder is
    // freed by the engine/OS (session/file locks die with their owner), which
    // the pg live e2e exercises — this case covers the clean path portably.
    const { a, b, cleanup } = await driver.openShared();
    try {
      assert.equal(await a.acquireWriterLease(), true);
      await a.close();
      assert.equal(await b.acquireWriterLease(), true, "closing the holder frees the lease");
      await b.releaseWriterLease();
    } finally {
      await cleanup();
    }
  });

  t("concurrent transactions serialize instead of interleaving", async () => {
    const store = await fresh();
    // Two transactions started back-to-back without awaiting the first: the
    // driver must serialize them (the second BEGIN waits), not throw or nest.
    const first = store.transaction(async (tx) => {
      await tx.upsertItem(fixtureItem({ externalId: "T1" }), "github/1", "2026-06-01T00:00:00Z");
      return 1;
    });
    const second = store.transaction(async (tx) => {
      await tx.upsertItem(fixtureItem({ externalId: "T2" }), "github/1", "2026-06-01T00:00:00Z");
      return 2;
    });
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.equal((await store.listLiveItems()).length, 2);
    await store.close();
  });
}
