import { ActorLink, EntityLink, ExternalLink } from "./ExternalLink.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  useNodesState,
  useEdgesState,
  useInternalNode,
  useReactFlow,
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
import { MOBILE_VIEWPORT_QUERY, GRAPH_FOCUS_MAX_DEPTH, buildGraph, buildAdjacency, computeGraphStats, findContractScopedStats, focusNeighborhoodNodes, focusSubgraph, graphOverviewVisibility, graphCanvasEmptyReason, graphConnectedComponents, packGraphComponentLayouts, relatedItems, relationCountOf, compareGraphNodes, relativeTime, pluralize, graphTopologyKey, graphStatsHeadline, graphForceLayoutTicks, graphForceLayoutTickBudgets, graphEdgeStyle, graphEdgeTypes, graphNodeRelatedTitle, graphRelationTypes, graphProgramView, graphFocusDropped, programLayers, programScopeEdges, type GraphCanvasEmptyReason, type GraphFocusResetState, type GraphFocusScope, type GraphMentionTarget, type GraphOverviewOptions, type GraphProgramView, type GraphNode, type GraphLink, type GraphData, type ResolvedEdge, type RelatedRef, type RelationCount, type ColorOf, type TimeRange, type GraphNeighborhoodResponse, type GraphNeighborhoodNode } from "../model.ts";
import { programRollups, type ProgramChildStatus } from "../program.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { COMPACT_CHROME_QUERY, NARROW_VIEWPORT_QUERY } from "../layout-tier.ts";
import { minimapSize } from "../graph-minimap.ts";
import { useContentPaneHeight } from "../useContentPaneHeight.ts";
import type { ResolvedViewTheme } from "../viewconfig.ts";
import type { GraphView } from "../nav.ts";

// React Flow renders each node as real HTML, so a node can be a card showing the
// repo / #iid / state — not just a label. Each known relation type has its own
// stroke (model graphEdgeStyle): closes edges (issue <-> change request) are
// solid and lifecycle-coloured, blocks heavy, parent dash-dotted, relates
// long-dashed; opt-in mentions are short-dashed — de-emphasised (thin, faint) in
// the dense overview, but drawn full-strength in the focus view. A type the UI
// does not know draws like closes. Layout is computed (RF ships none): dagre for
// the hierarchy view, d3-force for the knowledge-graph view.
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
// window still lists, marked "off-window". A "← all items" button returns.
//
// Focusing a program tracker opens its PROGRAM view instead (model
// graphProgramView): the tracker is the header, its children are the nodes,
// layered left to right by what blocks what, each with its program.ts status
// and its delivering change requests underneath. A view toggle switches to the
// ordinary neighbourhood and back.

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
// Program view: a delivering change request is a compact card under its child,
// indented, with room above it for the closes arrow.
const ATTACHED_H = 50;
const ATTACHED_GAP = 26;
const ATTACHED_INDENT = 16;
const PROGRAM_COLUMN_GAP = 140;
const PROGRAM_ROW_GAP = 28;
// Arrowheads scale with the stroke; past this width the marker box shrinks so a
// heavy line does not grow a heavier head than any other edge has.
const ARROW_MAX_STROKE = 1.75;

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
const LIFECYCLE_LEGEND = ["declared", "fulfilled", "broken"];

// A program child's status marker: a glyph and a word, so it never reads by
// colour alone. The rule itself lives in program.ts.
const PROGRAM_STATUS: Record<ProgramChildStatus, { mark: string; label: string }> = {
  done: { mark: "✓", label: "done" },
  ready: { mark: "→", label: "ready" },
  in_review: { mark: "…", label: "in review" },
  blocked: { mark: "×", label: "blocked" },
};
const PROGRAM_STATUSES = Object.keys(PROGRAM_STATUS) as ProgramChildStatus[];

function ProgramStatusMark({ status }: { status: ProgramChildStatus }) {
  return (
    <span className={`program-status program-status-${status}`}>
      <span aria-hidden="true">{PROGRAM_STATUS[status].mark}</span> {PROGRAM_STATUS[status].label}
    </span>
  );
}

// A sample of one relation type's line, for the legend.
function EdgeSwatch({ type, stroke }: { type: string; stroke?: string }) {
  const style = graphEdgeStyle(type);
  return (
    <svg className="graph-legend-line" width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
      <line x1="1" y1="4" x2="25" y2="4" stroke={stroke ?? style.stroke ?? "var(--muted)"} strokeWidth={style.width} strokeDasharray={style.dash ?? undefined} />
    </svg>
  );
}

type GraphListVisibility = "off-window" | "not-drawn";
type ItemNodeData = GraphNode & { item?: ItemDTO | null; focused?: boolean };

