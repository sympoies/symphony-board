import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import { Badge } from "./Badge.tsx";
import { buildGraph, cutoffIso, type GraphNode, type GraphLink, type ResolvedEdge } from "../model.ts";

// React Flow renders each node as real HTML, so a node can be a card showing the
// repo / #iid / state — not just a label. closes edges (issue <-> PR/MR) are
// solid; opt-in mentions are thin dashed. Layout is computed (RF ships none):
// dagre for the hierarchy view, d3-force for the knowledge-graph view.

const KIND_ICON: Record<string, string> = { issue: "◇", change_request: "⇄", unknown: "•" };
const NODE_W = 200;
const NODE_H = 78;

const NODE_LEGEND = [
  { c: "#addb67", t: "open" },
  { c: "#c792ea", t: "closed" },
  { c: "#7e57c2", t: "merged" },
  { c: "#637777", t: "untracked" },
];

function ItemNode({ data }: NodeProps) {
  const d = data as unknown as GraphNode;
  return (
    <div className={`rf-node${d.untracked ? " rf-node-untracked" : ""}`} style={{ borderLeftColor: d.color }} title={d.label}>
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

function layoutDagre(nodes: GraphNode[], links: GraphLink[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 30, ranksep: 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const l of links) if (g.hasNode(l.source) && g.hasNode(l.target)) g.setEdge(l.source, l.target);
  dagre.layout(g);
  const m = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    m.set(n.id, { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 });
  }
  return m;
}

type SimNode = SimulationNodeDatum & { id: string };
function layoutForce(nodes: GraphNode[], links: GraphLink[]): Map<string, { x: number; y: number }> {
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
    .force("collide", forceCollide(120))
    .stop();
  for (let i = 0; i < 320; i++) sim.tick();
  const m = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) m.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  return m;
}

// The RF canvas is keyed by the parent so a layout/filter change remounts it and
// re-fits; that keeps drag state simple (local, reset on filter change).
function Flow({ rfNodes, rfEdges }: { rfNodes: Node[]; rfEdges: Edge[] }) {
  const [nodes, , onNodesChange] = useNodesState(rfNodes);
  const [edges, , onEdgesChange] = useEdgesState(rfEdges);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
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

export function GraphPage({ edges }: { edges: ResolvedEdge[] }) {
  const [since, setSince] = useState<string>(() => cutoffIso(90).slice(0, 10));
  const [layout, setLayout] = useState<"force" | "hierarchy">("force");
  const [showMentions, setShowMentions] = useState(false);

  const graph = useMemo(() => {
    const cutoff = since ? new Date(since + "T00:00:00Z").toISOString() : null;
    const visible = showMentions ? edges : edges.filter((re) => re.edge.type !== "mentions");
    return buildGraph(visible, cutoff);
  }, [edges, since, showMentions]);

  const positions = useMemo(
    () => (layout === "hierarchy" ? layoutDagre(graph.nodes, graph.links) : layoutForce(graph.nodes, graph.links)),
    [graph, layout],
  );

  const rfNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: "item",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: n as unknown as Record<string, unknown>,
      })),
    [graph, positions],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      graph.links.map((l) => ({
        id: l.id,
        source: l.source,
        target: l.target,
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

  const flowKey = `${layout}|${showMentions}|${since}|${graph.nodes.length}`;

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
        <div className="graph-legend">
          {NODE_LEGEND.map((x) => (
            <span key={x.t}>
              <span className="dot" style={{ background: x.c }} />
              {x.t}
            </span>
          ))}
          <span className="muted">· solid = closes · dashed = mentions</span>
        </div>
      </div>
      {graph.links.length === 0 ? (
        <p className="empty">No relationships in this window — widen the “active since” date.</p>
      ) : (
        <div className="graph-canvas">
          <Flow key={flowKey} rfNodes={rfNodes} rfEdges={rfEdges} />
        </div>
      )}
    </section>
  );
}
