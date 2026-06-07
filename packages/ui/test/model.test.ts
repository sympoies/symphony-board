import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContractEnvelope, ItemDTO } from "@symphony-board/contract";
import {
  emptyFilters,
  itemMatches,
  groupItems,
  indexItems,
  resolveEdges,
  edgeMatches,
  computeStats,
  relativeTime,
} from "../src/model.ts";

function item(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "github:github.com|X", source_id: "github:github.com", external_id: "X", kind: "issue",
    project_path: "o/r", iid: 1, url: "https://x", title: "Title", state: "open", state_raw: "OPEN",
    state_reason: null, is_draft: null, author: "a", created_at: null, updated_at: null, closed_at: null,
    merged_at: null, labels: [], review_state: null, ci_state: null, merge_state: null, milestone: null,
    demand: 0, last_seen_at: null, ...over,
  };
}

test("itemMatches applies source/state/kind/search filters (AND)", () => {
  const it = item({ title: "Flaky test", author: "graysurf", labels: [{ name: "bug", scope: null, color: null }] });
  assert.equal(itemMatches(it, emptyFilters()), true);
  assert.equal(itemMatches(it, { ...emptyFilters(), states: new Set(["closed"]) }), false);
  assert.equal(itemMatches(it, { ...emptyFilters(), kinds: new Set(["issue"]) }), true);
  assert.equal(itemMatches(it, { ...emptyFilters(), search: "flaky" }), true, "search is case-insensitive");
  assert.equal(itemMatches(it, { ...emptyFilters(), search: "bug" }), true, "search hits labels");
  assert.equal(itemMatches(it, { ...emptyFilters(), search: "nope" }), false);
});

test("groupItems groups by the chosen dimension with sorted keys", () => {
  const items = [
    item({ id: "1", project_path: "o/b" }),
    item({ id: "2", project_path: "o/a" }),
    item({ id: "3", project_path: "o/a" }),
  ];
  const groups = groupItems(items, "repo");
  assert.deepEqual(groups.map((g) => g.key), ["o/a", "o/b"]);
  assert.equal(groups[0]!.items.length, 2);
});

test("resolveEdges + edgeMatches handle tracked and cross-repo endpoints", () => {
  const env: ContractEnvelope = {
    contract_version: "1.0.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [],
    items: [item({ id: "github:github.com|PR", external_id: "PR", kind: "change_request", state: "merged" }), item({ id: "github:github.com|IS", external_id: "IS", state: "closed" })],
    edges: [
      { type: "closes", from: "github:github.com|PR", to: "github:github.com|IS", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" },
      { type: "closes", from: "github:github.com|PR", to: "github:github.com|UNTRACKED", from_state: "merged", to_state: null, lifecycle: "declared" },
    ],
  };
  const resolved = resolveEdges(env, indexItems(env));
  assert.equal(resolved[0]!.from?.external_id, "PR");
  assert.equal(resolved[0]!.to?.external_id, "IS");
  assert.equal(resolved[1]!.to, null, "untracked endpoint resolves to null");
  // both endpoints untracked -> always shown; otherwise must match a resolved end
  assert.equal(edgeMatches(resolved[1]!, { ...emptyFilters(), states: new Set(["open"]) }), false, "merged PR end fails an open-only filter");
  assert.equal(edgeMatches(resolved[0]!, { ...emptyFilters(), states: new Set(["closed"]) }), true, "closed issue end passes");
});

test("computeStats counts items by state/kind and edges by lifecycle", () => {
  const items = [item({ state: "open", kind: "issue" }), item({ state: "merged", kind: "change_request" })];
  const stats = computeStats(items, [
    { type: "closes", from: "a|1", to: "b|2", from_state: null, to_state: null, lifecycle: "fulfilled" },
    { type: "relates", from: "a|1", to: "b|3", from_state: null, to_state: null, lifecycle: null },
  ]);
  assert.equal(stats.items, 2);
  assert.deepEqual(stats.byState, { open: 1, merged: 1 });
  assert.deepEqual(stats.byKind, { issue: 1, change_request: 1 });
  assert.deepEqual(stats.byLifecycle, { fulfilled: 1, other: 1 });
});

test("relativeTime renders coarse buckets from an injected now", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");
  assert.equal(relativeTime("2026-06-07T00:00:00Z", now), "3d ago");
  assert.equal(relativeTime("2026-06-09T23:59:40Z", now), "just now");
  assert.equal(relativeTime(null, now), "—");
});
