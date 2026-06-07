import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContractEnvelope, ItemDTO } from "@symphony-board/contract";
import {
  emptyFilters,
  itemMatches,
  indexItems,
  resolveEdges,
  edgeMatches,
  computeStats,
  relativeTime,
  buildGraph,
  cutoffIso,
  type ResolvedEdge,
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

test("cutoffIso is deterministic for a fixed now", () => {
  const now = Date.parse("2026-06-07T00:00:00Z");
  assert.equal(cutoffIso(90, now).slice(0, 10), "2026-03-09");
});

test("buildGraph keeps only edge-connected nodes, applies the time window, and flags untracked ends", () => {
  const pr = item({ id: "P", kind: "change_request", state: "merged", updated_at: "2026-06-01T00:00:00Z", url: "https://pr" });
  const iss = item({ id: "I", kind: "issue", state: "closed", created_at: "2026-05-20T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", title: "Closed issue" });
  const oldPr = item({ id: "OP", kind: "change_request", state: "merged", updated_at: "2020-01-01T00:00:00Z" });
  const oldIss = item({ id: "OI", kind: "issue", state: "closed", updated_at: "2020-01-01T00:00:00Z" });
  const edges: ResolvedEdge[] = [
    { edge: { type: "closes", from: "P", to: "I", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" }, from: pr, to: iss },
    { edge: { type: "closes", from: "OP", to: "OI", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" }, from: oldPr, to: oldIss },
    { edge: { type: "closes", from: "P", to: "github:github.com|UNTRACKED", from_state: "merged", to_state: null, lifecycle: "declared" }, from: pr, to: null },
  ];
  const g = buildGraph(edges, "2026-03-01T00:00:00Z");
  assert.equal(g.links.length, 2, "the all-old edge is dropped; recent + untracked kept");
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(ids.has("P") && ids.has("I") && ids.has("github:github.com|UNTRACKED"));
  assert.ok(!ids.has("OP") && !ids.has("OI"), "nodes outside the window are excluded");
  const untracked = g.nodes.find((n) => n.id === "github:github.com|UNTRACKED");
  assert.equal(untracked?.untracked, true);
  assert.equal(untracked?.label, "UNTRACKED", "untracked label is the bare ref tail");
  assert.equal(untracked?.created_at, null, "untracked node carries no timestamps");
  assert.equal(untracked?.updated_at, null);
  // tracked nodes carry created_at / updated_at through to the node card (#24)
  const tracked = g.nodes.find((n) => n.id === "I");
  assert.equal(tracked?.created_at, "2026-05-20T00:00:00Z", "tracked node carries created_at");
  assert.equal(tracked?.updated_at, "2026-06-01T00:00:00Z", "tracked node carries updated_at");
  assert.equal(buildGraph(edges, null).links.length, 3, "no cutoff keeps every edge");
});
