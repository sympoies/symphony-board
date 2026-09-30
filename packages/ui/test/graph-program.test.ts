import { test } from "node:test";
import assert from "node:assert/strict";
import type { EdgeDTO, ItemDTO } from "@symphony-board/contract";
import {
  buildHashRoute,
  graphCanvasEmptyReason,
  graphEdgeStyle,
  graphEdgeTypes,
  graphOverviewVisibility,
  graphProgramView,
  parseHashRoute,
  programLayers,
  programScopeEdges,
  relatedItems,
  resolveEdgeList,
  transitiveReduction,
  type ResolvedEdge,
} from "../src/model.ts";
import { programRollups } from "../src/program.ts";

const SRC = "github:github.com";
const ref = (externalId: string): string => `${SRC}|${externalId}`;

function item(externalId: string, over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: ref(externalId), source_id: SRC, external_id: externalId, kind: "issue",
    project_path: "o/r", iid: 1, url: `https://x/${externalId}`, title: externalId, state: "open", state_raw: "OPEN",
    state_reason: null, is_draft: null, author: "a", created_at: null, updated_at: "2026-06-14T00:00:00Z", closed_at: null,
    merged_at: null, labels: [], review_state: null, ci_state: null, merge_state: null, review_threads: null,
    milestone: null, demand: 0, last_seen_at: null, ...over,
  };
}

const edge = (type: string, from: string, to: string, lifecycle: string | null = null): EdgeDTO => ({
  type, from: ref(from), to: ref(to), from_state: null, to_state: null, lifecycle,
});

const resolve = (items: ItemDTO[], edges: EdgeDTO[]): ResolvedEdge[] =>
  resolveEdgeList(edges, new Map(items.map((it) => [it.id, it])));

// `type from>to` with the source prefix stripped, for readable assertions.
const short = (id: string): string => id.slice(SRC.length + 1);
const edgeText = (edges: readonly ResolvedEdge[]): string[] => edges.map((re) => `${re.edge.type} ${short(re.edge.from)}>${short(re.edge.to)}`);
const pairs = (text: string): Array<[string, string]> => text.split(" ").filter(Boolean).map((pair) => pair.split(">") as [string, string]);
const pairText = (edges: ReadonlyArray<readonly [string, string]>): string => edges.map(([from, to]) => `${from}>${to}`).join(" ");

test("transitiveReduction drops an edge implied by a longer path", () => {
  const chain = transitiveReduction(pairs("A>B B>C A>C"));
  assert.equal(pairText(chain.edges), "A>B B>C");
  assert.equal(chain.cyclic, false);

  const diamond = transitiveReduction(pairs("A>B A>C B>D C>D A>D"));
  assert.equal(pairText(diamond.edges), "A>B A>C B>D C>D", "both arms stay; only the shortcut goes");

  const disconnected = transitiveReduction(pairs("A>B C>D"));
  assert.equal(pairText(disconnected.edges), "A>B C>D");
  assert.deepEqual(transitiveReduction([]), { edges: [], cyclic: false });
});

test("transitiveReduction thins a contracted gate but keeps a bare fan-in x fan-out", () => {
  // Rows P1, P2 after P1, P3 after P2, a gate after all three, D1 and D2 after
  // the gate: contraction emits every P -> every D.
  const chained = transitiveReduction(pairs("P1>P2 P2>P3 P1>D1 P1>D2 P2>D1 P2>D2 P3>D1 P3>D2"));
  assert.equal(pairText(chained.edges), "P1>P2 P2>P3 P3>D1 P3>D2");

  // Independent prerequisites: the complete bipartite set implies nothing.
  const bipartite = pairs("P1>D1 P1>D2 P2>D1 P2>D2 P3>D1 P3>D2");
  assert.equal(pairText(transitiveReduction(bipartite).edges), pairText(bipartite));
});

test("transitiveReduction returns every edge when the graph has a cycle", () => {
  const cyclic = transitiveReduction(pairs("A>B B>C C>A A>C"));
  assert.equal(cyclic.cyclic, true);
  assert.equal(pairText(cyclic.edges), "A>B B>C C>A A>C");
});

test("transitiveReduction ignores self edges and repeats", () => {
  const out = transitiveReduction(pairs("A>A A>B A>B B>C"));
  assert.equal(pairText(out.edges), "A>B B>C");
  assert.equal(out.cyclic, false);
});

