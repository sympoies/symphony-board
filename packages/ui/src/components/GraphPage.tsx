import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { ItemMetricStrip } from "./ItemMetricStrip.tsx";
import { ItemKindIcon } from "./ItemKindIcon.tsx";
import { StatsBar } from "./StatsBar.tsx";
import { itemMetricEntries } from "../item-metrics.ts";
import { MOBILE_VIEWPORT_QUERY, buildGraph, buildAdjacency, computeGraphStats, findContractScopedStats, focusSubgraph, graphOverviewVisibility, graphCanvasEmptyReason, relatedItems, relationCountOf, compareGraphNodes, relativeTime, pluralize, type GraphCanvasEmptyReason, type GraphMentionTarget, type GraphNode, type GraphLink, type GraphData, type ResolvedEdge, type RelatedRef, type RelationCount, type ColorOf, type TimeRange } from "../model.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { useContentPaneHeight } from "../useContentPaneHeight.ts";
import type { ResolvedViewTheme } from "../viewconfig.ts";
import type { GraphView } from "../nav.ts";

// React Flow renders each node as real HTML, so a node can be a card showing the
// repo / #iid / state — not just a label. closes edges (issue <-> PR/MR) are
// solid; opt-in mentions are dashed — de-emphasised (thin, faint) in the dense
// overview, but drawn full-strength in the focus view. Layout is computed (RF
// ships none): dagre for the hierarchy view, d3-force for the knowledge-graph view.
//
// Node size scales with demand (comments + reactions) so busy items stand out;
// hovering a node highlights it + its neighbours and dims the rest, and labels
// its incident edges with the edge type; mentions can be filtered by the
// mentioned item's kind to thin the dense view.
//
// A searchable side list beside the canvas focuses a node, and each node card
// carries updated / created (relative) + demand — legible once focused/zoomed.
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
// window still lists, marked "off-window"; overview candidates hidden only from
// the canvas carry "not drawn". A "← all items" button returns.

// Stroke for `mentions` edges. The lifecycle palette colours a mention edge with
// the muted "other" grey, which is near-invisible on the dark canvas — a problem
// the dense overview hides via opacity/width but the sparse focus view exposes.
// A lighter slate lifts it off the background. CSS vars keep it theme-aware.
const MENTION_STROKE = "var(--graph-mention)";
const NODE_W = 200;
// Tall enough for head + two-line title + repo + the counts row (@author 💬 🔗)
// + the updated/created times row — the two meta rows mirror the board card and
// keep the line count deterministic; demand then scales the whole box (and its
// font) up from here.
const NODE_H = 124;
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
  { c: "var(--open)", t: "open" },
  { c: "var(--closed)", t: "closed" },
  { c: "var(--merged)", t: "merged" },
  { c: "var(--muted)", t: "untracked" },
];

type GraphListVisibility = "off-window" | "not-drawn";
type ItemNodeData = GraphNode & { item?: ItemDTO | null };

// Tooltip for a node's relation count: the per-type breakdown, plus an explicit
// callout when the CURRENT view draws fewer neighbours than the item has (the
// overview is time-windowed and mention-filtered; the count is not) — the cue
// that focusing the node reveals more than the visible lines suggest.
function relatedTitle(d: GraphNode): string {
  const rel = d.related!;
  const parts = rel.byType.map((t) => `${t.type} ${t.count}`).join(" · ");
  const drawn = d.relatedDrawn ?? 0;
  return drawn < rel.total ? `${parts} — ${drawn} of ${rel.total} drawn in this view (time window / mention filters); focus the node to see all` : parts;
}

