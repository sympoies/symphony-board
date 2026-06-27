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
import type { CanonicalActivity, CanonicalItem, CanonicalReviewThread } from "../src/model/types.ts";
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

// Set SYMPHONY_PG_TEST_URL (postgres://user:pass@host:port/db) to also run the
// suite against the Postgres driver — scripts/ci/pg-e2e.sh and the CI `pg` job
// do. Every open() gets a fresh schema in that database, so cases stay
// isolated; the target database is throwaway (schemas are not dropped).
const PG_TEST_URL = (process.env.SYMPHONY_PG_TEST_URL ?? "").trim();
if (PG_TEST_URL) {
  const { openPostgresStore } = await import("../src/db/postgres.ts");
  const stamp = Date.now().toString(36);
  let seq = 0;
  const freshSchema = () => `conformance_${stamp}_${seq++}`;
  const close = async (s: Store) => {
    try {
      await s.close();
    } catch {
      // already closed by the test
    }
  };
  DRIVERS.push({
    name: "postgres",
    open: () => openPostgresStore(PG_TEST_URL, { schema: freshSchema() }),
    openShared: async () => {
      const schema = freshSchema();
      const a = await openPostgresStore(PG_TEST_URL, { schema });
      const b = await openPostgresStore(PG_TEST_URL, { schema });
      return {
        a,
        b,
        cleanup: async () => {
          await close(a);
          await close(b);
        },
      };
    },
  });
}

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
    projectPath: "dev-a/repo",
    iid: 1,
    url: "https://example/1",
    title: "t",
    body: null,
    state: "open",
    stateRaw: "OPEN",
    stateReason: null,
    isDraft: null,
    author: "dev-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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
    commentTotal: over.commentTotal ?? null,
  };
}

function fixtureActivity(over: Partial<CanonicalActivity> = {}): CanonicalActivity {
  return {
    sourceId: SOURCE,
    externalId: "activity-1",
    kind: "issue",
    action: "opened",
    projectPath: "dev-a/repo",
    targetKind: "issue",
    target: { sourceId: SOURCE, externalId: "ISSUE_1" },
    targetIid: 1,
    title: "Opened an issue",
    url: "https://example/1",
    actor: "dev-a",
    actorKey: `provider-user:${SOURCE}:dev-a`,
    occurredAt: "2026-06-01T00:00:00Z",
    summary: "Opened issue #1",
    details: { source: "test" },
    ...over,
  };
}

