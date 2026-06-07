import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { ItemCard } from "./ItemCard.tsx";
import { buildGraph, buildAdjacency, relatedItems, compareGraphNodes, cutoffIso, relativeTime, type GraphNode, type GraphLink, type ResolvedEdge, type RelatedRef, type ColorOf } from "../model.ts";

// React Flow renders each node as real HTML, so a node can be a card showing the
// repo / #iid / state — not just a label. closes edges (issue <-> PR/MR) are
// solid; opt-in mentions are thin dashed. Layout is computed (RF ships none):
// dagre for the hierarchy view, d3-force for the knowledge-graph view.
//
// Polish (#15): node size scales with demand (comments + reactions) so busy
// items stand out; hovering a node highlights it + its neighbours and dims the
// rest, and labels its incident edges with the edge type; mentions can be
// filtered by the mentioned item's kind to thin the dense view.
//
// Navigation (#24): a searchable side list beside the canvas jumps to a node
// (pan + zoom via React Flow fitView; the default view stays the full-graph
// fit), and each node card carries updated / created (relative) + demand —
// legible once focused/zoomed.
//
// Side-list depth: the list cards now carry the same detail as the board card
// (author, updated/created, review/CI/merge signals, collapsed labels, source
// mark). Clicking a card enters a FOCUS view — that item plus its related items
// (the other ends of its edges), with the camera fit to it + its on-graph
// neighbours. Related items are computed from the FULL edge set (model
// buildAdjacency), so a relation hidden by the "active since" window still
// lists, marked "off-window"; a "← all items" button returns to the list.

const KIND_ICON: Record<string, string> = { issue: "◇", change_request: "⇄", unknown: "•" };
const NODE_W = 200;
// Tall enough for head + two-line title + repo + the updated/created/demand
// meta row; demand then scales the whole box (and its font) up from here.
const NODE_H = 96;

// Node box + font scale from demand (comments + reactions). Log-damped so a few
// very busy items don't dwarf the rest; capped at ~1.9x.
function dims(demand: number | null): { w: number; h: number; scale: number } {
  const d = Math.max(0, demand ?? 0);
  const scale = 1 + Math.min(0.9, Math.log2(1 + d) / 8);
  return { w: Math.round(NODE_W * scale), h: Math.round(NODE_H * scale), scale };
}

const NODE_LEGEND = [
  { c: "#addb67", t: "open" },
  { c: "#c792ea", t: "closed" },
  { c: "#7e57c2", t: "merged" },
  { c: "#637777", t: "untracked" },
];

// What the mention-direction filter keeps: all mentions, or only those whose
// MENTIONED (target) item is an issue / a change request.
type MentionTarget = "all" | "issue" | "change_request";

