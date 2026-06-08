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
  BaseEdge,
  EdgeLabelRenderer,
  useNodesState,
  useEdgesState,
  useInternalNode,
  getBezierPath,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  type InternalNode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { AggregateDTO, ItemDTO, ItemWindowDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { ItemCard } from "./ItemCard.tsx";
import { StatsBar } from "./StatsBar.tsx";
import { buildGraph, buildAdjacency, computeGraphStats, findContractScopedStats, focusSubgraph, graphWindowEdgesInRange, relatedItems, compareGraphNodes, relativeTime, type GraphNode, type GraphLink, type GraphData, type ResolvedEdge, type RelatedRef, type ColorOf, type TimeRange } from "../model.ts";

// React Flow renders each node as real HTML, so a node can be a card showing the
// repo / #iid / state — not just a label. closes edges (issue <-> PR/MR) are
// solid; opt-in mentions are dashed — de-emphasised (thin, faint) in the dense
// overview, but drawn full-strength in the focus view. Layout is computed (RF
// ships none): dagre for the hierarchy view, d3-force for the knowledge-graph view.
//
// Polish (#15): node size scales with demand (comments + reactions) so busy
// items stand out; hovering a node highlights it + its neighbours and dims the
// rest, and labels its incident edges with the edge type; mentions can be
// filtered by the mentioned item's kind to thin the dense view.
//
// Navigation (#24): a searchable side list beside the canvas focuses a node,
// and each node card carries updated / created (relative) + demand — legible
// once focused/zoomed.
//
// Side-list depth: the list cards now carry the same detail as the board card
// (author, updated/created, review/CI/merge signals, collapsed labels, source
// mark). Clicking a card enters a FOCUS view — that item plus its related items
// (the other ends of its edges). Focusing also switches the CANVAS to that
// item's FULL relationship neighbourhood (focusSubgraph, built from the raw
// edges — every edge type, no time window), so the graph mirrors the list
// instead of staying the windowed overview fit; remounting React Flow on the
// focus change reframes the camera. Related items are computed from the FULL
// edge set (model buildAdjacency), so a relation hidden by the "active since"
// window still lists, marked "off-window"; a "← all items" button returns.

const KIND_ICON: Record<string, string> = { issue: "◇", change_request: "⇄", unknown: "•" };
// Stroke for `mentions` edges. The lifecycle palette colours a mention edge with
// the muted "other" grey (#637777, model EDGE_STROKE), which is near-invisible on
// the dark canvas — a problem the dense overview hides via opacity/width but the
// sparse focus view exposes. A lighter slate lifts it off the background. (Edge
// colours are JS hexes, not CSS vars — the canvas can't read custom properties.)
const MENTION_STROKE = "#8aa0b6";
const NODE_W = 200;
// Tall enough for head + two-line title + repo + the updated/created/demand
// meta row; demand then scales the whole box (and its font) up from here.
const NODE_H = 96;
const OVERVIEW_EDGE_GAP = 56;
const FOCUS_EDGE_GAP = 132;
const OVERVIEW_COLLISION_GAP = 18;
const FOCUS_COLLISION_GAP = 36;

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

// Floating edges (adapted from the React Flow floating-edges example). The force
// layout places nodes anywhere, so fixed Top/Bottom handles make a side-by-side
// pair's line loop around the box borders. Instead each end attaches at the point
// on its node's border that faces the other node, so edges connect cleanly from
// whichever side is nearest. `nodeBorderPoint` returns that border point; the
// node Handles stay (hidden) only so React Flow can resolve a source/target.
function nodeBorderPoint(node: InternalNode, other: InternalNode): { x: number; y: number } {
  const w = (node.measured.width ?? NODE_W) / 2;
  const h = (node.measured.height ?? NODE_H) / 2;
  const x2 = node.internals.positionAbsolute.x + w;
  const y2 = node.internals.positionAbsolute.y + h;
  const x1 = other.internals.positionAbsolute.x + (other.measured.width ?? NODE_W) / 2;
  const y1 = other.internals.positionAbsolute.y + (other.measured.height ?? NODE_H) / 2;
  const xx = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx) + Math.abs(yy) || 1);
  const dx = a * xx;
  const dy = a * yy;
  return { x: w * (dx + dy) + x2, y: h * (-dx + dy) + y2 };
}

