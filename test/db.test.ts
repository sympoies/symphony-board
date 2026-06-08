import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/open.ts";
import {
  ensureSource,
  upsertItem,
  replaceLabels,
  listLiveItems,
  listLabels,
  softDeleteUnseenItems,
  upsertEdge,
  listLiveEdges,
  softDeleteUnseenEdges,
  upsertActivity,
  listActivities,
  listCiRefreshCandidates,
} from "../src/db/repo.ts";
import type { CanonicalActivity, CanonicalItem } from "../src/model/types.ts";
import type { ReconciledEdge } from "../src/model/edges.ts";
import { toLabel } from "../src/model/labels.ts";

function fixtureEdge(over: Partial<ReconciledEdge> = {}): ReconciledEdge {
  return {
    type: "closes",
    from: { sourceId: "github:github.com", externalId: "PR_1" },
    to: { sourceId: "github:github.com", externalId: "ISSUE_1" },
    fromState: "merged",
    toState: "closed",
    lifecycle: "fulfilled",
    discoveredFrom: "from",
    ...over,
  };
}

function fixtureItem(over: Partial<CanonicalItem> = {}): CanonicalItem {
  return {
    sourceId: "github:github.com",
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
    sourceId: "github:github.com",
    externalId: "activity-1",
    kind: "issue",
    action: "opened",
    projectPath: "graysurf/repo",
    targetKind: "issue",
    target: { sourceId: "github:github.com", externalId: "ISSUE_1" },
    targetIid: 1,
    title: "Opened an issue",
    url: "https://example/1",
    actor: "graysurf",
    actorKey: "provider-user:github:github.com:graysurf",
    occurredAt: "2026-06-01T00:00:00Z",
    summary: "Opened issue #1",
    details: { source: "test" },
    ...over,
  };
}

test("upsertItem is idempotent on (source_id, external_id) and resurrects on re-seen", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");

  const id1 = upsertItem(db, fixtureItem(), "github/1", "2026-06-01T00:00:00Z");
  const id2 = upsertItem(db, fixtureItem({ title: "updated" }), "github/1", "2026-06-01T00:01:00Z");
  assert.equal(id1, id2, "same row id on re-upsert");
  assert.equal(listLiveItems(db).length, 1);
  assert.equal(listLiveItems(db)[0]!.title, "updated");
  db.close();
});

test("listLiveItems orders by resolution recency, NOT by closed_at presence", () => {
  // Regression: GitLab carries merged_at (not closed_at) for a merged MR. An
  // ORDER BY that floats closed_at-IS-NULL rows first — or omits merged_at —
  // scatters every GitLab merged MR ahead of dated items in the Closed column.
  // Expected order is purely by most-recent resolution: open(updated) > the
  // newer merge > the older merge, regardless of which timestamp carries it.
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");

  // GitHub-style merged PR: closed_at AND merged_at set, merged 2026-06-07.
  upsertItem(db, fixtureItem({ externalId: "PR_GH", state: "merged", closedAt: "2026-06-07T00:00:00Z", mergedAt: "2026-06-07T00:00:00Z", updatedAt: "2026-06-07T00:00:00Z" }), "github/gh", "2026-06-08T00:00:00Z");
  // GitLab-style merged MR: closed_at NULL, merged_at set, merged 2026-05-01 —
  // and a LATER updated_at to prove merged_at (resolution time), not updated_at,
  // drives its position.
  upsertItem(db, fixtureItem({ externalId: "MR_GL", state: "merged", closedAt: null, mergedAt: "2026-05-01T00:00:00Z", updatedAt: "2026-06-09T00:00:00Z" }), "github/gl", "2026-06-08T00:00:00Z");
  // Open item, freshly updated — sorts first by updated_at.
  upsertItem(db, fixtureItem({ externalId: "ISSUE_OPEN", state: "open", updatedAt: "2026-06-10T00:00:00Z" }), "github/open", "2026-06-08T00:00:00Z");

  const order = listLiveItems(db).map((r) => r.external_id);
  assert.deepEqual(order, ["ISSUE_OPEN", "PR_GH", "MR_GL"], "open(06-10) > GitHub merge(06-07) > GitLab merge(05-01)");
  db.close();
});

test("labels are replaced wholesale", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null }, "2026-06-01T00:00:00Z");
  const id = upsertItem(db, fixtureItem(), "github/1", "2026-06-01T00:00:00Z");
  replaceLabels(db, id, [toLabel("bug"), toLabel("priority::high")]);
  assert.equal(listLabels(db).length, 2);
  replaceLabels(db, id, [toLabel("bug")]);
  assert.equal(listLabels(db).length, 1);
  db.close();
});

test("soft-delete tombstones items not seen since the cutoff, and re-seen items revive", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null }, "2026-06-01T00:00:00Z");
  upsertItem(db, fixtureItem(), "github/1", "2026-01-01T00:00:00Z"); // last_seen far in the past

  const removed = softDeleteUnseenItems(db, "github:github.com", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  assert.equal(removed, 1);
  assert.equal(listLiveItems(db).length, 0, "tombstoned item is not live");

  // Re-seeing it clears the tombstone.
  upsertItem(db, fixtureItem(), "github/1", "2026-06-02T00:00:00Z");
  assert.equal(listLiveItems(db).length, 1);
  db.close();
});