test("relatedItems ranks closes, then blocks, parent, mentions, relates", () => {
  const out = relatedItems([
    { ref: "B", type: "parent", direction: "out" },
    { ref: "B", type: "blocks", direction: "in" },
    { ref: "C", type: "mentions", direction: "out" },
    { ref: "C", type: "parent", direction: "in" },
    { ref: "D", type: "relates", direction: "out" },
    { ref: "D", type: "mentions", direction: "out" },
    { ref: "E", type: "blocks", direction: "out" },
    { ref: "E", type: "closes", direction: "in" },
    { ref: "F", type: "relates", direction: "out" },
    { ref: "F", type: "duplicates", direction: "out" },
    { ref: "G", type: "duplicates", direction: "out" },
    { ref: "G", type: "mentions", direction: "in" },
  ]);
  assert.deepEqual(out.map((entry) => `${entry.ref} ${entry.type} ${entry.direction}`), [
    "B blocks in",
    "C parent in",
    "D mentions out",
    "E closes in",
    "F duplicates out", // an unknown type still ranks between mentions and relates
    "G mentions in",
  ]);
});

test("graphEdgeTypes lists the types present, strongest first", () => {
  const edges = resolve([], [
    edge("relates", "A", "B"), edge("mentions", "A", "B"), edge("duplicates", "A", "B"),
    edge("parent", "T", "A"), edge("closes", "P", "A"), edge("blocks", "A", "B"), edge("parent", "T", "B"),
  ]);
  assert.deepEqual(graphEdgeTypes(edges), ["closes", "blocks", "parent", "mentions", "duplicates", "relates"]);
  assert.deepEqual(graphEdgeTypes(resolve([], [edge("closes", "P", "A")])), ["closes"]);
  assert.deepEqual(graphEdgeTypes([]), []);
});

test("graphOverviewVisibility hides the relation types that are switched off", () => {
  const items = [item("T"), item("A"), item("B"), item("P", { kind: "change_request" })];
  const edges = resolve(items, [edge("parent", "T", "A"), edge("blocks", "A", "B"), edge("closes", "P", "A", "declared"), edge("mentions", "B", "T")]);
  const range = { from: "2026-06-14", to: "2026-06-14" };

  const byDefault = graphOverviewVisibility(edges, range, "UTC");
  assert.deepEqual(edgeText(byDefault.drawnEdges), ["parent T>A", "blocks A>B", "closes P>A"], "every type but mentions is on by default");

  const noParent = graphOverviewVisibility(edges, range, "UTC", { showMentions: false, mentionTarget: "all", hiddenTypes: new Set(["parent"]) });
  assert.deepEqual(edgeText(noParent.drawnEdges), ["blocks A>B", "closes P>A"]);
  assert.equal(noParent.candidateEdges.length, 4, "the side list still indexes every in-range relationship");
  assert.equal(noParent.drawnIds.has(ref("T")), false, "the tracker leaves the canvas with its only drawn edge type");
  assert.equal(noParent.candidateIds.has(ref("T")), true);

  const onlyMentions = graphOverviewVisibility(edges, range, "UTC", { showMentions: true, mentionTarget: "all", hiddenTypes: new Set(["parent", "blocks", "closes"]) });
  assert.deepEqual(edgeText(onlyMentions.drawnEdges), ["mentions B>T"]);
});

test("graphCanvasEmptyReason blames mentions only when mentions are all that is hidden", () => {
  const items = [item("T"), item("A"), item("B")];
  const range = { from: "2026-06-14", to: "2026-06-14" };
  const hidden = { showMentions: false, mentionTarget: "all" as const, hiddenTypes: new Set(["parent"]) };

  const mixed = graphOverviewVisibility(resolve(items, [edge("parent", "T", "A"), edge("mentions", "A", "B")]), range, "UTC", hidden);
  assert.deepEqual(graphCanvasEmptyReason(mixed, hidden), { kind: "filtered", hiddenLinks: 2 }, "showing mentions alone would not recover the parent link");

  const mentionOnly = graphOverviewVisibility(resolve(items, [edge("mentions", "A", "B")]), range, "UTC", hidden);
  assert.deepEqual(graphCanvasEmptyReason(mentionOnly, hidden), { kind: "mentions-hidden", hiddenLinks: 1 });
});