// Which side of the node the border point landed on (drives the bezier control
// handle direction). The ±1px is a rounding tolerance so a point sitting exactly
// on an edge is attributed to that side.
function borderSide(node: InternalNode, p: { x: number; y: number }): Position {
  const nx = node.internals.positionAbsolute.x;
  const ny = node.internals.positionAbsolute.y;
  const w = node.measured.width ?? NODE_W;
  const h = node.measured.height ?? NODE_H;
  if (Math.round(p.x) <= Math.round(nx) + 1) return Position.Left;
  if (Math.round(p.x) >= Math.round(nx + w) - 1) return Position.Right;
  if (Math.round(p.y) <= Math.round(ny) + 1) return Position.Top;
  return Position.Bottom;
}

function FloatingEdge({ id, source, target, markerEnd, style, label }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const sp = nodeBorderPoint(s, t);
  const tp = nodeBorderPoint(t, s);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    sourcePosition: borderSide(s, sp),
    targetX: tp.x,
    targetY: tp.y,
    targetPosition: borderSide(t, tp),
  });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div className="rf-edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const edgeTypes = { floating: FloatingEdge };

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

type LayoutDensity = "overview" | "focus";
type SimNode = SimulationNodeDatum & { id: string };
type SimLink = SimulationLinkDatum<SimNode>;

function linkEndpointId(endpoint: SimLink["source"]): string {
  return typeof endpoint === "object" ? endpoint.id : String(endpoint);
}

function nodeRadius(id: string, dimOf: (id: string) => Dim): number {
  const { w, h } = dimOf(id);
  return Math.max(w, h) / 2;
}

function readableLinkDistance(link: SimLink, dimOf: (id: string) => Dim, density: LayoutDensity): number {
  const source = linkEndpointId(link.source);
  const target = linkEndpointId(link.target);
  const gap = density === "focus" ? FOCUS_EDGE_GAP : OVERVIEW_EDGE_GAP;
  return nodeRadius(source, dimOf) + nodeRadius(target, dimOf) + gap;
}

function layoutForce(nodes: GraphNode[], links: GraphLink[], dimOf: (id: string) => Dim, density: LayoutDensity): Map<string, { x: number; y: number }> {
  const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id }));
  const simLinks: SimLink[] = links.map((l) => ({ source: l.source, target: l.target }));
  const collisionGap = density === "focus" ? FOCUS_COLLISION_GAP : OVERVIEW_COLLISION_GAP;
  const sim = forceSimulation<SimNode, SimLink>(simNodes)
    .force("charge", forceManyBody().strength(-340))
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => (d as SimNode).id)
        .distance((l) => readableLinkDistance(l, dimOf, density))
        .strength(0.4),
    )
    .force("center", forceCenter(0, 0))
    // Collision radius tracks each node's (demand-scaled) box so big nodes claim
    // more room and overlap less.
    .force("collide", forceCollide((d) => nodeRadius((d as SimNode).id, dimOf) + collisionGap))
    .stop();
  for (let i = 0; i < 320; i++) sim.tick();
  const m = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) {
    const { w, h } = dimOf(n.id);
    m.set(n.id, { x: (n.x ?? 0) - w / 2, y: (n.y ?? 0) - h / 2 });
  }
  return m;
}