test("edge soft-delete tombstones unseen intra-source edges, and re-seen edges revive", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null }, "2026-06-01T00:00:00Z");
  upsertEdge(db, fixtureEdge(), "2026-01-01T00:00:00Z"); // last_seen far in the past

  const removed = softDeleteUnseenEdges(db, "github:github.com", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  assert.equal(removed, 1);
  assert.equal(listLiveEdges(db).length, 0, "tombstoned edge is not live");

  // Re-seeing the same (type, from, to) clears the tombstone.
  upsertEdge(db, fixtureEdge(), "2026-06-02T00:00:00Z");
  assert.equal(listLiveEdges(db).length, 1);
  db.close();
});

test("edge soft-delete is scoped to the source and never touches cross-source edges", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null }, "2026-06-01T00:00:00Z");

  // A cross-source edge (from GitHub PR, to a GitLab issue) seen long ago. A
  // GitHub-only sweep must NOT confirm it disappeared — the GitLab side is not
  // part of this sweep — so it stays live.
  upsertEdge(db, fixtureEdge({ to: { sourceId: "gitlab:gitlab.com", externalId: "gid://gitlab/Issue/9" } }), "2026-01-01T00:00:00Z");
  const removed = softDeleteUnseenEdges(db, "github:github.com", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  assert.equal(removed, 0, "cross-source edge is left untouched by a single-source sweep");
  assert.equal(listLiveEdges(db).length, 1);
  db.close();
});

test("activities are upserted by provider id and listed newest first", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null }, "2026-06-01T00:00:00Z");

  upsertActivity(db, fixtureActivity(), "2026-06-01T00:00:00Z");
  upsertActivity(db, fixtureActivity({ title: "Updated title", summary: "Updated summary", actorKey: "provider-user:github:github.com:updated" }), "2026-06-01T00:01:00Z");
  upsertActivity(db, fixtureActivity({ externalId: "activity-2", occurredAt: "2026-06-02T00:00:00Z", action: "closed" }), "2026-06-02T00:00:00Z");

  const rows = listActivities(db);
  assert.equal(rows.length, 2, "same (source, external_id) updates in place");
  assert.equal(rows[0]!.external_id, "activity-2", "newest activity sorts first");
  assert.equal(rows[1]!.title, "Updated title");
  assert.equal(rows[1]!.actor_key, "provider-user:github:github.com:updated", "actor_key persists and backfills on conflict");
  assert.deepEqual(JSON.parse(rows[1]!.details ?? "{}"), { source: "test" });
  db.close();
});

test("activities are ordered by instant across timezone offsets", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null }, "2026-06-01T00:00:00Z");

  upsertActivity(db, fixtureActivity({ externalId: "gitlab-local", occurredAt: "2026-06-08T16:59:35.000+08:00" }), "2026-06-08T09:00:00Z");
  upsertActivity(db, fixtureActivity({ externalId: "github-utc", occurredAt: "2026-06-08T09:45:23Z" }), "2026-06-08T09:46:00Z");

  assert.deepEqual(listActivities(db).map((row) => row.external_id), ["github-utc", "gitlab-local"]);
  db.close();
});

test("CI refresh candidates include unresolved or recently active change requests", () => {
  const db = openDb(":memory:");
  ensureSource(db, { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null }, "2026-06-01T00:00:00Z");

  upsertItem(db, fixtureItem({ externalId: "PR_PENDING", kind: "change_request", iid: 1, state: "merged", ciState: "pending", updatedAt: "2026-06-08T00:00:00Z", mergedAt: "2026-06-08T00:00:00Z" }), "github/pr-pending", "2026-06-08T00:00:00Z");
  upsertItem(db, fixtureItem({ externalId: "PR_OPEN", kind: "change_request", iid: 2, state: "open", ciState: "passing", updatedAt: "2026-05-01T00:00:00Z" }), "github/pr-open", "2026-06-08T00:00:00Z");
  upsertItem(db, fixtureItem({ externalId: "PR_RECENT", kind: "change_request", iid: 3, state: "merged", ciState: "passing", updatedAt: "2026-06-08T00:00:00Z", mergedAt: "2026-06-08T00:00:00Z" }), "github/pr-recent", "2026-06-08T00:00:00Z");
  upsertItem(db, fixtureItem({ externalId: "PR_OLD_PASSING", kind: "change_request", iid: 4, state: "merged", ciState: "passing", updatedAt: "2026-05-01T00:00:00Z", mergedAt: "2026-05-01T00:00:00Z" }), "github/pr-old", "2026-06-08T00:00:00Z");
  upsertItem(db, fixtureItem({ externalId: "ISSUE_PENDING", kind: "issue", iid: 5, ciState: "pending", updatedAt: "2026-06-08T00:00:00Z" }), "github/issue", "2026-06-08T00:00:00Z");

  assert.deepEqual(
    listCiRefreshCandidates(db, "github:github.com", "2026-06-07T00:00:00Z", 10).map((row) => row.external_id),
    ["PR_PENDING", "PR_OPEN", "PR_RECENT"],
  );
  db.close();
});
