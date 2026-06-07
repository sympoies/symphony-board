import { useMemo, useState, type CSSProperties } from "react";
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
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import { Badge } from "./Badge.tsx";
import { buildGraph, cutoffIso, relativeTime, type GraphNode, type GraphLink, type ResolvedEdge } from "../model.ts";

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
// fit), and each node card carries created / updated (relative) + demand —
// legible once focused/zoomed.

const KIND_ICON: Record<string, string> = { issue: "◇", change_request: "⇄", unknown: "•" };
const NODE_W = 200;
// Tall enough for head + two-line title + repo + the created/updated/demand
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
      style={{ borderLeftColor: d.color, fontSize: `${(11 * scale).toFixed(1)}px` }}
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
          {d.created_at ? <span title={d.created_at}>created {relativeTime(d.created_at)}</span> : null}
          {d.updated_at ? <span title={d.updated_at}>updated {relativeTime(d.updated_at)}</span> : null}
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

// Searchable list beside the canvas: click an entry to pan + zoom the graph onto
// that node. Sorted by demand (busiest first), mirroring the node-size cue. It
// drives the camera through React Flow's fitView, so it must render INSIDE a
// <ReactFlowProvider> shared with the canvas.
function GraphSideList({ nodes }: { nodes: GraphNode[] }) {
  const rf = useReactFlow();
  const [q, setQ] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = needle
      ? nodes.filter((n) => `${n.label} ${n.repo ?? ""} ${n.iid != null ? "#" + n.iid : ""}`.toLowerCase().includes(needle))
      : nodes.slice();
    return match.sort((a, b) => (b.demand ?? 0) - (a.demand ?? 0) || a.label.localeCompare(b.label));
  }, [nodes, q]);

  function focus(id: string) {
    setActiveId(id);
    // Pan + zoom to the single node with a readable cap and a smooth glide. The
    // default view stays the full-graph fit (the <ReactFlow fitView> prop).
    rf.fitView({ nodes: [{ id }], padding: 0.5, minZoom: 0.5, maxZoom: 1.5, duration: 600 });
  }

  return (
    <aside className="graph-list">
      <input
        className="graph-list-search"
        type="search"
        placeholder="filter items…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="graph-list-scroll">
        {filtered.length === 0 ? (
          <p className="muted empty-list">no items match</p>
        ) : (
          filtered.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`graph-list-item${activeId === n.id ? " active" : ""}${n.untracked ? " untracked" : ""}`}
              style={{ borderLeftColor: n.color }}
              onClick={() => focus(n.id)}
              title={n.label}
            >
              <span className="gli-head">
                <span className="kind">{KIND_ICON[n.kind] ?? "•"}</span>
                <Badge text={n.state} kind={n.state} />
                {n.demand != null && n.demand > 0 ? (
                  <span className="gli-demand muted" title="comments + reactions">
                    <DemandIcon /> {n.demand}
                  </span>
                ) : null}
              </span>
              <span className="gli-title">{n.label}</span>
              <span className="gli-repo muted">
                {n.repo ?? "untracked"}
                {n.iid != null ? ` #${n.iid}` : ""}
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

export function GraphPage({ edges }: { edges: ResolvedEdge[] }) {
  const [since, setSince] = useState<string>(() => cutoffIso(90).slice(0, 10));
  const [layout, setLayout] = useState<"force" | "hierarchy">("force");
  const [showMentions, setShowMentions] = useState(false);
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
        return {
          id: n.id,
          type: "item",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          style: { width: w, height: h },
          data: n as unknown as Record<string, unknown>,
        };
      }),
    [graph, positions, dimOf],
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
            <GraphSideList nodes={graph.nodes} />
            <div className="graph-canvas">
              <Flow key={flowKey} rfNodes={rfNodes} rfEdges={rfEdges} />
            </div>
          </div>
        </ReactFlowProvider>
      )}
    </section>
  );
}
