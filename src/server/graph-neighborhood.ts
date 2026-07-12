// Bounded canonical-history graph neighbourhood for focused Graph inspection.
// This is an operational read-only API, separate from ContractEnvelope: range
// responses stay small while a focused item can inspect older live relations.

import type { ServerResponse } from "node:http";
import type { EdgeDTO, ItemDTO } from "@symphony-board/contract";
import type { AppConfig } from "../config.ts";
import { configuredRepoRefs } from "../config.ts";
import { mapRows } from "../contract/build.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";
import type { EdgeRow, ItemRow, LabelRow, SourceRow } from "../db/store.ts";

export const GRAPH_NEIGHBORHOOD_DEFAULT_DEPTH = 5;
export const GRAPH_NEIGHBORHOOD_MAX_DEPTH = 5;
export const GRAPH_NEIGHBORHOOD_MAX_NODES = 200;
export const GRAPH_NEIGHBORHOOD_MAX_EDGES = 500;

export interface GraphNeighborhoodOptions {
  focusRef: string;
  depth: number;
}

export type GraphNeighborhoodLimitReason = "depth" | "nodes" | "edges";

export interface GraphNeighborhoodNode {
  ref: string;
  hop: number;
  item: ItemDTO | null;
}

export interface GraphNeighborhoodResponse {
  schema: "symphony-board-graph-neighborhood/1";
  generated_at: string;
  focus_ref: string;
  requested_depth: number;
  reached_depth: number;
  complete: boolean;
  limit_reasons: GraphNeighborhoodLimitReason[];
  limits: {
    max_depth: number;
    max_nodes: number;
    max_edges: number;
  };
  counts: {
    nodes: number;
    edges: number;
  };
  nodes: GraphNeighborhoodNode[];
  edges: EdgeDTO[];
}

export interface BuildGraphNeighborhoodInput {
  sources: SourceRow[];
  items: ItemRow[];
  labels: LabelRow[];
  edges: EdgeRow[];
  generatedAt: string;
  configuredRepos?: ReadonlyArray<{ source_id: string; project_path: string }>;
  focusRef: string;
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export class GraphNeighborhoodNotFoundError extends Error {}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function edgeKey(edge: EdgeDTO): string {
  return JSON.stringify([edge.type, edge.from, edge.to]);
}

function compareEdges(a: EdgeDTO, b: EdgeDTO): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type);
}

function otherRef(edge: EdgeDTO, ref: string): string | null {
  if (edge.from === ref) return edge.to;
  if (edge.to === ref) return edge.from;
  return null;
}

export function parseGraphNeighborhoodOptions(url: URL): GraphNeighborhoodOptions {
  const focusRef = url.searchParams.get("ref")?.trim() ?? "";
  if (!focusRef) throw new Error("ref is required");
  const rawDepth = url.searchParams.get("depth");
  const depth = rawDepth == null || rawDepth === "" ? GRAPH_NEIGHBORHOOD_DEFAULT_DEPTH : Number(rawDepth);
  if (!Number.isInteger(depth) || depth < 1 || depth > GRAPH_NEIGHBORHOOD_MAX_DEPTH) {
    throw new Error(`depth must be an integer from 1 to ${GRAPH_NEIGHBORHOOD_MAX_DEPTH}`);
  }
  return { focusRef, depth };
}