function ItemNode({ data }: NodeProps) {
  const d = data as unknown as ItemNodeData;
  const { scale } = dims(d.demand);
  const metricCount = d.item ? itemMetricEntries(d.item, d.related).length : 0;
  return (
    <div
      className={`rf-node${d.untracked ? " rf-node-untracked" : ""}${d.focused ? " rf-node-focused" : ""}`}
      // The left border already encodes STATE (d.color), so a highlighted repo
      // shows as an outer ring (outline) instead — a literal "frame" that does
      // not collide with the state edge. The board card uses a left bar; here the
      // left edge is taken, hence the ring.
      style={{
        borderLeftColor: d.color,
        fontSize: `${(11 * scale).toFixed(1)}px`,
        ...(d.accentColor && !d.focused ? { outline: `2px solid ${d.accentColor}`, outlineOffset: "1px" } : {}),
      }}
      title={d.demand != null ? `${d.label} · ${d.demand} comments + reactions` : d.label}
      data-program-status={d.programStatus}
    >
      <Handle type="target" position={Position.Top} className="rf-handle" />
      <div className="rf-node-head">
        <ItemKindIcon kind={d.kind} className="rf-node-kind-icon" />
        <Badge text={d.state} kind={d.state} />
        {d.programStatus ? <ProgramStatusMark status={d.programStatus} /> : null}
        {d.focused ? <span className="rf-node-focus-marker">TARGET</span> : null}
      </div>
      {/* The title is a real anchor to the provider page when the item has a
          URL — visible link affordance, cmd/middle-click, hover URL preview.
          `nodrag` keeps the anchor from starting a node drag; stopPropagation
          keeps the node-body click (which FOCUSES the node) from also firing.
          Untracked nodes have no URL and keep the plain text title. */}
      {d.url ? (
        <ExternalLink className="rf-node-title nodrag" href={d.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {d.label}
        </ExternalLink>
      ) : (
        <div className="rf-node-title">{d.label}</div>
      )}
      <div className="rf-node-repo">
        <EntityLink className={d.repo ? "card-repo nodrag" : "muted"} sourceId={d.item?.source_id} entity={{ kind: "repo", projectPath: d.repo }}>{d.repo ?? "untracked"}</EntityLink>
        {d.iid != null ? <ExternalLink className="card-iid nodrag" href={d.url}> #{d.iid}</ExternalLink> : null}
      </div>
      {/* Two fixed rows mirroring the board/side-list card: the counts row
          (@author + shared item metrics) then the times row (updated · created).
          Deterministic line count -- the old single mixed row wrapped
          unpredictably and could overflow the fixed-height node box. */}
      {!d.untracked && (d.author || metricCount > 0) && (
        <div className="rf-node-meta muted">
          {d.author ? <ActorLink sourceId={d.item?.source_id} name={d.author} username>@{d.author}</ActorLink> : null}
          {d.item ? <ItemMetricStrip item={d.item} related={d.related} relatedTitle={d.related ? graphNodeRelatedTitle(d) : undefined} /> : null}
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

// A program child's delivering change request: kind, state, number, one title
// line. Clicking it focuses it like any node; its title opens the provider.
function AttachedNode({ data }: NodeProps) {
  const d = data as unknown as ItemNodeData;
  return (
    <div className={`rf-node rf-node-attached${d.untracked ? " rf-node-untracked" : ""}`} style={{ borderLeftColor: d.color }} title={d.label}>
      <Handle type="target" position={Position.Top} className="rf-handle" />
      <div className="rf-node-head">
        <ItemKindIcon kind={d.kind} className="rf-node-kind-icon" />
        <Badge text={d.state} kind={d.state} />
        {d.iid != null ? <ExternalLink className="card-iid nodrag" href={d.url}>#{d.iid}</ExternalLink> : null}
      </div>
      {d.url ? (
        <ExternalLink className="rf-node-title nodrag" href={d.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {d.label}
        </ExternalLink>
      ) : (
        <div className="rf-node-title">{d.label}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="rf-handle" />
    </div>
  );
}

const nodeTypes = { item: ItemNode, attached: AttachedNode };

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

// The program view's layout: one column per dependency layer (model
// programLayers), left to right, each column centred on the tallest. It is not
// dagre's: gate contraction makes whole layers depend on whole layers, and
// dagre's coordinate assignment spreads such a column over several times its
// own height. A child's change requests are stacked under it, inside its slot.
function layoutProgram(program: GraphProgramView, dimOf: (id: string) => Dim): Map<string, { x: number; y: number }> {
  const attachedTo = (id: string): string[] => program.attached.get(id) ?? [];
  const slotHeight = (id: string): number => dimOf(id).h + attachedTo(id).length * (ATTACHED_GAP + ATTACHED_H);
  const columns = programLayers(program).map((ids) => ({
    ids,
    width: Math.max(...ids.map((id) => dimOf(id).w)),
    height: ids.reduce((sum, id) => sum + slotHeight(id), 0) + (ids.length - 1) * PROGRAM_ROW_GAP,
  }));
  const tallest = Math.max(0, ...columns.map((column) => column.height));
  const m = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const column of columns) {
    let y = (tallest - column.height) / 2;
    for (const id of column.ids) {
      m.set(id, { x, y });
      attachedTo(id).forEach((attached, index) =>
        m.set(attached, { x: x + ATTACHED_INDENT, y: y + dimOf(id).h + ATTACHED_GAP + index * (ATTACHED_H + ATTACHED_GAP) }),
      );
      y += slotHeight(id) + PROGRAM_ROW_GAP;
    }
    x += column.width + PROGRAM_COLUMN_GAP;
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

function layoutForce(nodes: GraphNode[], links: GraphLink[], dimOf: (id: string) => Dim, density: LayoutDensity, tickBudget: number): Map<string, { x: number; y: number }> {
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
  for (let i = 0; i < tickBudget; i++) sim.tick();
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
function Flow({ rfNodes, rfEdges, focusId, showEdgeLabels, onNodeActivate, theme, paneWidth }: { paneWidth: number; rfNodes: Node[]; rfEdges: Edge[]; focusId: string | null; showEdgeLabels: boolean; onNodeActivate: (id: string) => void; theme: ResolvedViewTheme }) {
  const compactMinimap = useMediaQuery(COMPACT_CHROME_QUERY);
  const [nodes, , onNodesChange] = useNodesState(rfNodes);
  const [edges, , onEdgesChange] = useEdgesState(rfEdges);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const { getNode, setCenter } = useReactFlow();
  const hasTarget = !!focusId && rfNodes.some((node) => node.id === focusId);

  const locateFocus = () => {
    if (!focusId) return;
    const node = getNode(focusId);
    if (!node) return;
    const width = node.measured?.width ?? NODE_W;
    const height = node.measured?.height ?? NODE_H;
    void setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: 1, duration: 400 });
  };

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

  const baseEdgeStyle = useMemo(() => new Map(rfEdges.map((edge) => [edge.id, edge.style])), [rfEdges]);

  const viewEdges = useMemo(
    () =>
      edges.map((e) => {
        const incident = !!hoverId && (e.source === hoverId || e.target === hoverId);
        const labelled = showEdgeLabels || incident;
        const base: CSSProperties = baseEdgeStyle.get(e.id) ?? e.style ?? {};
        return {
          ...e,
          // FloatingEdge renders this label via EdgeLabelRenderer (styled by
          // .rf-edge-label), so only the text is needed here — no SVG label props.
          label: labelled ? String((e.data as { type?: string } | undefined)?.type ?? "") : undefined,
          style: { ...base, opacity: hoverId ? (incident ? 1 : 0.05) : (base.opacity ?? 1) },
        };
      }),
    [baseEdgeStyle, edges, hoverId, showEdgeLabels],
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
      {hasTarget ? (
        <Panel position="top-left" className="graph-focus-panel">
          <button type="button" className="graph-locate-focus nodrag nopan" aria-label="Locate target card" onClick={locateFocus}>Locate target</button>
        </Panel>
      ) : null}
      <Controls showInteractive={false} />
      <MiniMap
        pannable zoomable
        // Sized through React Flow (not CSS) so its drag-pan scale matches the drawn size.
        style={minimapSize(paneWidth, compactMinimap)}
        nodeColor={(n) => (n.data as unknown as ItemNodeData).focused ? "var(--iid)" : (n.data as unknown as GraphNode).color}
        nodeClassName={(n) => (n.data as unknown as ItemNodeData).focused ? "graph-minimap-target" : ""}
      />
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
  const visibleBadge = badge === "off-window" ? badge : null;
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
      {(relation || visibleBadge) && (
        <div className="glc-relation muted">
          {relation ? (
            <span className="glc-rel-type">
              {relation.direction === "both" ? "↔" : relation.direction === "out" ? "→" : "←"} {relation.type}
            </span>
          ) : null}
          {visibleBadge === "off-window" ? (
            <span className="glc-offwindow" title="outside the current “active since” window — shown here in focus, but absent from the overview graph until you widen it">
              off-window
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
//             candidates, with an all/issue/change-request kind toggle; click a card to
//             focus it. Canvas visibility remains an internal sorting signal.
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
  // Side-list kind toggle (all / issue / change request). Defaults to "issue" so the list
  // opens on the smaller, more actionable issue set rather than the change-request-heavy
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
          ["change_request", "change request"],
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
  onShowAllTypes,
}: {
  reason: GraphCanvasEmptyReason | null;
  onShowMentions: () => void;
  onShowAllMentions: () => void;
  onShowAllTypes: () => void;
}) {
  if (!reason) return <p className="empty">No relationships are drawn with the current edge filter.</p>;
  if (reason.kind === "filtered") {
    // Relation types other than mentions are switched off: switching them all
    // back on draws at least the non-mention candidates.
    return (
      <div className="graph-empty">
        <p className="graph-empty-title">Nothing drawn yet</p>
        <p className="graph-empty-body">
          {reason.hiddenLinks} {pluralize(reason.hiddenLinks, "link")} in range {reason.hiddenLinks === 1 ? "is" : "are"} hidden by the relation types switched off above.
        </p>
        <button type="button" className="toggle toggle-on graph-empty-action" onClick={onShowAllTypes}>
          Show all relation types
        </button>
      </div>
    );
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
  const target = reason.mentionTarget === "issue" ? "issues" : "change requests";
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
  focusOverviewEdges,
  focusEdges,
  focusNodes,
  programEdges,
  programFacetsIgnored = false,
  focusScope,
  onFocusScopeChange,
  sourceKind,
  colorOf,
  focusRef,
  onFocusChange,
  focusLens,
  focusDepth,
  onFocusDepthChange,
  focusExpanded,
  focusLoadStatus,
  focusLoadMessage,
  focusNeighborhood,
  aggregates = [],
  itemWindow,
  range,
  timezone,
  emptyState,
  onClearFilters,
  theme,
  mobileView,
  onMobileView,
  controlsSlot = null,
  onControlsSummary,
}: {
  edges: ResolvedEdge[];
  // Range-loaded membership for focus badges/ranking. Unlike `edges`, this
  // preserves explicit facets but suspends global search, so chaining focus to
  // a non-matching related item cannot falsely label it off-window.
  focusOverviewEdges: ResolvedEdge[];
  // The FOCUS-path edge set: same visibility + facet filters as `edges`, expanded
  // without the overview's client-side time/mention filters. Under
  // range-as-download this is still bounded by the loaded primary env.
  focusEdges: ResolvedEdge[];
  // Canonical focus responses can legitimately contain an isolated item and no
  // edges. Keep those nodes as first-class render input instead of falling back
  // to the unrelated overview graph.
  focusNodes: readonly GraphNeighborhoodNode[];
  // What a focused tracker's program is read from: the focus data under the
  // persistent visibility choices only — no search, no item facets — so its
  // children and their statuses match the Board's tracker card.
  programEdges: ResolvedEdge[];
  // True while item facets are active, which the program view does not apply.
  programFacetsIgnored?: boolean;
  // Route-backed ("?scope="): "program" (the default) shows a focused tracker's
  // program; "neighborhood" its ordinary neighbourhood. Ignored for an item that
  // is not a tracker.
  focusScope: GraphFocusScope;
  onFocusScopeChange: (scope: GraphFocusScope) => void;
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
  // The viewer's range and item facets from the route (model graphFocusLens):
  // only a change here can drop the focus (below).
  focusLens: string;
  focusDepth: number;
  onFocusDepthChange: (depth: number) => void;
  focusExpanded: boolean;
  focusLoadStatus: "idle" | "loading" | "ready" | "fallback";
  focusLoadMessage: string | null;
  focusNeighborhood: GraphNeighborhoodResponse | null;
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
  // Narrow tier: depth / layout move into the filters sheet. The host provides
  // the sheet's slot element (null while the sheet is closed) and receives the
  // one-line summary the collapsed filters disclosure shows.
  controlsSlot?: HTMLElement | null;
  onControlsSummary?: (summary: string) => void;
}) {
  const isMobile = useMediaQuery(MOBILE_VIEWPORT_QUERY);
  // Below the breakpoint the list and canvas can't share the narrow column
  // usefully, so we show one at a time. The list stays the default: focusing an
  // item (route `focus=`) makes the list itself show that item's related issues
  // and change requests, so the relationship view never depends on the canvas — the
  // canvas is opt-in via the toggle. Above the breakpoint both render.
  const showListPane = !isMobile || mobileView === "list";
  const showGraphPane = !isMobile || mobileView === "graph";
  const [layout, setLayout] = useState<"force" | "hierarchy">("force");
  // These preferences belong to the overview canvas: one switch per relation
  // type in the loaded data, every type on except mentions. A focused item
  // always reveals its available relationships, including mentions.
  const [showMentions, setShowMentions] = useState(false);
  const [mentionTarget, setMentionTarget] = useState<GraphMentionTarget>("all");
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(() => new Set());
  const edgeTypes = useMemo(() => graphEdgeTypes(edges), [edges]);
  const typeShown = (type: string): boolean => (type === "mentions" ? showMentions : !hiddenTypes.has(type));
  const toggleType = (type: string) => {
    if (type === "mentions") {
      setShowMentions((v) => !v);
      return;
    }
    setHiddenTypes((current) => {
      const next = new Set(current);
      if (!next.delete(type)) next.add(type);
      return next;
    });
  };
  const overviewOptions = useMemo<GraphOverviewOptions>(() => ({ showMentions, mentionTarget, hiddenTypes }), [showMentions, mentionTarget, hiddenTypes]);
  // Drives BOTH the side list's focus view and the canvas subgraph below;
  // null = the flat list + full graph.
  const focusId = focusRef ?? null;

  const overview = useMemo(
    () => graphOverviewVisibility(edges, range, timezone, overviewOptions),
    [edges, range, timezone, overviewOptions],
  );
  const focusOverview = useMemo(
    () => graphOverviewVisibility(focusOverviewEdges, range, timezone, overviewOptions),
    [focusOverviewEdges, range, timezone, overviewOptions],
  );
  const listGraph = useMemo(() => buildGraph(overview.candidateEdges), [overview]);
  const graph = useMemo(() => buildGraph(overview.drawnEdges), [overview]);

  // Every tracker's rollup in the focus data, indexed once; the focused item is
  // a program tracker when it has an entry.
  const programs = useMemo(() => {
    if (!focusId) return null;
    const items = new Map<string, ItemDTO>();
    for (const re of programEdges) {
      if (re.from) items.set(re.edge.from, re.from);
      if (re.to) items.set(re.edge.to, re.to);
    }
    return programRollups(items, programEdges.map((re) => re.edge));
  }, [focusId, programEdges]);
  const focusProgram = (focusId && programs?.get(focusId)) || null;
  const program = useMemo(
    () => (focusId && focusProgram && focusScope === "program" ? graphProgramView(programEdges, focusId, focusProgram) : null),
    [focusId, focusProgram, focusScope, programEdges],
  );
  const programScope = useMemo(() => (focusId && program ? programScopeEdges(programEdges, focusId) : null), [focusId, program, programEdges]);
  // Side-list derivations over the FOCUS edge set: every resolvable item in the
  // loaded projection, the adjacency map, and the set of refs currently available
  // to the overview list/canvas. In the program view that set is the program.
  const focusViewEdges = programScope ?? focusEdges;
  const focusViewNodes = useMemo(
    () => focusExpanded && focusId ? focusNeighborhoodNodes(focusNodes, focusId, focusViewEdges) : focusNodes,
    [focusExpanded, focusId, focusNodes, focusViewEdges],
  );
  const itemsByRef = useMemo(() => {
    const m = new Map<string, ItemDTO>();
    for (const node of focusViewNodes) if (node.item) m.set(node.ref, node.item);
    for (const re of focusViewEdges) {
      if (re.from) m.set(re.edge.from, re.from);
      if (re.to) m.set(re.edge.to, re.to);
    }
    return m;
  }, [focusViewEdges, focusViewNodes]);
  const adjacency = useMemo(() => buildAdjacency(focusViewEdges), [focusViewEdges]);
  const candidateIds = focusId ? focusOverview.candidateIds : overview.candidateIds;
  const drawnIds = focusId ? focusOverview.drawnIds : overview.drawnIds;
  // Focus entry itself changes the side-list membership from the searched
  // overview to the search-suspended overview. That transition must not look
  // like a range/facet change and immediately clear the newly selected focus.
  const focusResetCandidateIds = focusOverview.candidateIds;

  // Drop focus when the viewer changes the range or an item facet and that
  // changes the overview candidate MEMBERSHIP (model graphFocusDropped). Mention
  // filters can remove a card from the canvas while it remains a list candidate,
  // so they should not kick the user out of focus. The app's own loads — the
  // cold start re-anchoring its range to the contract, a background contract
  // reload — change the candidates without a viewer change, so they keep the
  // focus a link or reload brought. Compared by CONTENT, so the rule is
  // idempotent under React 18 StrictMode's double-invoked effects and never
  // wipes the deep-link seed on mount.
  const focusReset = useMemo<GraphFocusResetState>(
    () => ({ focus: focusId, lens: focusLens, candidateIds: focusResetCandidateIds }),
    [focusId, focusLens, focusResetCandidateIds],
  );
  const prevFocusReset = useRef(focusReset);
  useEffect(() => {
    const prev = prevFocusReset.current;
    if (prev === focusReset) return;
    prevFocusReset.current = focusReset;
    if (graphFocusDropped(prev, focusReset)) onFocusChange(null);
  }, [focusReset, onFocusChange]);

  // A ready canonical-history response already contains the selected multi-hop
  // induced graph, so render all focusEdges. Loading/fallback/static paths retain
  // the previous direct-neighbour focusSubgraph over loaded range edges.
  // Falls back to the full graph if the focus has no edges (nothing to render).
  const view = useMemo<GraphData>(() => {
    if (!focusId) return graph;
    if (program) return program.graph;
    const sub = focusExpanded ? buildGraph(focusViewEdges, focusViewNodes) : focusSubgraph(focusViewEdges, focusId);
    return sub.nodes.length ? sub : graph;
  }, [focusViewEdges, focusViewNodes, focusId, focusExpanded, graph, program]);
  // True when the canvas is showing a focus subgraph (not the full overview). In
  // focus there is no clutter to fight, so edges — mentions especially — are
  // drawn at full strength rather than the overview's de-emphasised styling.
  const inFocus = view !== graph;
  const contractGraphStats = useMemo(
    () =>
      !inFocus && !showMentions && mentionTarget === "all" && hiddenTypes.size === 0
        ? findContractScopedStats(aggregates, { scope: "graphWindow", since: range.from, edgeFilter: "no_mentions" })
        : null,
    [aggregates, range.from, inFocus, showMentions, mentionTarget, hiddenTypes],
  );
  const scopedStats = useMemo(
    () => contractGraphStats ?? computeGraphStats(view, inFocus ? "focus" : "graphWindow"),
    [contractGraphStats, view, inFocus],
  );

  const dimOf = useMemo(() => {
    const m = new Map<string, Dim>();
    for (const n of view.nodes) if (!n.attachedTo) m.set(n.id, dims(n.demand));
    for (const n of view.nodes) if (n.attachedTo) m.set(n.id, { w: (m.get(n.attachedTo)?.w ?? NODE_W) - ATTACHED_INDENT, h: ATTACHED_H, scale: 1 });
    return (id: string): Dim => m.get(id) ?? { w: NODE_W, h: NODE_H, scale: 1 };
  }, [view]);

  const positions = useMemo(() => {
    const layoutOne = (component: GraphData, tickBudget: number) =>
      layout === "hierarchy"
        ? layoutDagre(component.nodes, component.links, dimOf)
        : layoutForce(component.nodes, component.links, dimOf, inFocus ? "focus" : "overview", tickBudget);
    if (program) return layoutProgram(program, dimOf);
    if (inFocus) return layoutOne(view, graphForceLayoutTicks(view.nodes.length));
    const components = graphConnectedComponents(view);
    const tickBudgets = graphForceLayoutTickBudgets(components.map((component) => component.nodes.length));
    return packGraphComponentLayouts(
      components.map((component, index) => ({ key: component.nodes[0]?.id ?? "", positions: layoutOne(component, tickBudgets[index] ?? 0) })),
      dimOf,
    );
  }, [view, layout, dimOf, inFocus, program]);

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
          type: n.attachedTo ? "attached" : "item",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          style: { width: w, height: h },
          data: { ...n, item: it ?? null, accentColor, related, relatedDrawn: drawnNeighbours.get(n.id)?.size ?? 0, focused: n.id === focusId } as unknown as Record<string, unknown>,
        };
      }),
    [view, positions, dimOf, itemsByRef, colorOf, adjacency, drawnNeighbours, focusId],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      view.links.map((l) => {
        const isMention = l.type === "mentions";
        // Each known type has its own line (graphEdgeStyle); a type without a
        // stroke of its own takes the lifecycle colour. Mentions stay dashed in a
        // lighter slate — the lifecycle palette's muted grey is near-invisible
        // on the dark canvas. In the OVERVIEW they're thin + faint to recede
        // behind the structure; in FOCUS they go full opacity + slightly thicker
        // so the one relationship you drilled into is actually visible.
        const style = graphEdgeStyle(l.type);
        const stroke = style.stroke ?? l.color;
        const strokeWidth = isMention && inFocus ? 1.75 : style.width;
        const arrow = 14 * Math.min(1, ARROW_MAX_STROKE / strokeWidth);
        return {
          id: l.id,
          type: "floating",
          source: l.source,
          target: l.target,
          data: { type: l.type },
          style: {
            stroke,
            strokeWidth,
            strokeDasharray: style.dash ?? undefined,
            opacity: isMention && !inFocus ? 0.55 : 1,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: arrow, height: arrow },
        };
      }),
    [view, inFocus],
  );

  // focusId is in the key so each focus change remounts <Flow>, which re-runs its
  // `fitView` to frame the new subgraph — that is what makes clicking a related
  // item visibly switch the canvas to that item (the old design only panned the
  // full graph, so a neighbour barely moved the camera).
  const flowKey = `${layout}|${showMentions}|${mentionTarget}|${[...hiddenTypes].sort().join(",")}|${range.from}|${range.to}|${focusId ?? ""}|${focusDepth}|${program ? "program" : ""}|${graphTopologyKey(view, focusExpanded)}`;
  const { paneRef: graphPaneRef, paneHeightStyle } = useContentPaneHeight<HTMLDivElement>([
    showListPane,
    showGraphPane,
    mobileView,
    focusId,
    program !== null,
    view.nodes.length,
    view.links.length,
  ]);
  // The canvas pane's width drives the desktop minimap size. Observed on the pane
  // itself (not the window), so a resized sidebar counts too.
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const canvasRef = useCallback((node: HTMLDivElement | null) => setCanvasEl(node), []);
  const [canvasWidth, setCanvasWidth] = useState(0);
  useEffect(() => {
    if (!canvasEl) return undefined;
    const measure = () => setCanvasWidth(canvasEl.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(canvasEl);
    return () => observer.disconnect();
  }, [canvasEl]);
  // What the legend keys: the relation types on the canvas right now.
  const legendTypes = useMemo(() => graphRelationTypes(view.links.map((l) => l.type)), [view]);
  const trackerItem = focusId && program ? itemsByRef.get(focusId) ?? null : null;

  // Depth and layout. Inline on wider viewports; on the narrow tier they ride in
  // the filters sheet instead (portaled into `controlsSlot`) so the Graph tab
  // spends its short phone height on the graph itself.
  const narrowChrome = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const foldedControls = narrowChrome && !!onControlsSummary;
  const viewControls = (
    <>
      {focusId && !program ? (
        <div className="toggle-group graph-depth-controls">
          <span className="toggle-label">depth</span>
          {Array.from({ length: GRAPH_FOCUS_MAX_DEPTH }, (_, index) => index + 1).map((depth) => (
            <button
              key={depth}
              type="button"
              className={`toggle${focusDepth === depth ? " toggle-on" : ""}`}
              onClick={() => onFocusDepthChange(depth)}
              aria-label={`${depth} relationship ${depth === 1 ? "hop" : "hops"}`}
            >
              {depth}
            </button>
          ))}
        </div>
      ) : null}
      {program ? null : (
        <div className="toggle-group">
          <span className="toggle-label">layout</span>
          <button type="button" className={`toggle${layout === "force" ? " toggle-on" : ""}`} onClick={() => setLayout("force")}>
            Force
          </button>
          <button type="button" className={`toggle${layout === "hierarchy" ? " toggle-on" : ""}`} onClick={() => setLayout("hierarchy")}>
            Hierarchy
          </button>
        </div>
      )}
    </>
  );
  // The ready summary row folds into the stats disclosure on the narrow tier
  // (the row itself is hidden there); loading / fallback messages keep theirs.
  const focusHeadline =
    narrowChrome && focusId && focusLoadStatus === "ready" && focusNeighborhood
      ? graphStatsHeadline({
          items: view.nodes.length,
          edges: view.links.length,
          depth: program
            ? "program"
            : focusNeighborhood.reached_depth === focusNeighborhood.requested_depth
              ? String(focusNeighborhood.reached_depth)
              : `${focusNeighborhood.reached_depth}/${focusNeighborhood.requested_depth}`,
          limit: focusNeighborhood.complete ? null : focusNeighborhood.limit_reasons.join(", "),
        })
      : undefined;
  const controlsSummary = [focusId && !program ? `depth ${focusDepth}` : null, program ? null : layout === "force" ? "Force" : "Hierarchy"].filter(Boolean).join(" · ");
  useEffect(() => {
    if (!foldedControls) return undefined;
    onControlsSummary?.(controlsSummary);
    return () => onControlsSummary?.("");
  }, [foldedControls, controlsSummary, onControlsSummary]);

  return (
    <section className="graph-page">
      <div className="graph-controls">
        <span className="muted">
          showing {view.nodes.length} nodes · {view.links.length} links
          {focusId ? (program ? " · program" : " · focused") : ""}
          {itemWindow?.truncated && !focusId ? ` · range ${range.from} to ${range.to}` : ""}
        </span>
        {/* Offered for a tracker, and whenever the route already says
            "neighborhood": a capped response can lose the parent edges, and the
            way back to the program must not go with them. */}
        {focusId && (focusProgram || focusScope === "neighborhood") ? (
          <div className="toggle-group graph-scope-controls">
            <span className="toggle-label">view</span>
            {([
              ["program", "Program"],
              ["neighborhood", "Neighborhood"],
            ] as Array<[GraphFocusScope, string]>).map(([scope, label]) => (
              <button key={scope} type="button" className={`toggle${focusScope === scope ? " toggle-on" : ""}`} aria-pressed={focusScope === scope} data-focus-scope={scope} onClick={() => onFocusScopeChange(scope)}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {foldedControls ? null : viewControls}
        {!focusId && edgeTypes.length > 0 ? (
          <div className="toggle-group graph-type-toggles">
            <span className="toggle-label">edges</span>
            {edgeTypes.map((type) => (
              <button key={type} type="button" className={`toggle${typeShown(type) ? " toggle-on" : ""}`} aria-pressed={typeShown(type)} data-edge-type={type} onClick={() => toggleType(type)}>
                {type}
              </button>
            ))}
          </div>
        ) : null}
        {!focusId && showMentions && edgeTypes.includes("mentions") && (
          <div className="toggle-group">
            <span className="toggle-label">mentions of</span>
            {([
              ["all", "all"],
              ["issue", "issues"],
              ["change_request", "change requests"],
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
      {foldedControls && controlsSlot ? createPortal(viewControls, controlsSlot) : null}
      {focusId && focusLoadStatus !== "idle" ? (
        <p className={`graph-focus-load graph-focus-load-${focusLoadStatus}`} role={focusLoadStatus === "fallback" ? "status" : undefined}>
          {focusLoadStatus === "loading"
            ? program
              ? "Loading program…"
              : `Loading relationship history up to ${focusDepth} ${focusDepth === 1 ? "hop" : "hops"}…`
            : focusLoadStatus === "ready" && focusNeighborhood
              ? `${program ? "program" : `${focusNeighborhood.reached_depth}/${focusNeighborhood.requested_depth} hops`} · ${view.nodes.length} nodes · ${view.links.length} links${focusNeighborhood.complete ? " · complete" : ` · limited by ${focusNeighborhood.limit_reasons.join(", ")}`}`
              : focusLoadMessage}
        </p>
      ) : null}
      {/* The tracker is the program view's header, not one of its nodes. */}
      {focusId && program && focusProgram ? (
        <div className="graph-program-head">
          <span className="graph-program-kicker muted">program</span>
          {trackerItem?.url ? (
            <ExternalLink className="graph-program-title" href={trackerItem.url} target="_blank" rel="noopener noreferrer">
              {trackerItem.title ?? focusId}
            </ExternalLink>
          ) : (
            <span className="graph-program-title">{trackerItem?.title ?? focusId.split("|").pop()}</span>
          )}
          {trackerItem ? <Badge text={trackerItem.state} kind={trackerItem.state} /> : null}
          <span className="graph-program-progress">
            {focusProgram.done}/{focusProgram.total} done
          </span>
          {([
            ["ready", focusProgram.ready.length],
            ["in_review", focusProgram.inReview.length],
            ["blocked", focusProgram.blocked],
          ] as Array<[ProgramChildStatus, number]>).map(([status, count]) =>
            count > 0 ? (
              <span key={status} className="graph-program-count">
                {count} <ProgramStatusMark status={status} />
              </span>
            ) : null,
          )}
          {program.blocks.cyclic ? (
            <span className="graph-program-note muted">the blocks links form a cycle, so all {program.blocks.total} are drawn</span>
          ) : program.blocks.drawn < program.blocks.total ? (
            <span className="graph-program-note muted">
              {program.blocks.drawn} of {program.blocks.total} blocks links drawn; the rest follow from them
            </span>
          ) : null}
          {programFacetsIgnored ? <span className="graph-program-note muted">item filters do not apply to a program</span> : null}
        </div>
      ) : null}
      {/* The legend + hint is read-only orientation, so it rides inside the
          StatsBar's collapsible region — tucked away with the stats on narrow,
          shown after the stats on desktop. */}
      <StatsBar
        scoped={scopedStats}
        totalLabel="nodes"
        edgeLabel="links"
        headline={focusHeadline}
        footer={
          <div className="graph-legend">
            {NODE_LEGEND.map((x) => (
              <span key={x.t}>
                <span className="dot" style={{ background: x.c }} />
                {x.t}
              </span>
            ))}
            {/* One key per relation type on the canvas; closes carries the
                lifecycle colours, and the program view adds its status markers. */}
            {legendTypes.map((type) =>
              type === "closes" ? (
                <span key={type} className="graph-legend-edge" data-edge-type={type}>
                  closes
                  {LIFECYCLE_LEGEND.map((lifecycle) => (
                    <span key={lifecycle} className="graph-legend-lifecycle">
                      <EdgeSwatch type={type} stroke={`var(--${lifecycle})`} />
                      {lifecycle}
                    </span>
                  ))}
                </span>
              ) : (
                <span key={type} className="graph-legend-edge" data-edge-type={type}>
                  <EdgeSwatch type={type} />
                  {type}
                </span>
              ),
            )}
            {program
              ? PROGRAM_STATUSES.map((status) => (
                  <span key={status} className="graph-legend-status">
                    <ProgramStatusMark status={status} />
                  </span>
                ))
              : null}
            <span className="muted">· size = demand · hover to highlight · click to focus · title → provider</span>
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
              <div className="graph-canvas" ref={canvasRef}>
                {/* Re-clicking the focused node clears focus — the same toggle
                    exit as the side list's active card. */}
                {view.links.length === 0 && !program ? (
                  <GraphCanvasEmptyState
                    reason={inFocus ? null : graphCanvasEmptyReason(overview, overviewOptions)}
                    onShowMentions={() => {
                      // Also reset the target: it persists while mentions are off,
                      // so a stale non-"all" target could keep the canvas empty
                      // even after enabling mentions.
                      setMentionTarget("all");
                      setShowMentions(true);
                    }}
                    onShowAllMentions={() => setMentionTarget("all")}
                    onShowAllTypes={() => setHiddenTypes(new Set())}
                  />
                ) : (
                  <Flow key={flowKey} paneWidth={canvasWidth} rfNodes={rfNodes} rfEdges={rfEdges} focusId={focusId} showEdgeLabels={inFocus && !program} onNodeActivate={(id) => onFocusChange(id === focusId ? null : id)} theme={theme} />
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