// Engagement marker (comments + reactions) — the same stroked speech-bubble as
// the board card, sized in `em` so it scales with the surrounding font.
function DemandIcon() {
  return (
    <svg
      className="icon-demand"
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ItemNode({ data }: NodeProps) {
  const d = data as unknown as GraphNode;
  const { scale } = dims(d.demand);
  return (
    <div
      className={`rf-node${d.untracked ? " rf-node-untracked" : ""}`}
      // The left border already encodes STATE (d.color), so a highlighted repo
      // shows as an outer ring (outline) instead — a literal "frame" that does
      // not collide with the state edge. The board card uses a left bar; here the
      // left edge is taken, hence the ring.
      style={{
        borderLeftColor: d.color,
        fontSize: `${(11 * scale).toFixed(1)}px`,
        ...(d.accentColor ? { outline: `2px solid ${d.accentColor}`, outlineOffset: "1px" } : {}),
      }}
      title={d.demand != null ? `${d.label} · ${d.demand} comments + reactions` : d.label}
    >
      <Handle type="target" position={Position.Top} className="rf-handle" />
      <div className="rf-node-head">
        <span className="kind">{KIND_ICON[d.kind] ?? "•"}</span>
        <Badge text={d.state} kind={d.state} />
      </div>
      <div className="rf-node-title">{d.label}</div>
      <div className="rf-node-repo muted">
        {d.repo ?? "untracked"}
        {d.iid != null ? ` #${d.iid}` : ""}
      </div>
      {!d.untracked && (d.created_at || d.updated_at || d.demand != null) && (
        <div className="rf-node-meta muted">
          {d.updated_at ? <span title={d.updated_at}>updated {relativeTime(d.updated_at)}</span> : null}
          {d.created_at ? <span title={d.created_at}>created {relativeTime(d.created_at)}</span> : null}
          {d.demand != null ? (
            <span className="rf-demand" title="comments + reactions">
              <DemandIcon /> {d.demand}
            </span>
          ) : null}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="rf-handle" />
    </div>
  );
}

const nodeTypes = { item: ItemNode };

// Open an issue/PR in a new tab (a real anchor click — guaranteed a tab, never a
// same-page navigation or a popup window, and carries noopener/noreferrer).
function openExternal(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
}

type Dim = { w: number; h: number; scale: number };

function layoutDagre(nodes: GraphNode[], links: GraphLink[], dimOf: (id: string) => Dim): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 30, ranksep: 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const { w, h } = dimOf(n.id);
    g.setNode(n.id, { width: w, height: h });
  }
  for (const l of links) if (g.hasNode(l.source) && g.hasNode(l.target)) g.setEdge(l.source, l.target);
  dagre.layout(g);
  const m = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    const { w, h } = dimOf(n.id);
    m.set(n.id, { x: (p?.x ?? 0) - w / 2, y: (p?.y ?? 0) - h / 2 });
  }
  return m;
}

type SimNode = SimulationNodeDatum & { id: string };
function layoutForce(nodes: GraphNode[], links: GraphLink[], dimOf: (id: string) => Dim): Map<string, { x: number; y: number }> {
  const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id }));
  const simLinks = links.map((l) => ({ source: l.source, target: l.target }));
  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-340))
    .force(
      "link",
      forceLink(simLinks)
        .id((d) => (d as SimNode).id)
        .distance(110)
        .strength(0.4),
    )
    .force("center", forceCenter(0, 0))
    // Collision radius tracks each node's (demand-scaled) box so big nodes claim
    // more room and overlap less.
    .force("collide", forceCollide((d) => { const { w, h } = dimOf((d as SimNode).id); return Math.max(w, h) / 2 + 14; }))
    .stop();
  for (let i = 0; i < 320; i++) sim.tick();
  const m = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) {
    const { w, h } = dimOf(n.id);
    m.set(n.id, { x: (n.x ?? 0) - w / 2, y: (n.y ?? 0) - h / 2 });
  }
  return m;
}