// Traverse as undirected for neighbourhood membership, but return the original
// directed edge DTOs. Nodes/edges are deterministic: refs and DTO keys break all
// ties, and spanning-tree edges are retained before induced extras so a safety
// edge cap cannot disconnect nearer nodes in normal production limits.
export function buildGraphNeighborhood(input: BuildGraphNeighborhoodInput): GraphNeighborhoodResponse {
  const depth = input.depth ?? GRAPH_NEIGHBORHOOD_DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > GRAPH_NEIGHBORHOOD_MAX_DEPTH) {
    throw new Error(`depth must be an integer from 1 to ${GRAPH_NEIGHBORHOOD_MAX_DEPTH}`);
  }
  const maxNodes = positiveLimit(input.maxNodes, GRAPH_NEIGHBORHOOD_MAX_NODES);
  const maxEdges = positiveLimit(input.maxEdges, GRAPH_NEIGHBORHOOD_MAX_EDGES);
  const mapped = mapRows({
    sources: input.sources,
    items: input.items,
    labels: input.labels,
    edges: input.edges,
    generatedAt: input.generatedAt,
    configuredRepos: input.configuredRepos,
  });
  const edges = [...mapped.edges].sort(compareEdges);
  const byRef = new Map(mapped.items.map((item) => [item.id, item]));
  const incident = new Map<string, EdgeDTO[]>();
  for (const edge of edges) {
    for (const ref of edge.from === edge.to ? [edge.from] : [edge.from, edge.to]) {
      const list = incident.get(ref) ?? [];
      list.push(edge);
      incident.set(ref, list);
    }
  }
  if (!byRef.has(input.focusRef) && !incident.has(input.focusRef)) {
    throw new GraphNeighborhoodNotFoundError(`focus ref not found: ${input.focusRef}`);
  }

  const hops = new Map<string, number>([[input.focusRef, 0]]);
  const queue = [input.focusRef];
  const treeEdgeKeys = new Set<string>();
  const reasons = new Set<GraphNeighborhoodLimitReason>();
  let cursor = 0;
  while (cursor < queue.length) {
    const ref = queue[cursor++]!;
    const hop = hops.get(ref)!;
    const neighbours = (incident.get(ref) ?? [])
      .map((edge) => ({ edge, other: otherRef(edge, ref) }))
      .filter((entry): entry is { edge: EdgeDTO; other: string } => entry.other !== null)
      .sort((a, b) => a.other.localeCompare(b.other) || compareEdges(a.edge, b.edge));
    for (const { edge, other } of neighbours) {
      if (hops.has(other)) continue;
      const nextHop = hop + 1;
      if (nextHop > depth) {
        reasons.add("depth");
        continue;
      }
      if (hops.size >= maxNodes) {
        reasons.add("nodes");
        continue;
      }
      hops.set(other, nextHop);
      queue.push(other);
      treeEdgeKeys.add(edgeKey(edge));
    }
  }

  const induced = edges.filter((edge) => hops.has(edge.from) && hops.has(edge.to));
  const edgeDistance = (edge: EdgeDTO): number => Math.max(hops.get(edge.from) ?? 0, hops.get(edge.to) ?? 0);
  const treeEdges = induced
    .filter((edge) => treeEdgeKeys.has(edgeKey(edge)))
    .sort((a, b) => edgeDistance(a) - edgeDistance(b) || compareEdges(a, b));
  const extraEdges = induced
    .filter((edge) => !treeEdgeKeys.has(edgeKey(edge)))
    .sort((a, b) => edgeDistance(a) - edgeDistance(b) || compareEdges(a, b));
  const selectedEdges = [...treeEdges, ...extraEdges].slice(0, maxEdges);
  if (selectedEdges.length < induced.length) reasons.add("edges");

  const nodes = [...hops.entries()]
    .map(([ref, hop]) => ({ ref, hop, item: byRef.get(ref) ?? null }))
    .sort((a, b) => a.hop - b.hop || a.ref.localeCompare(b.ref));
  const limitReasons = (["depth", "nodes", "edges"] as const).filter((reason) => reasons.has(reason));
  return {
    schema: "symphony-board-graph-neighborhood/1",
    generated_at: input.generatedAt,
    focus_ref: input.focusRef,
    requested_depth: depth,
    reached_depth: Math.max(0, ...nodes.map((node) => node.hop)),
    complete: limitReasons.length === 0,
    limit_reasons: limitReasons,
    limits: {
      max_depth: GRAPH_NEIGHBORHOOD_MAX_DEPTH,
      max_nodes: maxNodes,
      max_edges: maxEdges,
    },
    counts: { nodes: nodes.length, edges: selectedEdges.length },
    nodes,
    edges: selectedEdges,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

export async function graphNeighborhoodProjection(
  cfg: AppConfig,
  options: GraphNeighborhoodOptions,
): Promise<GraphNeighborhoodResponse> {
  const store = await openConfiguredStoreReadOnly(cfg);
  try {
    return buildGraphNeighborhood({
      sources: await store.listSources(),
      items: await store.listLiveItems(),
      labels: await store.listLabels(),
      edges: await store.listLiveEdges(),
      generatedAt: new Date().toISOString(),
      configuredRepos: configuredRepoRefs(cfg),
      focusRef: options.focusRef,
      depth: options.depth,
    });
  } finally {
    await store.close();
  }
}

export async function handleGraphNeighborhoodRequest(cfg: AppConfig, url: URL, res: ServerResponse): Promise<void> {
  let options: GraphNeighborhoodOptions;
  try {
    options = parseGraphNeighborhoodOptions(url);
  } catch (error) {
    json(res, 400, {
      error: "invalid_graph_neighborhood",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    json(res, 200, await graphNeighborhoodProjection(cfg, options));
  } catch (error) {
    if (error instanceof GraphNeighborhoodNotFoundError) {
      json(res, 404, { error: "graph_focus_not_found", message: error.message });
      return;
    }
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
}