test("graphEdgeStyle tells the relation types apart without colour", () => {
  const shape = (type: string): string => `${graphEdgeStyle(type).dash ?? "solid"} ${graphEdgeStyle(type).width}`;
  assert.equal(new Set(["closes", "blocks", "parent", "mentions"].map(shape)).size, 4, "dash pattern or weight differs for each");
  assert.equal(graphEdgeStyle("blocks").dash, null, "blocks is a heavy solid line");
  assert.ok(graphEdgeStyle("blocks").width > graphEdgeStyle("closes").width);
  assert.notEqual(graphEdgeStyle("parent").dash, null);
  assert.notEqual(graphEdgeStyle("parent").dash, graphEdgeStyle("mentions").dash);
  assert.equal(graphEdgeStyle("closes").stroke, null, "closes keeps its lifecycle colour");
  assert.equal(graphEdgeStyle("blocks").stroke, "var(--graph-blocks)");
  assert.equal(graphEdgeStyle("parent").stroke, "var(--graph-parent)");
  assert.equal(graphEdgeStyle("mentions").stroke, "var(--graph-mention)");
  assert.deepEqual(graphEdgeStyle("duplicates"), graphEdgeStyle("relates"), "an unknown type draws like any other structural edge");
});

test("programScopeEdges keeps a tracker's children, what blocks them, and what closes them", () => {
  const edges = resolve([], [
    edge("parent", "T", "A"), edge("parent", "T", "B"), edge("parent", "T", "C"),
    edge("blocks", "A", "B"), edge("blocks", "B", "C"),
    edge("blocks", "X", "C"), // a blocker outside the program still decides C's status
    edge("blocks", "B", "Y"), // what a child blocks elsewhere is not this program's
    edge("closes", "PR1", "A"), edge("closes", "PR2", "Z"), edge("closes", "PR3", "T"),
    edge("mentions", "A", "B"), edge("parent", "T2", "A"), edge("parent", "T", "T"),
  ]);
  assert.deepEqual(edgeText(programScopeEdges(edges, ref("T"))), [
    "parent T>A", "parent T>B", "parent T>C",
    "blocks A>B", "blocks B>C", "blocks X>C",
    "closes PR1>A",
  ]);
  assert.deepEqual(programScopeEdges(edges, ref("A")), [], "an item without children has no program scope");
});

function programView(items: ItemDTO[], edges: EdgeDTO[]) {
  const resolved = resolve(items, edges);
  const rollup = programRollups(new Map(items.map((it) => [it.id, it])), edges).get(ref("T"));
  assert.ok(rollup, "the fixture tracker has children");
  return graphProgramView(resolved, ref("T"), rollup);
}

test("graphProgramView draws the children, their reduced dependencies, and their change requests", () => {
  const items = [
    item("T", { title: "Tracker" }),
    item("A", { iid: 1, state: "closed" }),
    item("B", { iid: 2 }),
    item("C", { iid: 3 }),
    item("PR1", { kind: "change_request", state: "merged", iid: 11 }),
    item("PR2", { kind: "change_request", iid: 12 }),
  ];
  const view = programView(items, [
    edge("parent", "T", "C"), edge("parent", "T", "ISSUE_D"), edge("parent", "T", "B"), edge("parent", "T", "A"),
    edge("blocks", "A", "B"), edge("blocks", "B", "C"), edge("blocks", "A", "C"), edge("blocks", "C", "ISSUE_D"),
    edge("closes", "PR1", "A", "fulfilled"), edge("closes", "PR2", "B", "declared"),
    edge("mentions", "A", "T"), edge("closes", "PR2", "T", "declared"),
  ]);

  assert.deepEqual(view.graph.nodes.map((node) => short(node.id)), ["A", "B", "C", "ISSUE_D", "PR1", "PR2"], "children in program order, then what delivers them; the tracker is the header, not a node");
  assert.deepEqual(
    view.graph.nodes.map((node) => node.programStatus ?? null),
    ["done", "in_review", "blocked", "blocked", null, null],
  );
  const untracked = view.graph.nodes[3]!;
  assert.equal(untracked.untracked, true);
  assert.equal(untracked.label, "ISSUE_D", "an untracked child is named as the Board names it");
  assert.deepEqual(
    view.graph.links.map((link) => `${link.type} ${short(link.source)}>${short(link.target)}`),
    ["blocks A>B", "blocks B>C", "blocks C>ISSUE_D", "closes PR1>A", "closes PR2>B"],
    "parent edges are implied and the A>C shortcut is reduced away",
  );
  assert.deepEqual(view.graph.links.slice(3).map((link) => link.color), ["var(--fulfilled)", "var(--declared)"]);
  assert.equal(new Set(view.graph.links.map((link) => link.id)).size, view.graph.links.length);
  assert.deepEqual(view.blocks, { drawn: 3, total: 4, cyclic: false });
  assert.deepEqual([...view.attached].map(([child, crs]) => [short(child), crs.map(short)]), [["A", ["PR1"]], ["B", ["PR2"]]]);
  assert.deepEqual(view.graph.nodes.slice(4).map((node) => short(node.attachedTo ?? "")), ["A", "B"]);
});

