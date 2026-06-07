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
  repoKey,
  deriveRepos,
  applyVisibility,
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
  const iss = item({ id: "I", kind: "issue", state: "closed", updated_at: "2026-06-01T00:00:00Z", title: "Closed issue" });
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
  assert.equal(buildGraph(edges, null).links.length, 3, "no cutoff keeps every edge");
});

test("deriveRepos groups items into (source, project_path) repos with counts, sorted", () => {
  const repos = deriveRepos([
    item({ source_id: "github:github.com", project_path: "o/b" }),
    item({ source_id: "github:github.com", project_path: "o/a" }),
    item({ source_id: "github:github.com", project_path: "o/a" }),
    item({ source_id: "gitlab:gitlab.com", project_path: "g/x" }),
    item({ source_id: "github:github.com", project_path: null }),
  ]);
  assert.deepEqual(
    repos.map((r) => [r.source_id, r.project_path, r.count]),
    [
      ["github:github.com", null, 1], // null path sorts first within the source
      ["github:github.com", "o/a", 2],
      ["github:github.com", "o/b", 1],
      ["gitlab:gitlab.com", "g/x", 1],
    ],
  );
  assert.equal(repos[1]!.key, repoKey("github:github.com", "o/a"));
});

test("applyVisibility drops a hidden repo's items AND every edge touching it", () => {
  const env: ContractEnvelope = {
    contract_version: "1.0.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [],
    items: [
      item({ id: "gh|PR", source_id: "github:github.com", project_path: "o/a", kind: "change_request", state: "merged" }),
      item({ id: "gh|IS", source_id: "github:github.com", project_path: "o/a", state: "closed" }),
      item({ id: "gl|MR", source_id: "gitlab:gitlab.com", project_path: "g/x", kind: "change_request", state: "open" }),
    ],
    edges: [
      { type: "closes", from: "gh|PR", to: "gh|IS", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" }, // intra o/a
      { type: "relates", from: "gh|IS", to: "gl|MR", from_state: "closed", to_state: "open", lifecycle: null }, // cross-repo
      { type: "closes", from: "gl|MR", to: "gh|UNTRACKED", from_state: "open", to_state: null, lifecycle: "declared" }, // untracked end
    ],
  };
  // nothing hidden -> identical reference (cheap no-op)
  assert.equal(applyVisibility(env, new Set()), env);

  const view = applyVisibility(env, new Set([repoKey("github:github.com", "o/a")]));
  assert.deepEqual(view.items.map((i) => i.id), ["gl|MR"], "only the gitlab repo's item survives");
  // both o/a-internal and the cross-repo edge touching o/a are gone; the
  // gl|MR -> untracked edge survives (untracked ends can't be hidden).
  assert.deepEqual(
    view.edges.map((e) => e.type),
    ["closes"],
    "edges touching the hidden repo are removed; the untracked-end edge stays",
  );
  assert.equal(view.edges[0]!.from, "gl|MR");
});