// The RF canvas is keyed by the parent so a layout / filter / FOCUS change
// remounts it and re-fits; that keeps drag state simple (local, reset on the
// change) and is what reframes the camera on the new focus subgraph. In the
// overview, hover labels the incident edges; in the sparse focus view labels stay
// visible so the relationship text is readable without chasing the mouse.
function Flow({ rfNodes, rfEdges, showEdgeLabels }: { rfNodes: Node[]; rfEdges: Edge[]; showEdgeLabels: boolean }) {
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
        const labelled = showEdgeLabels || incident;
        const base: CSSProperties = rfEdges.find((x) => x.id === e.id)?.style ?? e.style ?? {};
        return {
          ...e,
          // FloatingEdge renders this label via EdgeLabelRenderer (styled by
          // .rf-edge-label), so only the text is needed here — no SVG label props.
          label: labelled ? String((e.data as { type?: string } | undefined)?.type ?? "") : undefined,
          style: { ...base, opacity: hoverId ? (incident ? 1 : 0.05) : (base.opacity ?? 1) },
        };
      }),
    [edges, hoverId, rfEdges, showEdgeLabels],
  );

  return (
    <ReactFlow
      nodes={viewNodes}
      edges={viewEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
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
  onActivate,
}: {
  item: ItemDTO | null;
  fallbackLabel: string;
  sourceKind?: string;
  accentColor?: string | null;
  relation?: { type: string; direction: "out" | "in" | "both"; offWindow: boolean };
  active?: boolean;
  // Generic click/keyboard activation handler (this card is a role="button").
  // The parent decides what activation means per card: a normal card focuses ITS
  // item; the active (already-focused) card clears focus. Hence the neutral name
  // rather than onFocus — re-clicking the active card is a "clear", not a focus.
  onActivate: () => void;
}) {
  return (
    <div
      className={`graph-list-card${active ? " active" : ""}`}
      role="button"
      tabIndex={0}
      // The active card is the currently-focused item; re-clicking it clears the
      // focus (its onActivate is wired to that), so its hint says so. Every other
      // card focuses ITS item, which needs no hint.
      title={active ? "Click to clear focus" : undefined}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {relation && (
        <div className="glc-relation muted">
          <span className="glc-rel-type">
            {relation.direction === "both" ? "↔" : relation.direction === "out" ? "→" : "←"} {relation.type}
          </span>
          {relation.offWindow && (
            <span className="glc-offwindow" title="outside the current “active since” window — shown here in focus, but absent from the overview graph until you widen it">
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

// The side list beside the canvas. A controlled component: focus state
// (focusId / onFocus / onBack) lives in the parent GraphPage, which also
// switches the canvas to the focused item's relationship neighbourhood and
// reframes it by remounting the canvas (this list no longer drives the camera
// itself). Two modes share one <aside>:
//   • list  — searchable, demand-sorted cards of the on-graph (windowed) nodes,
//             with an all/issue/pr kind toggle; click a card to focus it.
//   • focus — that item + its related items (other edge ends, from the FULL edge
//             set, off-window ones flagged). A related card re-focuses
//             (navigation chain); "← all items" returns.
function GraphSideList({
  nodes,
  itemsByRef,
  adjacency,
  windowedIds,
  sourceKind,
  colorOf,
  focusId,
  onFocus,
  onBack,
}: {
  nodes: GraphNode[];
  itemsByRef: Map<string, ItemDTO>;
  adjacency: Map<string, RelatedRef[]>;
  windowedIds: Set<string>;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  // Focus is lifted to GraphPage so the canvas can narrow to the focused item's
  // subgraph (not just pan the full graph). null = the flat list; a ref = the
  // focus view of that item. onFocus enters/chains focus; onBack returns.
  focusId: string | null;
  onFocus: (id: string) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  // Side-list kind toggle (all / issue / pr). Defaults to "issue" so the list
  // opens on the smaller, more actionable issue set rather than the PR-heavy
  // full graph. Reuses MentionTarget — same three-way issue|change_request|all
  // shape. Applies only to the flat list below, not the focus view.
  const [kindFilter, setKindFilter] = useState<MentionTarget>("issue");

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

  if (focusId !== null) {
    // Collapse the per-direction adjacency entries to one card per (ref, type)
    // — a mutual relationship (e.g. two items that mention each other) becomes a
    // single "both" entry instead of a duplicate "→" + "←" pair.
    const related = relatedItems(adjacency.get(focusId) ?? []).sort(
      (a, b) => Number(!windowedIds.has(a.ref)) - Number(!windowedIds.has(b.ref)) || a.type.localeCompare(b.type) || labelOf(a.ref).localeCompare(labelOf(b.ref)),
    );
    return (
      <aside className="graph-list">
        <button type="button" className="graph-list-back" onClick={onBack}>
          ← all items
        </button>
        <div className="graph-list-scroll">
          {/* Re-clicking the focused item clears focus (toggle off) — same exit as
              "← all items", so the card the user just clicked is also the way back. */}
          <GraphListCard item={itemsByRef.get(focusId) ?? null} fallbackLabel={labelOf(focusId)} sourceKind={kindOf(focusId)} accentColor={colorFor(focusId)} active onActivate={onBack} />
          {!windowedIds.has(focusId) && (
            <p className="muted glc-note">This item is outside the current “active since” window — it's shown here in focus, but won't appear in the overview graph until you widen the window.</p>
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
                onActivate={() => onFocus(r.ref)}
              />
            ))
          )}
        </div>
      </aside>
    );
  }

  const filtered = (() => {
    const needle = q.trim().toLowerCase();
    let match = needle
      ? nodes.filter((n) => {
          const it = itemsByRef.get(n.id);
          return `${n.label} ${n.repo ?? ""} ${n.iid != null ? "#" + n.iid : ""} ${it?.author ?? ""}`.toLowerCase().includes(needle);
        })
      : nodes.slice();
    // Kind toggle: "all" keeps everything (incl. untracked "unknown" nodes);
    // "issue" / "change_request" narrow to that kind.
    if (kindFilter !== "all") match = match.filter((n) => n.kind === kindFilter);
    // #32: order by actionable state then newest-created (not demand).
    return match.sort(compareGraphNodes);
  })();

  return (
    <aside className="graph-list">
      <div className="graph-list-kinds toggle-group">
        {([
          ["all", "all"],
          ["issue", "issue"],
          ["change_request", "pr"],
        ] as Array<[MentionTarget, string]>).map(([val, lab]) => (
          <button key={val} type="button" className={`toggle${kindFilter === val ? " toggle-on" : ""}`} onClick={() => setKindFilter(val)}>
            {lab}
          </button>
        ))}
      </div>
      <input className="graph-list-search" type="search" placeholder="filter items…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="graph-list-scroll">
        {filtered.length === 0 ? (
          <p className="muted empty-list">no items match</p>
        ) : (
          filtered.map((n) => (
            <GraphListCard key={n.id} item={itemsByRef.get(n.id) ?? null} fallbackLabel={n.label} sourceKind={kindOf(n.id)} accentColor={colorFor(n.id)} onActivate={() => onFocus(n.id)} />
          ))
        )}
      </div>
    </aside>
  );
}

export function GraphPage({
  edges,
  sourceKind,
  colorOf,
  focusRef,
  narrowed,
  aggregates = [],
  itemWindow,
  range,
}: {
  edges: ResolvedEdge[];
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  focusRef?: string | null;
  narrowed?: boolean;
  aggregates?: readonly AggregateDTO[];
  itemWindow?: ItemWindowDTO;
  range: TimeRange;
}) {
  const [layout, setLayout] = useState<"force" | "hierarchy">("force");
  const [showMentions, setShowMentions] = useState(() => !!focusRef);
  const [mentionTarget, setMentionTarget] = useState<MentionTarget>("all");
  // Focused item ref (seeded from a "?focus=" deep-link). Drives BOTH the side
  // list's focus view and the canvas subgraph below; null = the flat list +
  // full graph.
  const [focusId, setFocusId] = useState<string | null>(focusRef ?? null);

  const graphInputEdges = useMemo(() => {
    let visible = showMentions ? edges : edges.filter((re) => re.edge.type !== "mentions");
    // Mention-direction filter: keep mentions only when the mentioned (target)
    // item is the chosen kind. Non-mention edges are unaffected; an untracked
    // target (no kind) is shown only under "all".
    if (showMentions && mentionTarget !== "all") {
      visible = visible.filter((re) => re.edge.type !== "mentions" || re.to?.kind === mentionTarget);
    }
    return visible;
  }, [edges, showMentions, mentionTarget]);

  const graphEdges = useMemo(() => graphWindowEdgesInRange(graphInputEdges, range), [graphInputEdges, range]);
  const graph = useMemo(() => buildGraph(graphEdges), [graphEdges]);

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

  // Drop focus whenever the windowed graph itself rebuilds (the "active since" /
  // mention filters changed). The focus view is tied to the current graph, so a
  // stale focus on an item that just left the window would be confusing. Compared
  // by VALUE against the previous windowedIds (a stable memo ref until the graph
  // rebuilds) rather than a first-run flag, so it is idempotent under React 18
  // StrictMode's double-invoked effects and never wipes the deep-link seed on mount.
  const prevWindowed = useRef(windowedIds);
  useEffect(() => {
    if (prevWindowed.current !== windowedIds) {
      prevWindowed.current = windowedIds;
      setFocusId(null);
    }
  }, [windowedIds]);

  // When an item is focused, the canvas shows that item's FULL relationship
  // neighbourhood (focusSubgraph, built from the raw edges — all edge types, no
  // overview range filter) instead of the windowed overview graph, so every relationship
  // the side list lists is drawn (incl. mentions, regardless of the toggle).
  // Falls back to the full graph if the focus has no edges (nothing to render).
  const view = useMemo<GraphData>(() => {
    if (!focusId) return graph;
    const sub = focusSubgraph(edges, focusId);
    return sub.nodes.length ? sub : graph;
  }, [edges, focusId, graph]);
  // True when the canvas is showing a focus subgraph (not the full overview). In
  // focus there is no clutter to fight, so edges — mentions especially — are
  // drawn at full strength rather than the overview's de-emphasised styling.
  const inFocus = view !== graph;
  const contractGraphStats = useMemo(
    () =>
      !inFocus && !showMentions && mentionTarget === "all"
        ? findContractScopedStats(aggregates, { scope: "graphWindow", since: range.from, edgeFilter: "no_mentions" })
        : null,
    [aggregates, range.from, inFocus, showMentions, mentionTarget],
  );
  const scopedStats = useMemo(
    () => contractGraphStats ?? computeGraphStats(view, inFocus ? "focus" : "graphWindow"),
    [contractGraphStats, view, inFocus],
  );

  const dimOf = useMemo(() => {
    const m = new Map<string, Dim>();
    for (const n of view.nodes) m.set(n.id, dims(n.demand));
    return (id: string): Dim => m.get(id) ?? { w: NODE_W, h: NODE_H, scale: 1 };
  }, [view]);

  const positions = useMemo(() => {
    if (layout === "hierarchy") return layoutDagre(view.nodes, view.links, dimOf);
    return layoutForce(view.nodes, view.links, dimOf, inFocus ? "focus" : "overview");
  }, [view, layout, dimOf, inFocus]);

  const rfNodes: Node[] = useMemo(
    () =>
      view.nodes.map((n) => {
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
    [view, positions, dimOf, itemsByRef, colorOf],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      view.links.map((l) => {
        const isMention = l.type === "mentions";
        // Mentions stay dashed (their visual signature) and keep the lighter
        // slate stroke. In the OVERVIEW they're thin + faint to recede behind
        // closes; in FOCUS they go full opacity + slightly thicker so the one
        // relationship you drilled into is actually visible. Non-mention edges
        // (closes / relates) are already solid + full strength.
        const stroke = isMention ? MENTION_STROKE : l.color;
        return {
          id: l.id,
          type: "floating",
          source: l.source,
          target: l.target,
          data: { type: l.type },
          style: {
            stroke,
            strokeWidth: isMention ? (inFocus ? 1.75 : 1) : 1.5,
            strokeDasharray: isMention ? "4 3" : undefined,
            opacity: isMention ? (inFocus ? 1 : 0.55) : 1,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
        };
      }),
    [view, inFocus],
  );

  // focusId is in the key so each focus change remounts <Flow>, which re-runs its
  // `fitView` to frame the new subgraph — that is what makes clicking a related
  // item visibly switch the canvas to that item (the old design only panned the
  // full graph, so a neighbour barely moved the camera).
  const flowKey = `${layout}|${showMentions}|${mentionTarget}|${range.from}|${range.to}|${focusId ?? ""}|${view.nodes.length}`;

  return (
    <section className="graph-page">
      <div className="graph-controls">
        <span className="muted">
          showing {view.nodes.length} nodes · {view.links.length} links
          {focusId ? " · focused" : ""}
          {itemWindow?.truncated && !focusId ? ` · range ${range.from} to ${range.to}` : ""}
        </span>
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
      <StatsBar scoped={scopedStats} totalLabel="nodes" edgeLabel="links" />
      {graph.links.length === 0 ? (
        <p className="empty">No relationships in this range.</p>
      ) : (
        // One shared ReactFlowProvider wraps the side list + canvas; remounting
        // <Flow> on a focus change (flowKey) is what reframes the camera now.
        <ReactFlowProvider>
          <div className="graph-body">
            <GraphSideList
              nodes={graph.nodes}
              itemsByRef={itemsByRef}
              adjacency={adjacency}
              windowedIds={windowedIds}
              sourceKind={sourceKind}
              colorOf={colorOf}
              focusId={focusId}
              onFocus={setFocusId}
              onBack={() => setFocusId(null)}
            />
            <div className="graph-canvas">
              <Flow key={flowKey} rfNodes={rfNodes} rfEdges={rfEdges} showEdgeLabels={inFocus} />
            </div>
          </div>
        </ReactFlowProvider>
      )}
    </section>
  );
}