// The RF canvas is keyed by the parent so a layout/filter change remounts it and
// re-fits; that keeps drag state simple (local, reset on filter change). Hover a
// node to highlight it + its neighbours (everything else dims) and label its
// incident edges with the edge type.
function Flow({ rfNodes, rfEdges }: { rfNodes: Node[]; rfEdges: Edge[] }) {
  const [nodes, , onNodesChange] = useNodesState(rfNodes);
  const [edges, , onEdgesChange] = useEdgesState(rfEdges);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Neighbour set of the hovered node (itself + every node one edge away).
  const neighbours = useMemo(() => {
    if (!hoverId) return null;
    const s = new Set<string>([hoverId]);
    for (const e of rfEdges) {
      if (e.source === hoverId) s.add(e.target);
      if (e.target === hoverId) s.add(e.source);
    }
    return s;
  }, [hoverId, rfEdges]);

  const viewNodes = useMemo(
    () => nodes.map((n) => ({ ...n, style: { ...n.style, opacity: neighbours ? (neighbours.has(n.id) ? 1 : 0.12) : 1 } })),
    [nodes, neighbours],
  );

  const viewEdges = useMemo(
    () =>
      edges.map((e) => {
        const incident = !!hoverId && (e.source === hoverId || e.target === hoverId);
        const base: CSSProperties = rfEdges.find((x) => x.id === e.id)?.style ?? e.style ?? {};
        return {
          ...e,
          label: incident ? String((e.data as { type?: string } | undefined)?.type ?? "") : undefined,
          labelBgPadding: [4, 2] as [number, number],
          labelStyle: incident ? { fill: "#d6deeb", fontSize: 10 } : undefined,
          labelBgStyle: incident ? { fill: "#0b2942", fillOpacity: 0.92 } : undefined,
          style: { ...base, opacity: hoverId ? (incident ? 1 : 0.05) : (base.opacity ?? 1) },
        };
      }),
    [edges, hoverId, rfEdges],
  );

  return (
    <ReactFlow
      nodes={viewNodes}
      edges={viewEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      onNodeMouseEnter={(_, node) => setHoverId(node.id)}
      onNodeMouseLeave={() => setHoverId(null)}
      onNodeClick={(_, node) => {
        const url = (node.data as unknown as GraphNode).url;
        if (url) openExternal(url);
      }}
      colorMode="dark"
      fitView
      minZoom={0.05}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#1d3b53" gap={22} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => (n.data as unknown as GraphNode).color} />
    </ReactFlow>
  );
}

// One side-list card. To stay visually identical to the board it renders the SAME
// board <ItemCard>, wrapped so the whole card is the focus target. The focus view
// adds a relation tag above it (how this item relates to the focused one, and
// whether it sits off the current time window). The card body click focuses the
// node; the card title is ItemCard's external link, which stops propagation so it
// opens the issue without also focusing. An untracked endpoint (a cross-repo ref
// with no resolved item) renders a board-card shell with just its ref label.
function GraphListCard({
  item,
  fallbackLabel,
  sourceKind,
  accentColor,
  relation,
  active,
  onFocus,
}: {
  item: ItemDTO | null;
  fallbackLabel: string;
  sourceKind?: string;
  accentColor?: string | null;
  relation?: { type: string; direction: "out" | "in" | "both"; offWindow: boolean };
  active?: boolean;
  onFocus: () => void;
}) {
  return (
    <div
      className={`graph-list-card${active ? " active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus();
        }
      }}
    >
      {relation && (
        <div className="glc-relation muted">
          <span className="glc-rel-type">
            {relation.direction === "both" ? "↔" : relation.direction === "out" ? "→" : "←"} {relation.type}
          </span>
          {relation.offWindow && (
            <span className="glc-offwindow" title="outside the current “active since” window — widen it to show this node on the graph">
              off-window
            </span>
          )}
        </div>
      )}
      {item ? (
        <ItemCard item={item} sourceKind={sourceKind} accentColor={accentColor} />
      ) : (
        <article className="card card-untracked">
          <div className="card-head">
            <span className="kind">•</span>
            <span className="card-title">{fallbackLabel}</span>
          </div>
          <div className="card-meta muted">untracked</div>
        </article>
      )}
    </div>
  );
}

// The side list beside the canvas. Two modes share one <aside>:
//   • list  — searchable, demand-sorted cards of the on-graph (windowed) nodes;
//             click a card to focus it.
//   • focus — that item + its related items (other edge ends, from the FULL edge
//             set, off-window ones flagged); camera fits the item + its on-graph
//             neighbours. A related card re-focuses (navigation chain); "← all
//             items" returns. It drives the camera via React Flow's fitView, so
//             it renders INSIDE the <ReactFlowProvider> shared with the canvas.
function GraphSideList({
  nodes,
  itemsByRef,
  adjacency,
  windowedIds,
  sourceKind,
  colorOf,
  focusRef,
}: {
  nodes: GraphNode[];
  itemsByRef: Map<string, ItemDTO>;
  adjacency: Map<string, RelatedRef[]>;
  windowedIds: Set<string>;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  // Item ref to focus on entry (a "?focus=" deep-link from a board card). Seeds
  // the focus view and frames the camera once the canvas has measured its nodes.
  focusRef?: string | null;
}) {
  const rf = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const [q, setQ] = useState("");
  // Seed from the deep-link target so arriving at "#/graph?focus=<ref>" opens
  // straight into that item's focus view.
  const [focusId, setFocusId] = useState<string | null>(focusRef ?? null);

  // Drop focus whenever the windowed graph itself changes (the "active since" /
  // mention filters rebuild it). The focus view is tied to the current canvas, so
  // returning to the list avoids a stale focus on an item that just left it. Keyed
  // on windowedIds — NOT "focusId went off-window" — so chaining to an off-window
  // related item (an intentional focus) is preserved. Compared by VALUE against the
  // previous windowedIds (windowedIds is a stable memo ref until the graph rebuilds)
  // rather than a first-run flag, so it stays idempotent under React 18 StrictMode's
  // double-invoked effects and never wipes the initial deep-link seed on mount.
  const prevWindowed = useRef(windowedIds);
  useEffect(() => {
    if (prevWindowed.current !== windowedIds) {
      prevWindowed.current = windowedIds;
      setFocusId(null);
    }
  }, [windowedIds]);

  // Frame the deep-link focus once React Flow has measured its nodes — calling
  // fitView before measurement fits against zero-size nodes and no-ops. The
  // framedRef one-shot keeps it to a single frame (and is StrictMode-safe: the
  // second invoke sees the flag set and skips). focusCamera is read from the
  // closure on purpose — keying the effect on its identity would refit each render;
  // a manual card click drives the camera through focus() instead.
  const framedRef = useRef(false);
  useEffect(() => {
    if (focusRef && nodesInitialized && !framedRef.current) {
      framedRef.current = true;
      focusCamera(focusRef);
    }
  }, [focusRef, nodesInitialized]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const labelOf = (ref: string): string => nodeById.get(ref)?.label ?? itemsByRef.get(ref)?.title ?? ref.split("|").pop() ?? ref;
  const kindOf = (ref: string): string | undefined => {
    const it = itemsByRef.get(ref);
    return it ? sourceKind.get(it.source_id) : undefined;
  };
  const colorFor = (ref: string): string | null => {
    const it = itemsByRef.get(ref);
    return it ? colorOf(it.source_id, it.project_path) : null;
  };

  // Fit the camera to the focused node + its neighbours that are actually on the
  // graph (off-window related items have no node to frame). No-op if none are.
  function focusCamera(id: string) {
    const onGraph = [id, ...(adjacency.get(id) ?? []).map((r) => r.ref)].filter((r) => windowedIds.has(r));
    if (onGraph.length) rf.fitView({ nodes: onGraph.map((i) => ({ id: i })), padding: 0.4, minZoom: 0.35, maxZoom: 1.4, duration: 600 });
  }
  function focus(id: string) {
    setFocusId(id);
    focusCamera(id);
  }
  function back() {
    setFocusId(null);
    rf.fitView({ padding: 0.1, duration: 500 });
  }

  if (focusId !== null) {
    // Collapse the per-direction adjacency entries to one card per (ref, type)
    // — a mutual relationship (e.g. two items that mention each other) becomes a
    // single "both" entry instead of a duplicate "→" + "←" pair.
    const related = relatedItems(adjacency.get(focusId) ?? []).sort(
      (a, b) => Number(!windowedIds.has(a.ref)) - Number(!windowedIds.has(b.ref)) || a.type.localeCompare(b.type) || labelOf(a.ref).localeCompare(labelOf(b.ref)),
    );
    return (
      <aside className="graph-list">
        <button type="button" className="graph-list-back" onClick={back}>
          ← all items
        </button>
        <div className="graph-list-scroll">
          <GraphListCard item={itemsByRef.get(focusId) ?? null} fallbackLabel={labelOf(focusId)} sourceKind={kindOf(focusId)} accentColor={colorFor(focusId)} active onFocus={() => focusCamera(focusId)} />
          {!windowedIds.has(focusId) && (
            <p className="muted glc-note">This item is outside the current “active since” window — widen it to see it on the graph.</p>
          )}
          <div className="graph-related-head muted">
            {related.length} related {related.length === 1 ? "item" : "items"}
          </div>
          {related.length === 0 ? (
            <p className="muted empty-list">no related items</p>
          ) : (
            related.map((r) => (
              <GraphListCard
                key={`${r.ref}|${r.type}`}
                item={itemsByRef.get(r.ref) ?? null}
                fallbackLabel={labelOf(r.ref)}
                sourceKind={kindOf(r.ref)}
                accentColor={colorFor(r.ref)}
                relation={{ type: r.type, direction: r.direction, offWindow: !windowedIds.has(r.ref) }}
                onFocus={() => focus(r.ref)}
              />
            ))
          )}
        </div>
      </aside>
    );
  }

  const filtered = (() => {
    const needle = q.trim().toLowerCase();
    const match = needle
      ? nodes.filter((n) => {
          const it = itemsByRef.get(n.id);
          return `${n.label} ${n.repo ?? ""} ${n.iid != null ? "#" + n.iid : ""} ${it?.author ?? ""}`.toLowerCase().includes(needle);
        })
      : nodes.slice();
    // #32: order by actionable state then newest-created (not demand).
    return match.sort(compareGraphNodes);
  })();

  return (
    <aside className="graph-list">
      <input className="graph-list-search" type="search" placeholder="filter items…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="graph-list-scroll">
        {filtered.length === 0 ? (
          <p className="muted empty-list">no items match</p>
        ) : (
          filtered.map((n) => (
            <GraphListCard key={n.id} item={itemsByRef.get(n.id) ?? null} fallbackLabel={n.label} sourceKind={kindOf(n.id)} accentColor={colorFor(n.id)} onFocus={() => focus(n.id)} />
          ))
        )}
      </div>
    </aside>
  );
}

export function GraphPage({ edges, sourceKind, colorOf, focusRef }: { edges: ResolvedEdge[]; sourceKind: Map<string, string>; colorOf: ColorOf; focusRef?: string | null }) {
  // A deep-link focus (a board card → "#/graph?focus=<ref>") relaxes both edge
  // filters on entry so the target is GUARANTEED on the graph and framable: it
  // clears the time window (an older item would land off the default 90-day
  // window) AND turns mentions on (an item whose only relationships are mentions
  // would otherwise have no node, since mentions are off by default). Together
  // any item with at least one edge — exactly the items that show the link — is
  // on the canvas. Absent a focus, keep the 90-day, no-mentions defaults. App
  // keys the page on the focus target, so each entry re-runs these initializers.
  const [since, setSince] = useState<string>(() => (focusRef ? "" : cutoffIso(90).slice(0, 10)));
  const [layout, setLayout] = useState<"force" | "hierarchy">("force");
  const [showMentions, setShowMentions] = useState(() => !!focusRef);
  const [mentionTarget, setMentionTarget] = useState<MentionTarget>("all");

  const graph = useMemo(() => {
    const cutoff = since ? new Date(since + "T00:00:00Z").toISOString() : null;
    let visible = showMentions ? edges : edges.filter((re) => re.edge.type !== "mentions");
    // Mention-direction filter: keep mentions only when the mentioned (target)
    // item is the chosen kind. Non-mention edges are unaffected; an untracked
    // target (no kind) is shown only under "all".
    if (showMentions && mentionTarget !== "all") {
      visible = visible.filter((re) => re.edge.type !== "mentions" || re.to?.kind === mentionTarget);
    }
    return buildGraph(visible, cutoff);
  }, [edges, since, showMentions, mentionTarget]);

  // Side-list derivations over the FULL edge set (not the time-windowed graph):
  // every resolvable item (so the focus view can surface relations the window
  // hides), the adjacency map, and the set of refs currently on the graph.
  const itemsByRef = useMemo(() => {
    const m = new Map<string, ItemDTO>();
    for (const re of edges) {
      if (re.from) m.set(re.edge.from, re.from);
      if (re.to) m.set(re.edge.to, re.to);
    }
    return m;
  }, [edges]);
  const adjacency = useMemo(() => buildAdjacency(edges), [edges]);
  const windowedIds = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);

  const dimOf = useMemo(() => {
    const m = new Map<string, Dim>();
    for (const n of graph.nodes) m.set(n.id, dims(n.demand));
    return (id: string): Dim => m.get(id) ?? { w: NODE_W, h: NODE_H, scale: 1 };
  }, [graph]);

  const positions = useMemo(
    () => (layout === "hierarchy" ? layoutDagre(graph.nodes, graph.links, dimOf) : layoutForce(graph.nodes, graph.links, dimOf)),
    [graph, layout, dimOf],
  );

  const rfNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => {
        const { w, h } = dimOf(n.id);
        const it = itemsByRef.get(n.id);
        const accentColor = it ? colorOf(it.source_id, it.project_path) : null;
        return {
          id: n.id,
          type: "item",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          style: { width: w, height: h },
          data: { ...n, accentColor } as unknown as Record<string, unknown>,
        };
      }),
    [graph, positions, dimOf, itemsByRef, colorOf],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      graph.links.map((l) => ({
        id: l.id,
        source: l.source,
        target: l.target,
        data: { type: l.type },
        style: {
          stroke: l.color,
          strokeWidth: l.type === "mentions" ? 1 : 1.5,
          strokeDasharray: l.type === "mentions" ? "4 3" : undefined,
          opacity: l.type === "mentions" ? 0.55 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: l.color, width: 14, height: 14 },
      })),
    [graph],
  );

  const flowKey = `${layout}|${showMentions}|${mentionTarget}|${since}|${graph.nodes.length}`;

  return (
    <section className="graph-page">
      <div className="graph-controls">
        <span className="muted">
          showing {graph.nodes.length} items · {graph.links.length} links
        </span>
        <label className="graph-since">
          active since <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <div className="toggle-group">
          <span className="toggle-label">layout</span>
          <button type="button" className={`toggle${layout === "force" ? " toggle-on" : ""}`} onClick={() => setLayout("force")}>
            Force
          </button>
          <button type="button" className={`toggle${layout === "hierarchy" ? " toggle-on" : ""}`} onClick={() => setLayout("hierarchy")}>
            Hierarchy
          </button>
        </div>
        <div className="toggle-group">
          <span className="toggle-label">edges</span>
          <button type="button" className={`toggle${showMentions ? " toggle-on" : ""}`} onClick={() => setShowMentions((v) => !v)}>
            + mentions
          </button>
        </div>
        {showMentions && (
          <div className="toggle-group">
            <span className="toggle-label">mentions of</span>
            {([
              ["all", "all"],
              ["issue", "issues"],
              ["change_request", "PRs"],
            ] as Array<[MentionTarget, string]>).map(([val, lab]) => (
              <button
                key={val}
                type="button"
                className={`toggle${mentionTarget === val ? " toggle-on" : ""}`}
                onClick={() => setMentionTarget(val)}
              >
                {lab}
              </button>
            ))}
          </div>
        )}
        <div className="graph-legend">
          {NODE_LEGEND.map((x) => (
            <span key={x.t}>
              <span className="dot" style={{ background: x.c }} />
              {x.t}
            </span>
          ))}
          <span className="muted">· solid = closes · dashed = mentions · size = demand · hover to focus · list → jump</span>
        </div>
      </div>
      {graph.links.length === 0 ? (
        <p className="empty">No relationships in this window — widen the “active since” date.</p>
      ) : (
        // One shared ReactFlowProvider so the side list can drive the canvas
        // camera (fitView) even though it renders outside <ReactFlow>.
        <ReactFlowProvider>
          <div className="graph-body">
            <GraphSideList nodes={graph.nodes} itemsByRef={itemsByRef} adjacency={adjacency} windowedIds={windowedIds} sourceKind={sourceKind} colorOf={colorOf} focusRef={focusRef} />
            <div className="graph-canvas">
              <Flow key={flowKey} rfNodes={rfNodes} rfEdges={rfEdges} />
            </div>
          </div>
        </ReactFlowProvider>
      )}
    </section>
  );
}