function fixtureReviewThread(over: Partial<CanonicalReviewThread> = {}): CanonicalReviewThread {
  return {
    sourceId: SOURCE,
    externalId: "THREAD_1",
    projectPath: "dev-a/repo",
    target: { sourceId: SOURCE, externalId: "PR_1" },
    targetIid: 1,
    title: "Review me",
    url: "https://example/pr/1#discussion",
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    path: "src/app.ts",
    line: 12,
    startLine: 10,
    commentsTotal: 1,
    comments: [
      {
        id: "COMMENT_1",
        author: "reviewer",
        avatarUrl: "https://avatars.example/u/1.png",
        body: "Please cover this branch.",
        url: "https://example/pr/1#discussion",
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ],
    lastCommentAt: "2026-06-01T00:00:00Z",
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
    const id2 = await store.upsertItem(fixtureItem({ title: "updated", body: "Updated provider body" }), "github/1", "2026-06-01T00:01:00Z");
    assert.equal(id1, id2, "same row id on re-upsert");
    const liveItems = await store.listLiveItems();
    assert.equal(liveItems.length, 1);
    assert.equal(liveItems[0]!.title, "updated");
    assert.equal(liveItems[0]!.body, "Updated provider body");
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

  t("review-thread detail rows upsert, list, tombstone, and revive", async () => {
    const store = await fresh();
    await store.upsertReviewThread(fixtureReviewThread(), "2026-06-01T00:00:00Z");
    await store.upsertReviewThread(
      fixtureReviewThread({ isResolved: true, resolvedBy: "maintainer", commentsTotal: 2 }),
      "2026-06-01T00:10:00Z",
    );
    const rows = await store.listLiveReviewThreads();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.external_id, "THREAD_1");
    assert.equal(rows[0]!.is_resolved, true);
    assert.equal(rows[0]!.resolved_by, "maintainer");
    assert.equal(JSON.parse(rows[0]!.comments_json)[0].body, "Please cover this branch.");
    assert.equal(rows[0]!.last_comment_at, "2026-06-01T00:00:00Z");

    assert.equal(await store.softDeleteUnseenReviewThreads(SOURCE, "2026-06-01T00:11:00Z", "2026-06-01T00:20:00Z"), 1);
    assert.equal((await store.listLiveReviewThreads()).length, 0);
    await store.upsertReviewThread(fixtureReviewThread(), "2026-06-01T00:30:00Z");
    assert.equal((await store.listLiveReviewThreads()).length, 1, "re-seeing clears the tombstone");
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

  t("listActivitiesInRange bounds by instant across offsets, inclusive of both ends, newest-first", async () => {
    // The range query must filter by the parsed instant, not the raw text, since
    // occurred_at keeps the provider's UTC offset. A +08:00 row whose instant
    // falls inside a UTC range must be returned; one whose instant falls outside
    // must not — even when its wall-clock text looks in-range.
    const store = await fresh();
    await store.upsertActivity(fixtureActivity({ externalId: "in-utc", occurredAt: "2026-05-10T00:00:00Z" }), "2026-05-10T00:00:00Z");
    // GitLab local time: 2026-05-20T07:00+08:00 == 2026-05-19T23:00Z (in range).
    await store.upsertActivity(fixtureActivity({ externalId: "in-local", occurredAt: "2026-05-20T07:00:00.000+08:00" }), "2026-05-20T00:00:00Z");
    // Boundary rows: exactly at from and at to must be included (inclusive).
    await store.upsertActivity(fixtureActivity({ externalId: "at-from", occurredAt: "2026-05-01T00:00:00.000Z" }), "2026-05-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "at-to", occurredAt: "2026-05-31T23:59:59.999Z" }), "2026-05-31T23:59:59Z");
    // Just outside: 1ms before from and at the day after to.
    await store.upsertActivity(fixtureActivity({ externalId: "before", occurredAt: "2026-04-30T23:59:59.999Z" }), "2026-04-30T23:59:59Z");
    // GitLab local 2026-06-01T07:30+08:00 == 2026-05-31T23:30Z is IN range, but
    // its TEXT ("2026-06-01...") would be excluded by a naive text upper bound —
    // proves the instant filter, not text, decides membership.
    await store.upsertActivity(fixtureActivity({ externalId: "in-local-edge", occurredAt: "2026-06-01T07:30:00.000+08:00" }), "2026-06-01T00:00:00Z");
    // After: clearly outside.
    await store.upsertActivity(fixtureActivity({ externalId: "after", occurredAt: "2026-06-10T00:00:00Z" }), "2026-06-10T00:00:00Z");

    const rows = await store.listActivitiesInRange("2026-05-01T00:00:00.000Z", "2026-05-31T23:59:59.999Z");
    assert.deepEqual(
      rows.map((r) => r.external_id),
      ["at-to", "in-local-edge", "in-local", "in-utc", "at-from"],
      "in-instant-range rows only, ordered newest-first by instant",
    );
    await store.close();
  });

  t("listRepoActivityBounds returns all-time per-repo bounds by INSTANT, not raw text", async () => {
    // occurred_at keeps the provider's UTC offset, so the bounds must be picked
    // by parsed instant. These rows are crafted so the instant-earliest/latest
    // row is NOT the lexicographically smallest/largest text — a text MIN/MAX
    // would return the wrong row.
    const store = await fresh();
    // repo A (dev-a/repo): four rows spanning offsets.
    //   instant-min: 2026-01-01T05:00+08:00 == 2025-12-31T21:00Z (text "2026-01-01…")
    await store.upsertActivity(fixtureActivity({ externalId: "a-instant-min", projectPath: "dev-a/repo", occurredAt: "2026-01-01T05:00:00.000+08:00" }), "2026-01-01T00:00:00Z");
    //   text-min but a LATER instant: 2025-12-31T23:30Z (text "2025-12-31…")
    await store.upsertActivity(fixtureActivity({ externalId: "a-text-min", projectPath: "dev-a/repo", occurredAt: "2025-12-31T23:30:00.000Z" }), "2026-01-01T00:00:00Z");
    //   text-max but NOT the latest instant: 2026-06-01T00:00Z (text "2026-06-01…")
    await store.upsertActivity(fixtureActivity({ externalId: "a-text-max", projectPath: "dev-a/repo", occurredAt: "2026-06-01T00:00:00.000Z" }), "2026-06-01T00:00:00Z");
    //   instant-max: 2026-05-31T20:00-10:00 == 2026-06-01T06:00Z (text "2026-05-31…")
    await store.upsertActivity(fixtureActivity({ externalId: "a-instant-max", projectPath: "dev-a/repo", occurredAt: "2026-05-31T20:00:00.000-10:00" }), "2026-06-01T00:00:00Z");
    // repo B (dev-b/repo): a single activity — both bounds equal it.
    await store.upsertActivity(fixtureActivity({ externalId: "b-only", projectPath: "dev-b/repo", occurredAt: "2026-04-10T00:00:00.000Z" }), "2026-04-10T00:00:00Z");

    const bounds = await store.listRepoActivityBounds();
    assert.equal(bounds.length, 2, "one row per repo");
    const byRepo = new Map(bounds.map((r) => [`${r.source_id}|${r.project_path}`, r]));
    const a = byRepo.get(`${SOURCE}|dev-a/repo`);
    assert.equal(a?.observed_since, "2026-01-01T05:00:00.000+08:00", "earliest by instant, keeping the original offset text");
    assert.equal(a?.last_activity_at, "2026-05-31T20:00:00.000-10:00", "latest by instant, not by text");
    const b = byRepo.get(`${SOURCE}|dev-b/repo`);
    assert.equal(b?.observed_since, "2026-04-10T00:00:00.000Z");
    assert.equal(b?.last_activity_at, "2026-04-10T00:00:00.000Z");
    await store.close();
  });

  t("listRepoActivityBounds skips unparsable activity timestamps", async () => {
    const store = await fresh();
    try {
      await store.upsertActivity(fixtureActivity({ externalId: "good", projectPath: "dev-a/repo", occurredAt: "2026-05-16T12:00:00Z" }), "2026-06-01T00:00:00Z");
      await store.upsertActivity(fixtureActivity({ externalId: "bad", projectPath: "dev-a/repo", occurredAt: "not-a-timestamp" }), "2026-06-01T00:00:00Z");

      const bounds = await store.listRepoActivityBounds();
      assert.equal(bounds.length, 1, "one row for the repo with parseable activity");
      assert.equal(bounds[0]?.observed_since, "2026-05-16T12:00:00Z", "unparsable rows are skipped");
      assert.equal(bounds[0]?.last_activity_at, "2026-05-16T12:00:00Z", "unparsable rows do not break latest bound refresh");
    } finally {
      await store.close();
    }
  });

  t("listRepoActivityBounds recomputes cached bounds when a boundary activity changes", async () => {
    const store = await fresh();
    await store.upsertActivity(fixtureActivity({ externalId: "earliest", projectPath: "dev-a/repo", occurredAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "middle", projectPath: "dev-a/repo", occurredAt: "2026-02-01T00:00:00.000Z" }), "2026-02-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "latest", projectPath: "dev-a/repo", occurredAt: "2026-03-01T00:00:00.000Z" }), "2026-03-01T00:00:00Z");

    let bounds = await store.listRepoActivityBounds();
    assert.equal(bounds[0]?.observed_since, "2026-01-01T00:00:00.000Z");
    assert.equal(bounds[0]?.last_activity_at, "2026-03-01T00:00:00.000Z");

    await store.upsertActivity(fixtureActivity({ externalId: "earliest", projectPath: "dev-a/repo", occurredAt: "2026-04-01T00:00:00.000Z" }), "2026-04-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "latest", projectPath: "dev-a/repo", occurredAt: "2026-01-15T00:00:00.000Z" }), "2026-04-01T00:00:00Z");

    bounds = await store.listRepoActivityBounds();
    assert.equal(bounds.length, 1);
    assert.equal(bounds[0]?.observed_since, "2026-01-15T00:00:00.000Z", "old latest row moved earlier and became the earliest");
    assert.equal(bounds[0]?.last_activity_at, "2026-04-01T00:00:00.000Z", "old earliest row moved later and became the latest");
    await store.close();
  });

  t("listRepoActivityBounds refreshes both buckets when an activity moves repo", async () => {
    const store = await fresh();
    await store.upsertActivity(fixtureActivity({ externalId: "a-old", projectPath: "dev-a/repo", occurredAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "moving", projectPath: "dev-a/repo", occurredAt: "2026-02-01T00:00:00.000Z" }), "2026-02-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "b-existing", projectPath: "dev-b/repo", occurredAt: "2026-03-01T00:00:00.000Z" }), "2026-03-01T00:00:00Z");

    await store.upsertActivity(fixtureActivity({ externalId: "moving", projectPath: "dev-b/repo", occurredAt: "2026-04-01T00:00:00.000Z" }), "2026-04-01T00:00:00Z");

    const byRepo = new Map((await store.listRepoActivityBounds()).map((r) => [`${r.source_id}|${r.project_path}`, r]));
    assert.equal(byRepo.size, 2);
    assert.equal(byRepo.get(`${SOURCE}|dev-a/repo`)?.observed_since, "2026-01-01T00:00:00.000Z");
    assert.equal(byRepo.get(`${SOURCE}|dev-a/repo`)?.last_activity_at, "2026-01-01T00:00:00.000Z", "old bucket drops the moved row");
    assert.equal(byRepo.get(`${SOURCE}|dev-b/repo`)?.observed_since, "2026-03-01T00:00:00.000Z");
    assert.equal(byRepo.get(`${SOURCE}|dev-b/repo`)?.last_activity_at, "2026-04-01T00:00:00.000Z", "new bucket includes the moved row");
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

    await store.finishRun(runId, "ok", "2026-06-01T00:00:30Z", 2, 1, 1, 3, 8, 0, null);
    runs = (await store.overview(10)).sync_runs;
    assert.equal(runs[0]!.status, "ok");
    assert.equal(runs[0]!.items_seen, 2);
    assert.equal(runs[0]!.graphql_requests, 3);
    assert.equal(runs[0]!.graphql_cost, 8);
    assert.equal(runs[0]!.graphql_cost_unknown, 0);
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
    await store.finishRun(r1, "ok", "2026-06-01T00:00:30Z", 1, 1, 1, 5, 13, 0, null);
    const r2 = await store.startRun(SOURCE, "incremental", "2026-06-01T00:02:00Z");
    await store.finishRun(r2, "error", "2026-06-01T00:02:05Z", 0, 0, 0, 2, 3, 1, "boom");

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
    assert.equal(ov.sync_runs[0]!.graphql_requests, 2);
    assert.equal(ov.sync_runs[0]!.graphql_cost, 3);
    assert.equal(ov.sync_runs[0]!.graphql_cost_unknown, 1);
    assert.equal(ov.sync_runs[1]!.graphql_requests, 5);
    assert.equal(ov.sync_runs[1]!.graphql_cost, 13);
    assert.equal(ov.sync_runs[1]!.graphql_cost_unknown, 0);
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

  t("provider numbers past 2^31 round-trip exactly (iid, target_iid)", async () => {
    // Live-validation finding: gitlab.com emits event/iid values past int4
    // (e.g. 3430406968). SQLite's INTEGER is 64-bit so it never noticed; a
    // driver with 32-bit numeric columns corrupts or rejects real provider
    // data, so 64-bit round-tripping is a conformance obligation.
    const big = 3430406968;
    const store = await fresh();
    await store.upsertItem(fixtureItem({ externalId: "BIG_IID", iid: big }), "github/1", "2026-06-01T00:00:00Z");
    await store.upsertActivity(fixtureActivity({ externalId: "BIG_TARGET", targetIid: big }), "2026-06-01T00:00:00Z");
    assert.equal((await store.listLiveItems()).find((r) => r.external_id === "BIG_IID")?.iid, big);
    assert.equal((await store.listActivities()).find((r) => r.external_id === "BIG_TARGET")?.target_iid, big);
    await store.close();
  });

  t("the writer lease is exclusive across handles to the same store", async () => {
    // "Exactly one sync writer" is a per-driver obligation, not a
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
