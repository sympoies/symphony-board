import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContractEnvelope, ItemDTO } from "@symphony-board/contract";
import {
  ACTIVE_SINCE_PRESETS,
  DEFAULT_ACTIVE_SINCE_DAYS,
  defaultActiveSince,
  emptyFilters,
  itemMatches,
  indexItems,
  resolveEdges,
  edgeMatches,
  computeStats,
  relativeTime,
  buildGraph,
  buildAdjacency,
  focusSubgraph,
  relatedItems,
  cutoffIso,
  repoKey,
  deriveRepos,
  applyVisibility,
  buildColorIndex,
  resolveRepoColor,
  isHexColor,
  compareGraphNodes,
  parseHashRoute,
  buildHashRoute,
  graphFocusHref,
  applyRouteSearch,
  edgeEndpointIds,
  itemSearchToken,
  itemActiveSince,
  graphEffectiveSince,
  type ResolvedEdge,
  type GraphNode,
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

test("itemMatches: multi-term AND + exact #iid (so a 'repo #iid' deep-link pins one item)", () => {
  const it13 = item({ id: "g|13", project_path: "owner/repo", iid: 13, title: "Add thing" });
  const it130 = item({ id: "g|130", project_path: "owner/repo", iid: 130, title: "Other" });
  const otherRepo = item({ id: "g|x", project_path: "owner/other", iid: 13, title: "Elsewhere" });
  const f = (search: string) => ({ ...emptyFilters(), search });
  // terms are AND'd, NOT matched as one contiguous substring
  assert.equal(itemMatches(it13, f("add thing")), true, "both words present -> match");
  assert.equal(itemMatches(it13, f("thing add")), true, "order-independent");
  assert.equal(itemMatches(it13, f("add nope")), false, "one missing term fails the AND");
  // a "#<n>" term is an EXACT iid match, never a substring -> #13 must not hit #130
  assert.equal(itemMatches(it13, f("#13")), true);
  assert.equal(itemMatches(it130, f("#13")), false, "#13 must not match #130");
  assert.equal(itemMatches(item({ iid: null }), f("#13")), false, "no iid never matches a #<n> term");
  assert.equal(itemMatches(it13, f("#")), false, "a bare # is not a number term -> substring miss");
  assert.equal(itemMatches(item({ iid: 0 }), f("#0")), true, "iid 0 matches #0 (guard is != null, not truthiness)");
  assert.equal(itemMatches(it13, f("#013")), false, "leading zeros do not widen the iid match");
  // the "repo #iid" token pins exactly one item even across repos sharing an iid
  assert.equal(itemMatches(it13, f("owner/repo #13")), true);
  assert.equal(itemMatches(it130, f("owner/repo #13")), false, "same repo, wrong iid");
  assert.equal(itemMatches(otherRepo, f("owner/repo #13")), false, "same iid, wrong repo");
});

test("itemSearchToken builds a 'repo #iid' token that itemMatches pins to its own item", () => {
  const it = item({ project_path: "owner/repo", iid: 13 });
  assert.equal(itemSearchToken(it), "owner/repo #13");
  const f = (search: string) => ({ ...emptyFilters(), search });
  assert.equal(itemMatches(it, f(itemSearchToken(it))), true, "token matches its source item");
  assert.equal(itemMatches(item({ project_path: "owner/repo", iid: 130 }), f(itemSearchToken(it))), false, "not a sibling iid");
  // fallbacks when repo / iid are absent (token still narrows via title / external_id)
  assert.equal(itemSearchToken(item({ project_path: null, iid: null, title: "Just a title" })), "Just a title");
  assert.equal(itemSearchToken(item({ project_path: "o/r", iid: null, title: null, external_id: "EXT" })), "EXT");
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

test("active-since presets are shared and itemActiveSince uses updated_at", () => {
  assert.equal(DEFAULT_ACTIVE_SINCE_DAYS, 90);
  assert.deepEqual(ACTIVE_SINCE_PRESETS.map(([label]) => label), ["1w", "2w", "1mo", "3mo", "all"]);
  assert.equal(defaultActiveSince(Date.parse("2026-06-10T00:00:00Z")), "2026-03-12");
  const cutoff = "2026-06-01T00:00:00.000Z";
  assert.equal(itemActiveSince(item({ updated_at: "2026-06-01T00:00:00Z" }), cutoff), true);
  assert.equal(itemActiveSince(item({ updated_at: "2026-05-31T23:59:59Z" }), cutoff), false);
  assert.equal(itemActiveSince(item({ updated_at: null }), cutoff), false);
  assert.equal(itemActiveSince(item({ updated_at: null }), null), true, "all keeps undated items");
});

test("graphEffectiveSince defaults a deep-link-owned all window before cleared search renders", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");
  assert.equal(graphEffectiveSince("", { narrowed: false, relaxedForFocus: true, now }), "2026-03-12");
  assert.equal(graphEffectiveSince("", { narrowed: true, relaxedForFocus: true, now }), "", "search narrowing keeps the focused all-time relaxation");
  assert.equal(graphEffectiveSince("", { narrowed: false, relaxedForFocus: false, now }), "", "manual all-time choice is preserved");
  assert.equal(graphEffectiveSince("2026-01-01", { narrowed: false, relaxedForFocus: true, now }), "2026-01-01", "manual date is preserved");
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

// The Graph page's focus view: focusSubgraph builds the focused item + its direct
// neighbours and every edge among that set, from the RAW edges — all edge types,
// no time window — so a focus shows ALL its relationships (the overview graph's
// mentions toggle / "active since" window do not apply in focus).
const redge = (from: string, to: string, type: string): ResolvedEdge => ({
  // 2020 timestamps: well outside any recent window, to prove focusSubgraph ignores it.
  edge: { type, from, to, from_state: null, to_state: null, lifecycle: type === "closes" ? "fulfilled" : null },
  from: item({ id: from, updated_at: "2020-01-01T00:00:00Z" }),
  to: item({ id: to, updated_at: "2020-01-01T00:00:00Z" }),
});

test("focusSubgraph: a focus shows its full neighbourhood — every edge type, no time window", () => {
  const edges: ResolvedEdge[] = [
    redge("A", "F", "closes"),
    redge("B", "F", "mentions"), // a mention TO the focus IS drawn (the overview filters mentions; focus does not)
    redge("A", "B", "relates"), // neighbour–neighbour edge among the kept set is kept too
    redge("A", "Z", "closes"), // Z does not touch the focus -> excluded
  ];
  const g = focusSubgraph(edges, "F");
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["A", "B", "F"], "focus + direct neighbours only (Z dropped)");
  assert.equal(g.links.length, 3, "A–F, B–F, A–B all kept despite 2020 timestamps (no window) and the mention");
  assert.ok(g.links.some((l) => l.type === "mentions"), "the mention to the focus is drawn");
});

test("focusSubgraph: a focus with no incident edges yields an empty graph (caller falls back)", () => {
  assert.equal(focusSubgraph([], "F").nodes.length, 0);
  assert.equal(focusSubgraph([redge("X", "Y", "closes")], "F").nodes.length, 0, "no edge touches F -> empty");
});

test("repoKey is collision-proof and deriveRepos handles an empty contract", () => {
  assert.equal(repoKey("github:github.com", "o/a"), repoKey("github:github.com", "o/a"), "stable for equal inputs");
  assert.notEqual(repoKey("github:github.com", null), repoKey("github:github.com", ""), "null path != empty path");
  assert.notEqual(repoKey("a", "b c"), repoKey("a b", "c"), "no separator collision across the (source, path) boundary");
  assert.deepEqual(deriveRepos([]), [], "no items -> no repos");
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
      { type: "closes", from: "gh|PR", to: "gh|IS", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" }, // both ends in o/a (both hidden)
      { type: "relates", from: "gh|IS", to: "gl|MR", from_state: "closed", to_state: "open", lifecycle: null }, // cross-repo: hidden + visible
      { type: "mentions", from: "gh|PR", to: "gh|EXT", from_state: "merged", to_state: null, lifecycle: null }, // hidden + untracked
      { type: "closes", from: "gl|MR", to: "gh|EXT", from_state: "open", to_state: null, lifecycle: "declared" }, // visible + untracked
    ],
  };
  // nothing hidden -> identical reference (cheap no-op)
  assert.equal(applyVisibility(env, new Set()), env);

  const view = applyVisibility(env, new Set([repoKey("github:github.com", "o/a")]));
  assert.deepEqual(view.items.map((i) => i.id), ["gl|MR"], "only the gitlab repo's item survives");
  // every edge touching o/a is dropped — including the hidden->untracked one (an
  // untracked counterpart does NOT rescue an edge whose other end is hidden).
  // Only the visible->untracked "closes" edge survives.
  assert.deepEqual(
    view.edges.map((e) => e.type),
    ["closes"],
    "edges touching the hidden repo are removed; the visible-end + untracked edge stays",
  );
  assert.equal(view.edges[0]!.from, "gl|MR");
});

test("applyVisibility hides a whole source independently of the repo set", () => {
  const env: ContractEnvelope = {
    contract_version: "1.1.0", generated_at: "2026-06-07T00:00:00Z", generator: "t", sources: [],
    items: [
      item({ id: "gh|A", source_id: "github:github.com", project_path: "o/a" }),
      item({ id: "gl|B", source_id: "gitlab:gitlab.com", project_path: "g/x" }),
    ],
    edges: [{ type: "relates", from: "gh|A", to: "gl|B", from_state: "open", to_state: "open", lifecycle: null }],
  };
  // hide the github SOURCE with an EMPTY repo set: gh|A and the cross-repo edge go.
  const view = applyVisibility(env, new Set(), new Set(["github:github.com"]));
  assert.deepEqual(view.items.map((i) => i.id), ["gl|B"], "the hidden source's item is gone");
  assert.deepEqual(view.edges, [], "the edge touching the hidden source is gone");
  // the two layers compose (OR): hide gitlab's repo AND github's source -> nothing.
  const both = applyVisibility(env, new Set([repoKey("gitlab:gitlab.com", "g/x")]), new Set(["github:github.com"]));
  assert.deepEqual(both.items.map((i) => i.id), [], "source-hide and repo-hide compose");
});

test("buildColorIndex + resolveRepoColor resolve override -> repo -> source -> none", () => {
  const env: ContractEnvelope = {
    contract_version: "1.1.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [
      { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GH", last_success_at: null, last_status: "ok", color: "#111111" },
      { source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", display_name: "GL", last_success_at: null, last_status: "ok", color: null },
    ],
    items: [],
    edges: [],
    repos: [{ source_id: "github:github.com", project_path: "o/repo", color: "#222222" }],
  };
  const idx = buildColorIndex(env);
  const none = new Map<string, string>();
  assert.equal(resolveRepoColor("github:github.com", "o/repo", idx, none), "#222222", "repo color beats source color");
  assert.equal(resolveRepoColor("github:github.com", "O/REPO", idx, none), "#222222", "repo match is case-insensitive (GitHub canonicalizes case)");
  assert.equal(resolveRepoColor("github:github.com", "o/other", idx, none), "#111111", "no repo color -> source color");
  assert.equal(resolveRepoColor("gitlab:gitlab.com", "g/x", idx, none), null, "no repo and no source color -> none");
  const ov = new Map([[repoKey("github:github.com", "o/repo"), "#abcdef"]]);
  assert.equal(resolveRepoColor("github:github.com", "o/repo", idx, ov), "#abcdef", "an override beats everything");
});

test("isHexColor accepts #rgb/#rrggbb only; buildColorIndex drops anything else (CSS-sink guard)", () => {
  assert.equal(isHexColor("#abc"), true);
  assert.equal(isHexColor("#A1B2C3"), true);
  for (const bad of ["red", "#abcd", "#12g", "url(https://evil/x)", "#fff; background:url(x)", "", null, 123])
    assert.equal(isHexColor(bad as unknown), false, `rejects ${JSON.stringify(bad)}`);
  // a non-hex color in the contract is dropped, not indexed -> no highlight
  const env: ContractEnvelope = {
    contract_version: "1.1.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [{ source_id: "s", kind: "github", host: "h", display_name: null, last_success_at: null, last_status: null, color: "url(https://evil/x)" }],
    items: [], edges: [],
    repos: [{ source_id: "s", project_path: "o/r", color: "javascript:alert(1)" }],
  };
  const idx = buildColorIndex(env);
  assert.equal(resolveRepoColor("s", "o/r", idx, new Map()), null, "malformed config colors never reach a CSS sink");
});

test("buildAdjacency records both directions per edge and dedupes", () => {
  const re = (from: string, to: string, type: string): ResolvedEdge => ({
    edge: { type, from, to, from_state: null, to_state: null, lifecycle: null },
    from: null,
    to: null,
  });
  const adj = buildAdjacency([
    re("PR", "IS", "closes"),
    re("PR", "IS", "closes"), // duplicate edge -> deduped
    re("PR", "EXT", "mentions"),
  ]);
  // PR sees both its targets, as outgoing
  assert.deepEqual(adj.get("PR"), [
    { ref: "IS", type: "closes", direction: "out" },
    { ref: "EXT", type: "mentions", direction: "out" },
  ]);
  // IS sees PR as an incoming "closes"
  assert.deepEqual(adj.get("IS"), [{ ref: "PR", type: "closes", direction: "in" }]);
  assert.deepEqual(adj.get("EXT"), [{ ref: "PR", type: "mentions", direction: "in" }]);
});

test("buildAdjacency handles empty input, distinct types on one pair, and self-loops", () => {
  const re = (from: string, to: string, type: string): ResolvedEdge => ({
    edge: { type, from, to, from_state: null, to_state: null, lifecycle: null },
    from: null,
    to: null,
  });
  assert.equal(buildAdjacency([]).size, 0, "no edges -> empty map");

  // same pair, two edge types -> both kept (dedupe is per (ref, type, direction))
  const twoTypes = buildAdjacency([re("A", "B", "closes"), re("A", "B", "relates")]);
  assert.deepEqual(twoTypes.get("A"), [
    { ref: "B", type: "closes", direction: "out" },
    { ref: "B", type: "relates", direction: "out" },
  ]);

  // self-loop -> both an out and an in entry on the same ref
  assert.deepEqual(buildAdjacency([re("X", "X", "relates")]).get("X"), [
    { ref: "X", type: "relates", direction: "out" },
    { ref: "X", type: "relates", direction: "in" },
  ]);
});

test("relatedItems gives one card per ref: strongest type wins, mutual -> both", () => {
  const out = relatedItems([
    { ref: "B", type: "mentions", direction: "out" },
    { ref: "B", type: "mentions", direction: "in" }, // mutual mention with B...
    { ref: "B", type: "closes", direction: "in" }, // ...but B also closes -> closes wins (stronger after weaker)
    { ref: "C", type: "mentions", direction: "out" }, // mention only -> stays "out"
    { ref: "D", type: "closes", direction: "in" }, // closes only -> stays "in"
    { ref: "E", type: "mentions", direction: "out" },
    { ref: "E", type: "mentions", direction: "in" }, // mutual mention, no stronger type -> "both"
    { ref: "F", type: "closes", direction: "out" },
    { ref: "F", type: "mentions", direction: "in" }, // weaker after stronger -> dropped
  ]);
  assert.deepEqual(out, [
    { ref: "B", type: "closes", direction: "in" }, // one card; closes beats the mention
    { ref: "C", type: "mentions", direction: "out" },
    { ref: "D", type: "closes", direction: "in" },
    { ref: "E", type: "mentions", direction: "both" },
    { ref: "F", type: "closes", direction: "out" },
  ]);
});

function gnode(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "id", label: "label", repo: "o/r", iid: 1, kind: "issue", state: "open", url: null,
    color: "#000", demand: 0, created_at: null, updated_at: null, untracked: false, ...over,
  };
}

test("compareGraphNodes orders by state bucket then newest-created, not demand (#32)", () => {
  const openOld = gnode({ id: "o1", label: "open-old", state: "open", created_at: "2026-01-01T00:00:00Z", demand: 0 });
  const o2 = gnode({ id: "o2", label: "open-newer", state: "open", created_at: "2026-05-01T00:00:00Z" });
  const mergedNew = gnode({ id: "m1", label: "merged-new", state: "merged", created_at: "2026-06-01T00:00:00Z", demand: 99 });
  const closedNew = gnode({ id: "c1", label: "closed-new", state: "closed", created_at: "2026-06-02T00:00:00Z" });
  const c2 = gnode({ id: "c2", label: "closed-older", state: "closed", created_at: "2026-05-01T00:00:00Z" });

  // open beats closed/merged regardless of recency or (high) demand
  assert.ok(compareGraphNodes(openOld, mergedNew) < 0, "open before merged even when older / lower-demand");
  assert.ok(compareGraphNodes(openOld, closedNew) < 0, "open before closed even when older");
  // within a bucket: newest created_at first; closed & merged share one bucket
  assert.ok(compareGraphNodes(o2, openOld) < 0, "newer open before older open");
  assert.ok(compareGraphNodes(mergedNew, c2) < 0, "merged & closed share a bucket, ordered by date");

  const order = [c2, mergedNew, openOld, closedNew, o2].slice().sort(compareGraphNodes).map((n) => n.id);
  assert.deepEqual(order, ["o2", "o1", "c1", "m1", "c2"], "opens (newest→oldest), then closed/merged (newest→oldest)");
});

test("compareGraphNodes: undated nodes sort last in their bucket, with a stable id tie-break (#32)", () => {
  const dated = gnode({ id: "d", label: "dated", state: "open", created_at: "2026-01-01T00:00:00Z" });
  const undatedZ = gnode({ id: "zzz", label: "u", state: "open", created_at: null });
  const undatedA = gnode({ id: "aaa", label: "u", state: "open", created_at: null });
  assert.ok(compareGraphNodes(dated, undatedZ) < 0, "a dated node precedes an undated one in the same bucket");
  assert.ok(compareGraphNodes(undatedZ, dated) > 0, "and the relation is symmetric");
  assert.ok(compareGraphNodes(undatedZ, undatedA) > 0, "equal label -> id breaks the tie deterministically ('aaa' < 'zzz')");

  // same bucket + same created_at + same label -> id is the final, stable tie-break
  const t1 = gnode({ id: "b", label: "same", state: "closed", created_at: "2026-03-03T00:00:00Z" });
  const t2 = gnode({ id: "a", label: "same", state: "merged", created_at: "2026-03-03T00:00:00Z" });
  assert.ok(compareGraphNodes(t1, t2) > 0, "same bucket/date/label -> id tie-break stays stable");
});

test("parseHashRoute splits page from the optional ?focus= / ?q= deep-link params", () => {
  assert.deepEqual(parseHashRoute(""), { page: "", focus: null, q: null }, "empty hash -> board, no params");
  assert.deepEqual(parseHashRoute("#/"), { page: "", focus: null, q: null });
  assert.deepEqual(parseHashRoute("#/graph"), { page: "graph", focus: null, q: null });
  assert.deepEqual(parseHashRoute("#/settings"), { page: "settings", focus: null, q: null });
  // focus + q are pulled off the hash and percent-decoded
  assert.deepEqual(parseHashRoute("#/graph?focus=github%3Agithub.com%7C42&q=owner%2Frepo%20%2342"), {
    page: "graph",
    focus: "github:github.com|42",
    q: "owner/repo #42",
  });
  // params on a non-graph page still parse (App only acts on them for the graph)
  assert.deepEqual(parseHashRoute("#/?focus=x"), { page: "", focus: "x", q: null });
  // empty/absent values are normalized to null
  assert.deepEqual(parseHashRoute("#/graph?focus="), { page: "graph", focus: null, q: null });
  assert.deepEqual(parseHashRoute("#/graph?q=%20%20"), { page: "graph", focus: null, q: null });
  assert.deepEqual(parseHashRoute("#/graph?other=1"), { page: "graph", focus: null, q: null });
});

test("buildHashRoute writes the same route shape parseHashRoute reads", () => {
  assert.equal(buildHashRoute({ page: "" }), "#/");
  assert.equal(buildHashRoute({ page: "graph", q: "owner/repo #13" }), "#/graph?q=owner%2Frepo%20%2313");
  assert.equal(
    buildHashRoute({ page: "graph", focus: "github:github.com|42", q: "owner/repo #42" }),
    "#/graph?focus=github%3Agithub.com%7C42&q=owner%2Frepo%20%2342",
  );
  assert.equal(buildHashRoute({ page: "settings", q: "  " }), "#/settings");
  assert.deepEqual(parseHashRoute(buildHashRoute({ page: "", q: "owner/repo #13" })), {
    page: "",
    focus: null,
    q: "owner/repo #13",
  });
});

test("graphFocusHref round-trips an item's id + search token through parseHashRoute", () => {
  const it = (over: Partial<ItemDTO>) => item(over);
  for (const over of [
    { id: "github:github.com|42", project_path: "owner/repo", iid: 42 },
    { id: "gitlab:gitlab.com|gid://gitlab/Issue/1", project_path: "grp/sub/proj", iid: 1 },
    { id: "a|b/c:d", project_path: null, iid: null, title: "Bare title", external_id: "b/c:d" },
  ]) {
    const r = parseHashRoute(graphFocusHref(it(over)));
    assert.equal(r.page, "graph");
    assert.equal(r.focus, over.id, `focus round-trips for ${over.id}`);
    assert.equal(r.q, itemSearchToken(it(over)), `q carries the search token for ${over.id}`);
  }
});

test("applyRouteSearch mirrors the route q so search never hides outside the URL", () => {
  const route = (q: string | null) => ({ page: "graph", focus: null, q });
  // a present q seeds the search (deep-link narrowing / URL-backed user search)
  assert.equal(applyRouteSearch(emptyFilters(), route("owner/repo #13")).search, "owner/repo #13");
  // an absent q clears search, so navigating to "#/graph" cannot carry a hidden
  // board/deep-link query that is missing from the URL.
  const typed = { ...emptyFilters(), search: "user typed" };
  assert.deepEqual(applyRouteSearch(typed, route(null)), emptyFilters(), "absent q -> clear search");
  // q equal to the current search -> same object (no needless re-render)
  const cur = { ...emptyFilters(), search: "owner/repo #13" };
  assert.equal(applyRouteSearch(cur, route("owner/repo #13")), cur, "unchanged q -> same reference");
  const empty = emptyFilters();
  assert.equal(applyRouteSearch(empty, route(null)), empty, "already-empty search -> same reference");
});

test("edgeEndpointIds collects both ends of every edge (board-card graph membership)", () => {
  assert.equal(edgeEndpointIds([]).size, 0, "no edges -> empty set");
  const ids = edgeEndpointIds([
    { type: "closes", from: "s|A", to: "s|B", from_state: null, to_state: null, lifecycle: null },
    { type: "mentions", from: "s|B", to: "s|UNTRACKED", from_state: null, to_state: null, lifecycle: null },
  ]);
  // both ends of both edges, deduped; an untracked ref is kept (harmless — it
  // never matches a board item id). A `mentions`-only endpoint still counts as
  // linked, matching the graph's "any edge -> a node" membership rule.
  assert.deepEqual([...ids].sort(), ["s|A", "s|B", "s|UNTRACKED"]);
});
