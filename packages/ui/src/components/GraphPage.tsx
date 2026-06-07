import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import { buildGraph, cutoffIso, type ResolvedEdge } from "../model.ts";

// Phase 1: render the existing `closes` edges (issue <-> PR/MR) as a graph.
// The contract's edge type is open (relates / blocks / parent / child …); once a
// source emits those they flow into the same graph with no change here.

const NODE_LEGEND = [
  { c: "#addb67", t: "open" },
  { c: "#c792ea", t: "closed" },
  { c: "#7e57c2", t: "merged" },
  { c: "#637777", t: "untracked" },
];
const EDGE_LEGEND = [
  { c: "#ffcb6b", t: "declared" },
  { c: "#addb67", t: "fulfilled" },
  { c: "#f78c6c", t: "broken" },
];

function layoutOf(name: "cose" | "breadthfirst"): cytoscape.LayoutOptions {
  if (name === "breadthfirst") {
    return { name: "breadthfirst", directed: true, padding: 30, spacingFactor: 1.75 } as cytoscape.LayoutOptions;
  }
  // generous spacing so labels (drawn below nodes) don't collide; componentSpacing
  // pushes the many disconnected 1:1 pairs apart.
  return {
    name: "cose",
    animate: false,
    padding: 30,
    nodeRepulsion: () => 20000,
    idealEdgeLength: () => 130,
    componentSpacing: 150,
    nodeOverlap: 24,
    gravity: 0.15,
  } as cytoscape.LayoutOptions;
}

export function GraphPage({ edges }: { edges: ResolvedEdge[] }) {
  // default time window: 3 months. The computed cutoff date is carried straight
  // into the date input so the active value is visible.
  const [since, setSince] = useState<string>(() => cutoffIso(90).slice(0, 10));
  const [layout, setLayout] = useState<"cose" | "breadthfirst">("cose");
  const [showMentions, setShowMentions] = useState(false); // mentions are dense/noisy — opt in
  const containerRef = useRef<HTMLDivElement>(null);

  const graph = useMemo(() => {
    const cutoff = since ? new Date(since + "T00:00:00Z").toISOString() : null;
    const visible = showMentions ? edges : edges.filter((re) => re.edge.type !== "mentions");
    return buildGraph(visible, cutoff);
  }, [edges, since, showMentions]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || graph.links.length === 0) return;
    const cy = cytoscape({
      container: el,
      elements: [
        ...graph.nodes.map((n) => ({
          data: {
            id: n.id,
            label: n.label.length > 34 ? n.label.slice(0, 34) + "…" : n.label,
            kind: n.kind,
            color: n.color,
            url: n.url,
            untracked: String(n.untracked),
          },
        })),
        ...graph.links.map((l) => ({ data: { id: l.id, source: l.source, target: l.target, color: l.color, type: l.type } })),
      ],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(label)",
            color: "#d6deeb",
            "font-size": "10px",
            "text-wrap": "wrap",
            "text-max-width": "110px",
            "text-valign": "bottom",
            "text-margin-y": 4,
            // a panel-coloured plate behind the label keeps it legible even when
            // two labels still graze each other; labels fade out when zoomed far
            // out so a fit-view isn't a wall of text.
            "text-background-color": "#0c2340",
            "text-background-opacity": 0.72,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "min-zoomed-font-size": 7,
            width: 14,
            height: 14,
          },
        },
        { selector: 'node[kind = "change_request"]', style: { shape: "round-rectangle" } },
        { selector: 'node[untracked = "true"]', style: { "border-width": 1, "border-color": "#637777", "border-style": "dashed" } },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "data(color)",
            "target-arrow-color": "data(color)",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.8,
            "curve-style": "bezier",
          },
        },
        // mentions are noisier than closes — render thinner + dashed + faded
        { selector: 'edge[type = "mentions"]', style: { width: 1, "line-style": "dashed", opacity: 0.6 } },
      ],
      layout: layoutOf(layout),
      wheelSensitivity: 0.2,
    });
    cy.on("tap", "node", (e) => {
      const url = e.target.data("url");
      if (url) window.open(url, "_blank", "noreferrer");
    });
    return () => cy.destroy();
  }, [graph, layout]);

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
          <button type="button" className={`toggle${layout === "cose" ? " toggle-on" : ""}`} onClick={() => setLayout("cose")}>
            Force
          </button>
          <button
            type="button"
            className={`toggle${layout === "breadthfirst" ? " toggle-on" : ""}`}
            onClick={() => setLayout("breadthfirst")}
          >
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
          <span className="muted">·</span>
          {EDGE_LEGEND.map((x) => (
            <span key={x.t}>
              <span className="dot" style={{ background: x.c }} />
              {x.t}
            </span>
          ))}
        </div>
      </div>
      {graph.links.length === 0 ? (
        <p className="empty">No relationships in this window — widen the “active since” date.</p>
      ) : (
        <div className="graph-canvas" ref={containerRef} />
      )}
    </section>
  );
}