function ItemNode({ data }: NodeProps) {
  const d = data as unknown as ItemNodeData;
  const { scale } = dims(d.demand);
  const metricCount = d.item ? itemMetricEntries(d.item, d.related).length : 0;
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
        <ItemKindIcon kind={d.kind} className="rf-node-kind-icon" />
        <Badge text={d.state} kind={d.state} />
      </div>
      {/* The title is a real anchor to the provider page when the item has a
          URL — visible link affordance, cmd/middle-click, hover URL preview.
          `nodrag` keeps the anchor from starting a node drag; stopPropagation
          keeps the node-body click (which FOCUSES the node) from also firing.
          Untracked nodes have no URL and keep the plain text title. */}
      {d.url ? (
        <a className="rf-node-title nodrag" href={d.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {d.label}
        </a>
      ) : (
        <div className="rf-node-title">{d.label}</div>
      )}
      <div className="rf-node-repo">
        <span className={d.repo ? "card-repo" : "muted"}>{d.repo ?? "untracked"}</span>
        {d.iid != null ? <span className="card-iid"> #{d.iid}</span> : null}
      </div>
      {/* Two fixed rows mirroring the board/side-list card: the counts row
          (@author + shared item metrics) then the times row (updated · created).
          Deterministic line count -- the old single mixed row wrapped
          unpredictably and could overflow the fixed-height node box. */}
      {!d.untracked && (d.author || metricCount > 0) && (
        <div className="rf-node-meta muted">
          {d.author ? <span>@{d.author}</span> : null}
          {d.item ? <ItemMetricStrip item={d.item} related={d.related} relatedTitle={d.related ? relatedTitle(d) : undefined} /> : null}
        </div>
      )}
      {!d.untracked && (d.created_at || d.updated_at) && (
        <div className="rf-node-times muted">
          {d.updated_at ? <span title={d.updated_at}>updated {relativeTime(d.updated_at)}</span> : null}
          {d.created_at && d.updated_at ? <span className="sep">·</span> : null}
          {d.created_at ? <span title={d.created_at}>created {relativeTime(d.created_at)}</span> : null}
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
function Flow({ rfNodes, rfEdges, showEdgeLabels, onNodeActivate, theme }: { rfNodes: Node[]; rfEdges: Edge[]; showEdgeLabels: boolean; onNodeActivate: (id: string) => void; theme: ResolvedViewTheme }) {
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
      // Clicking a node's BODY focuses it (the parent maps that to the focus
      // route, mirroring a side-list card click); the title anchor inside the
      // node owns opening the provider page and stops propagation, so the two
      // never both fire.
      onNodeClick={(_, node) => onNodeActivate(node.id)}
      colorMode={theme === "paper" ? "light" : "dark"}
      fitView
      minZoom={0.05}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
    >
      <Background color="var(--graph-grid)" gap={22} />
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
  visibility,
  related,
  active,
  onActivate,
}: {
  item: ItemDTO | null;
  fallbackLabel: string;
  sourceKind?: string;
  accentColor?: string | null;
  relation?: { type: string; direction: "out" | "in" | "both"; visibility: GraphListVisibility | null };
  visibility?: GraphListVisibility | null;
  // The item's OWN relation count (chain-link chip in the card meta row), same
  // chip as the board. Distinct from `relation`, which describes this card's
  // relationship TO THE FOCUSED item in the focus view.
  related?: RelationCount | null;
  active?: boolean;
  // Generic click/keyboard activation handler (this card is a role="button").
  // The parent decides what activation means per card: a normal card focuses ITS
  // item; the active (already-focused) card clears focus. Hence the neutral name
  // rather than onFocus — re-clicking the active card is a "clear", not a focus.
  onActivate: () => void;
}) {
  const badge = relation?.visibility ?? visibility ?? null;
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
      {(relation || badge) && (
        <div className="glc-relation muted">
          {relation ? (
            <span className="glc-rel-type">
              {relation.direction === "both" ? "↔" : relation.direction === "out" ? "→" : "←"} {relation.type}
            </span>
          ) : null}
          {badge === "off-window" ? (
            <span className="glc-offwindow" title="outside the current “active since” window — shown here in focus, but absent from the overview graph until you widen it">
              off-window
            </span>
          ) : badge === "not-drawn" ? (
            <span className="glc-notdrawn" title="listed as a relationship candidate, but hidden from the current overview canvas by the edge filter">
              not drawn
            </span>
          ) : null}
        </div>
      )}
      {item ? (
        // No graphLink: this card already lives on the graph, and its body click
        // IS the focus action. The relation-count chip still renders.
        <ItemCard item={item} sourceKind={sourceKind} accentColor={accentColor} related={related} />
      ) : (
        <article className="card card-untracked">
          <div className="card-kind" title="unknown">
            <ItemKindIcon kind="unknown" className="card-kind-icon" />
          </div>
          <div className="card-main">
            <div className="card-head">
              <span className="card-title">{fallbackLabel}</span>
            </div>
            <div className="card-meta muted">untracked</div>
          </div>
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
//   • list  — searchable, demand-sorted cards of the in-range relationship
//             candidates, with an all/issue/pr kind toggle; click a card to
//             focus it. Cards hidden only by the canvas edge filter are marked.
//   • focus — that item + its related items (other edge ends, from the FULL edge
//             set, off-window ones flagged). A related card re-focuses
//             (navigation chain); "← all items" returns.
function GraphSideList({
  nodes,
  itemsByRef,
  adjacency,
  candidateIds,
  drawnIds,
  sourceKind,
  colorOf,
  focusId,
  onFocus,
  onBack,
}: {
  nodes: GraphNode[];
  itemsByRef: Map<string, ItemDTO>;
  adjacency: Map<string, RelatedRef[]>;
  candidateIds: Set<string>;
  drawnIds: Set<string>;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  // Focus is lifted to the route (GraphPage's onFocusChange writes "?focus=")
  // so the canvas can narrow to the focused item's subgraph AND the URL stays
  // shareable. null = the flat list; a ref = the focus view of that item.
  // onFocus enters/chains focus; onBack returns.
  focusId: string | null;
  onFocus: (id: string) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  // Side-list kind toggle (all / issue / pr). Defaults to "issue" so the list
  // opens on the smaller, more actionable issue set rather than the PR-heavy
  // full graph. Reuses MentionTarget — same three-way issue|change_request|all
  // shape. Applies only to the flat list below, not the focus view.
  const [kindFilter, setKindFilter] = useState<GraphMentionTarget>("issue");

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
  // The card's own chain-link relation count, from the SAME adjacency the focus
  // view lists — so the chip always matches what focusing the card would show.
  const countOf = (ref: string): RelationCount | null => relationCountOf(adjacency.get(ref) ?? []);
  const visibilityOf = (ref: string): GraphListVisibility | null => {
    if (!candidateIds.has(ref)) return "off-window";
    if (!drawnIds.has(ref)) return "not-drawn";
    return null;
  };

  if (focusId !== null) {
    // Collapse the per-direction adjacency entries to one card per (ref, type)
    // — a mutual relationship (e.g. two items that mention each other) becomes a
    // single "both" entry instead of a duplicate "→" + "←" pair.
    const related = relatedItems(adjacency.get(focusId) ?? []).sort((a, b) => {
      const rank = (ref: string) => (candidateIds.has(ref) ? (drawnIds.has(ref) ? 0 : 1) : 2);
      return rank(a.ref) - rank(b.ref) || a.type.localeCompare(b.type) || labelOf(a.ref).localeCompare(labelOf(b.ref));
    });
    const focusVisibility = visibilityOf(focusId);
    return (
      <aside className="graph-list">
        <button type="button" className="graph-list-back" onClick={onBack}>
          ← all items
        </button>
        <div className="graph-list-scroll">
          {/* Re-clicking the focused item clears focus (toggle off) — same exit as
              "← all items", so the card the user just clicked is also the way back. */}
          <GraphListCard item={itemsByRef.get(focusId) ?? null} fallbackLabel={labelOf(focusId)} sourceKind={kindOf(focusId)} accentColor={colorFor(focusId)} visibility={focusVisibility} related={countOf(focusId)} active onActivate={onBack} />
          {focusVisibility === "off-window" && (
            <p className="muted glc-note">This item is outside the current “active since” window — it's shown here in focus, but won't appear in the overview graph until you widen the window.</p>
          )}
          {focusVisibility === "not-drawn" && (
            <p className="muted glc-note">This item is in the relationship list, but hidden from the overview canvas by the current edge filter.</p>
          )}
          <div className="graph-related-head muted">
            {related.length} related {pluralize(related.length, "item")}
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
                relation={{ type: r.type, direction: r.direction, visibility: visibilityOf(r.ref) }}
                related={countOf(r.ref)}
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
    // Order by actionable state then newest-created, not demand.
    return match.sort(compareGraphNodes);
  })();

  return (
    <aside className="graph-list">
      <div className="graph-list-kinds toggle-group">
        {([
          ["all", "all"],
          ["issue", "issue"],
          ["change_request", "pr"],
        ] as Array<[GraphMentionTarget, string]>).map(([val, lab]) => (
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
            <GraphListCard key={n.id} item={itemsByRef.get(n.id) ?? null} fallbackLabel={n.label} sourceKind={kindOf(n.id)} accentColor={colorFor(n.id)} visibility={visibilityOf(n.id)} related={countOf(n.id)} onActivate={() => onFocus(n.id)} />
          ))
        )}
      </div>
    </aside>
  );
}

// The overview canvas empty state. A bare "nothing drawn" line is a dead-end:
// the user sees items in the side list but a blank canvas. When those items are
// hidden by an edge filter (graphCanvasEmptyReason), name the filter and offer
// the one-click flip that brings them onto the canvas.
function GraphCanvasEmptyState({
  reason,
  onShowMentions,
  onShowAllMentions,
}: {
  reason: GraphCanvasEmptyReason | null;
  onShowMentions: () => void;
  onShowAllMentions: () => void;
}) {
  if (!reason || reason.kind === "filtered") {
    // `filtered` is the non-actionable fallback — no single toggle flip recovers
    // the canvas — so keep the original bare line. (Effectively unreachable via
    // graphOverviewVisibility; see graphCanvasEmptyReason.)
    return <p className="empty">No relationships are drawn with the current edge filter.</p>;
  }
  if (reason.kind === "mentions-hidden") {
    const noun = pluralize(reason.hiddenLinks, "mention link");
    return (
      <div className="graph-empty">
        <p className="graph-empty-title">Nothing drawn yet</p>
        <p className="graph-empty-body">
          {reason.hiddenLinks} {noun} {reason.hiddenLinks === 1 ? "is" : "are"} hidden here — mentions are off by default to keep the canvas uncluttered.
        </p>
        <button type="button" className="toggle toggle-on graph-empty-action" onClick={onShowMentions}>
          Show mentions
        </button>
      </div>
    );
  }
  const target = reason.mentionTarget === "issue" ? "issues" : "PRs";
  const noun = pluralize(reason.hiddenLinks, "mention link");
  return (
    <div className="graph-empty">
      <p className="graph-empty-title">Nothing drawn yet</p>
      <p className="graph-empty-body">
        Mentions are filtered to {target}; the {reason.hiddenLinks} {noun} in range {reason.hiddenLinks === 1 ? "points" : "point"} elsewhere.
      </p>
      <button type="button" className="toggle toggle-on graph-empty-action" onClick={onShowAllMentions}>
        Show all mentions
      </button>
    </div>
  );
}

export function GraphPage({
  edges,
  focusEdges,
  sourceKind,
  colorOf,
  focusRef,
  onFocusChange,
  aggregates = [],
  itemWindow,
  range,
  timezone,
  emptyState,
  onClearFilters,
  theme,
  mobileView,
  onMobileView,
}: {
  edges: ResolvedEdge[];
  // The FOCUS-path edge set: same visibility + facet filters as `edges`, expanded
  // without the overview's client-side time/mention filters. Under
  // range-as-download this is still bounded by the loaded primary env.
  focusEdges: ResolvedEdge[];
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  // The focused item ref, owned by the ROUTE ("?focus="): a deep-link sets it,
  // and every in-page focus mutation (side-list click, canvas node click,
  // "← all items", the candidate-membership drop below) goes through
  // onFocusChange, which writes the hash back. That makes a focused view
  // shareable/reloadable and lets the browser back button step through focus
  // changes — the page holds no hidden focus state.
  focusRef?: string | null;
  onFocusChange: (ref: string | null) => void;
  aggregates?: readonly AggregateDTO[];
  itemWindow?: ItemWindowDTO;
  range: TimeRange;
  timezone: string;
  // Shared empty-state node for the no-relationships case in the overview (not
  // while focused — the focus view has its own escape hatches below).
  emptyState?: ReactNode;
  // Clears search / facet filters; offered in the focused-empty state because a
  // facet filter can hide a focused item's edges, which would otherwise read as
  // "no relationships" with no way out.
  onClearFilters?: () => void;
  theme: ResolvedViewTheme;
  // Mobile sub-view selection (route-backed). On narrow viewports the page shows
  // ONE of the two coupled panes — the searchable/focus list or the canvas —
  // chosen here; on wide viewports both render and this is ignored. (Named
  // `mobileView` to avoid colliding with the local graph-data `view` below.)
  mobileView: GraphView;
  onMobileView: (view: GraphView) => void;
}) {
  const isMobile = useMediaQuery(MOBILE_VIEWPORT_QUERY);
  // Below the breakpoint the list and canvas can't share the narrow column
  // usefully, so we show one at a time. The list stays the default: focusing an
  // item (route `focus=`) makes the list itself show that item's related
  // issues/PRs, so the relationship view never depends on the canvas — the
  // canvas is opt-in via the toggle. Above the breakpoint both render.
  const showListPane = !isMobile || mobileView === "list";
  const showGraphPane = !isMobile || mobileView === "graph";
  const [layout, setLayout] = useState<"force" | "hierarchy">("force");
  const [showMentions, setShowMentions] = useState(() => !!focusRef);
  const [mentionTarget, setMentionTarget] = useState<GraphMentionTarget>("all");
  // Drives BOTH the side list's focus view and the canvas subgraph below;
  // null = the flat list + full graph.
  const focusId = focusRef ?? null;

  const overview = useMemo(
    () => graphOverviewVisibility(edges, range, timezone, { showMentions, mentionTarget }),
    [edges, range, timezone, showMentions, mentionTarget],
  );
  const listGraph = useMemo(() => buildGraph(overview.candidateEdges), [overview]);
  const graph = useMemo(() => buildGraph(overview.drawnEdges), [overview]);

  // Side-list derivations over the FOCUS edge set: every resolvable item in the
  // loaded projection, the adjacency map, and the set of refs currently available
  // to the overview list/canvas.
  const itemsByRef = useMemo(() => {
    const m = new Map<string, ItemDTO>();
    for (const re of focusEdges) {
      if (re.from) m.set(re.edge.from, re.from);
      if (re.to) m.set(re.edge.to, re.to);
    }
    return m;
  }, [focusEdges]);
  const adjacency = useMemo(() => buildAdjacency(focusEdges), [focusEdges]);
  const candidateIds = overview.candidateIds;
  const drawnIds = overview.drawnIds;

  // Drop focus when the overview candidate MEMBERSHIP changes (the "active since"
  // range changed). Mention filters can remove a card from the canvas while it
  // remains a list candidate, so they should not kick the user out of focus. Compared
  // by CONTENT, not identity: a background contract reload rebuilds every memo
  // (new arrays, same ids), and an identity check would kick the user out of the
  // focus view on every sync tick. Content comparison is also idempotent under
  // React 18 StrictMode's double-invoked effects and never wipes the deep-link
  // seed on mount.
  const prevCandidates = useRef(candidateIds);
  useEffect(() => {
    if (prevCandidates.current === candidateIds) return;
    const prev = prevCandidates.current;
    prevCandidates.current = candidateIds;
    const sameMembers = prev.size === candidateIds.size && [...candidateIds].every((id) => prev.has(id));
    if (!sameMembers) onFocusChange(null);
  }, [candidateIds, onFocusChange]);

  // When an item is focused, the canvas shows that item's loaded relationship
  // neighbourhood (focusSubgraph over focusEdges — all edge types, no overview
  // range filter) instead of the overview graph, so every relationship the side
  // list lists is drawn (incl. mentions, regardless of the toggle). The time-range
  // controls render suspended while this view is active.
  // Falls back to the full graph if the focus has no edges (nothing to render).
  const view = useMemo<GraphData>(() => {
    if (!focusId) return graph;
    const sub = focusSubgraph(focusEdges, focusId);
    return sub.nodes.length ? sub : graph;
  }, [focusEdges, focusId, graph]);
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

  // Distinct neighbours per node IN THE CURRENT VIEW's links — compared against
  // the full relation count to tell the tooltip when the windowed/mention-filtered
  // overview draws fewer lines than the item actually has.
  const drawnNeighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      const s = m.get(a);
      if (s) s.add(b);
      else m.set(a, new Set([b]));
    };
    for (const l of view.links) {
      add(l.source, l.target);
      add(l.target, l.source);
    }
    return m;
  }, [view]);

  const rfNodes: Node[] = useMemo(
    () =>
      view.nodes.map((n) => {
        const { w, h } = dimOf(n.id);
        const it = n.item ?? itemsByRef.get(n.id);
        const accentColor = it ? colorOf(it.source_id, it.project_path) : null;
        // The chain-link count comes from the FULL adjacency (same number as the
        // board / side-list chip — what focusing reveals), not the drawn degree.
        const related = relationCountOf(adjacency.get(n.id) ?? []);
        return {
          id: n.id,
          type: "item",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          style: { width: w, height: h },
          data: { ...n, item: it ?? null, accentColor, related, relatedDrawn: drawnNeighbours.get(n.id)?.size ?? 0 } as unknown as Record<string, unknown>,
        };
      }),
    [view, positions, dimOf, itemsByRef, colorOf, adjacency, drawnNeighbours],
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
  const { paneRef: graphPaneRef, paneHeightStyle } = useContentPaneHeight<HTMLDivElement>([
    showListPane,
    showGraphPane,
    mobileView,
    focusId,
    view.nodes.length,
    view.links.length,
  ]);

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
            ] as Array<[GraphMentionTarget, string]>).map(([val, lab]) => (
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
      </div>
      {/* The legend + hint is read-only orientation, so it rides inside the
          StatsBar's collapsible region — tucked away with the stats on narrow,
          shown after the stats on desktop. */}
      <StatsBar
        scoped={scopedStats}
        totalLabel="nodes"
        edgeLabel="links"
        footer={
          <div className="graph-legend">
            {NODE_LEGEND.map((x) => (
              <span key={x.t}>
                <span className="dot" style={{ background: x.c }} />
                {x.t}
              </span>
            ))}
            <span className="muted">· solid = closes · dashed = mentions · size = demand · hover to highlight · click to focus · title → provider</span>
          </div>
        }
      />
      {/* Empty when the overview window has no links AND we are not showing a
          focus subgraph. `!inFocus` keeps a deep-linked focus whose neighbourhood
          lives outside the current window renderable (its canvas is `view`, the
          full-payload focus subgraph), and makes the focus message accurate: it
          only shows when the focused item genuinely has no edges (view fell back
          to the empty overview). */}
      {listGraph.links.length === 0 && !inFocus ? (
        focusId ? (
          // A facet/search filter can hide the focused item's edges, so don't
          // claim it has none — offer the escapes (clear filters, leave focus).
          <div className="empty empty-state">
            <p className="empty-state-title">No relationships to show for the focused item.</p>
            <div className="empty-actions">
              <button type="button" className="empty-action primary" onClick={() => onFocusChange(null)}>
                Back to all items
              </button>
              {onClearFilters ? (
                <button type="button" className="empty-action" onClick={onClearFilters}>
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          emptyState ?? <p className="empty">No relationships in this range.</p>
        )
      ) : (
        // One shared ReactFlowProvider wraps the side list + canvas; remounting
        // <Flow> on a focus change (flowKey) is what reframes the camera now.
        <ReactFlowProvider>
          {isMobile ? <GraphViewToggle view={mobileView} onView={onMobileView} /> : null}
          <div className="graph-body" ref={graphPaneRef} style={paneHeightStyle}>
            {showListPane ? (
              <GraphSideList
                nodes={listGraph.nodes}
                itemsByRef={itemsByRef}
                adjacency={adjacency}
                candidateIds={candidateIds}
                drawnIds={drawnIds}
                sourceKind={sourceKind}
                colorOf={colorOf}
                focusId={focusId}
                onFocus={onFocusChange}
                onBack={() => onFocusChange(null)}
              />
            ) : null}
            {showGraphPane ? (
              <div className="graph-canvas">
                {/* Re-clicking the focused node clears focus — the same toggle
                    exit as the side list's active card. */}
                {view.links.length === 0 ? (
                  <GraphCanvasEmptyState
                    reason={inFocus ? null : graphCanvasEmptyReason(overview, { showMentions, mentionTarget })}
                    onShowMentions={() => {
                      // Also reset the target: it persists while mentions are off,
                      // so a stale non-"all" target could keep the canvas empty
                      // even after enabling mentions.
                      setMentionTarget("all");
                      setShowMentions(true);
                    }}
                    onShowAllMentions={() => setMentionTarget("all")}
                  />
                ) : (
                  <Flow key={flowKey} rfNodes={rfNodes} rfEdges={rfEdges} showEdgeLabels={inFocus} onNodeActivate={(id) => onFocusChange(id === focusId ? null : id)} theme={theme} />
                )}
              </div>
            ) : null}
          </div>
        </ReactFlowProvider>
      )}
    </section>
  );
}

// Mobile-only segmented control choosing which single coupled pane the Graph
// page shows — the searchable/focus list or the relationship canvas. Mirrors the
// Activity view toggle / Settings sub-tab chrome (role=tablist + selected button).
function GraphViewToggle({ view, onView }: { view: GraphView; onView: (view: GraphView) => void }) {
  return (
    <nav className="graph-view-toggle" role="tablist" aria-label="Graph view">
      {(["list", "graph"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          className={`graph-view-tab${view === v ? " graph-view-tab-active" : ""}`}
          onClick={() => onView(v)}
        >
          {v === "list" ? "List" : "Graph"}
        </button>
      ))}
    </nav>
  );
}
