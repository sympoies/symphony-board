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
} from "../src/db/repo.ts";
import type { CanonicalItem } from "../src/model/types.ts";
import { toLabel } from "../src/model/labels.ts";

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