test("graphProgramView draws every blocks edge when the children depend on each other in a cycle", () => {
  const items = [item("T"), item("A", { iid: 1 }), item("B", { iid: 2 }), item("C", { iid: 3 })];
  const view = programView(items, [
    edge("parent", "T", "A"), edge("parent", "T", "B"), edge("parent", "T", "C"),
    edge("blocks", "A", "B"), edge("blocks", "B", "A"), edge("blocks", "A", "C"), edge("blocks", "B", "C"),
  ]);
  assert.deepEqual(view.blocks, { drawn: 4, total: 4, cyclic: true });
  assert.equal(view.graph.links.length, 4);
});

test("graphProgramView keeps blockers and closers that are not change requests off the canvas", () => {
  const items = [item("T"), item("A", { iid: 1 }), item("B", { iid: 2 }), item("X", { iid: 9 })];
  const view = programView(items, [
    edge("parent", "T", "A"), edge("parent", "T", "B"),
    edge("blocks", "X", "A"), // blocked from outside the program: status only
    edge("closes", "A", "B", "declared"), // a child that closes another child is already a node
  ]);
  assert.deepEqual(view.graph.nodes.map((node) => short(node.id)), ["A", "B"]);
  assert.deepEqual(view.graph.nodes.map((node) => node.programStatus), ["blocked", "in_review"]);
  assert.deepEqual(view.graph.links.map((link) => `${link.type} ${short(link.source)}>${short(link.target)}`), ["closes A>B"]);
  assert.deepEqual(view.blocks, { drawn: 0, total: 0, cyclic: false });
  assert.equal(view.attached.size, 0);
});

test("programLayers puts each child one column after its last prerequisite, in program order", () => {
  const children = ["A", "B", "C", "D", "E", "F"];
  const items = [item("T"), ...children.map((id, index) => item(id, { iid: index + 1 })), item("PR", { kind: "change_request" })];
  const layersOf = (blocks: string) =>
    programLayers(programView(items, [
      ...children.map((id) => edge("parent", "T", id)),
      edge("parent", "T", "ISSUE_GONE"),
      ...pairs(blocks).map(([from, to]) => edge("blocks", from, to)),
      edge("closes", "PR", "A", "declared"),
    ])).map((layer) => layer.map(short).join(" "));

  assert.deepEqual(layersOf("A>B B>C D>C E>ISSUE_GONE"), ["A D E F", "B ISSUE_GONE", "C"], "a child with no prerequisite is in the first column however late it is needed");
  assert.deepEqual(layersOf("A>D B>D D>F A>F"), ["A B C E ISSUE_GONE", "D", "F"], "the diamond's shortcut does not pull F forward");
  assert.deepEqual(layersOf(""), ["A B C D E F ISSUE_GONE"], "no dependencies: one column, change requests are not in it");
  assert.deepEqual(layersOf("A>B B>A B>C"), ["B D E F ISSUE_GONE", "A C"], "a cycle is cut where it closes, so every child still gets a column");
});

test("the graph focus scope is route-backed and rides only with a focus", () => {
  assert.equal(parseHashRoute("#/graph?focus=x&scope=neighborhood").scope, "neighborhood");
  assert.equal(parseHashRoute("#/graph?focus=x").scope, null, "an old focus link opens the default view");
  assert.equal(parseHashRoute("#/graph?focus=x&scope=program").scope, null, "the default is never spelled out");
  assert.equal(parseHashRoute("#/graph?focus=x&scope=nope").scope, null);
  assert.equal(
    buildHashRoute({ page: "graph", focus: "github:github.com|42", depth: 2, scope: "neighborhood" }),
    "#/graph?focus=github%3Agithub.com%7C42&depth=2&scope=neighborhood",
  );
  assert.equal(buildHashRoute({ page: "graph", scope: "neighborhood" }), "#/graph", "no focus, no scope");
  assert.equal(buildHashRoute({ page: "graph", focus: "x", scope: "program" }), "#/graph?focus=x");
});
