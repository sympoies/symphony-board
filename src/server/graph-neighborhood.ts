// Bounded canonical-history graph neighbourhood for focused Graph inspection.
// This is an operational read-only API, separate from ContractEnvelope: range
// responses stay small while a focused item can inspect older live relations.
// It serves two scopes in one response shape: the ordinary neighbourhood of any
// item, and the program of a tracker (its children, what blocks them, and what
// closes them).

import type { ServerResponse } from "node:http";
import type { EdgeDTO, ItemDTO } from "@symphony-board/contract";
import type { AppConfig } from "../config.ts";
import { configuredRepoRefs } from "../config.ts";
import { mapRows } from "../contract/build.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";
import type { EdgeRow, ItemRow, LabelRow, SourceRow, Store } from "../db/store.ts";
import { sendJsonMaybeGzip } from "./http.ts";

export const GRAPH_NEIGHBORHOOD_DEFAULT_DEPTH = 1;
export const GRAPH_NEIGHBORHOOD_MAX_DEPTH = 5;
export const GRAPH_NEIGHBORHOOD_MAX_NODES = 200;
export const GRAPH_NEIGHBORHOOD_MAX_EDGES = 500;
// A program scope is a fixed two-hop projection: tracker, children, then the
// items that close or block a child.
export const GRAPH_PROGRAM_DEPTH = 2;
// Edge rows a program read may scan before it keeps only program edge types, so
// the mentions on a program's children cannot crowd out its structure.
const GRAPH_PROGRAM_MAX_EDGE_READS = 4 * GRAPH_NEIGHBORHOOD_MAX_EDGES;

export interface GraphNeighborhoodOptions {
  focusRef: string;
  depth: number;
  mentionMode: GraphNeighborhoodMentionMode;
  scope: GraphNeighborhoodScope;
}

export type GraphNeighborhoodMentionMode = "all" | "direct";

export type GraphNeighborhoodScope = "neighborhood" | "program";

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
  mentionMode?: GraphNeighborhoodMentionMode;
  maxNodes?: number;
  maxEdges?: number;
}

export type BuildGraphProgramInput = Omit<BuildGraphNeighborhoodInput, "depth" | "mentionMode">;

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

function splitRef(ref: string): { sourceId: string; externalId: string } | null {
  const separator = ref.indexOf("|");
  if (separator <= 0 || separator === ref.length - 1) return null;
  return { sourceId: ref.slice(0, separator), externalId: ref.slice(separator + 1) };
}

function rowRef(sourceId: string, externalId: string): string {
  return `${sourceId}|${externalId}`;
}

function edgeRowKey(edge: EdgeRow): string {
  return JSON.stringify([edge.type, edge.from_source_id, edge.from_external_id, edge.to_source_id, edge.to_external_id]);
}

export function parseGraphNeighborhoodOptions(url: URL): GraphNeighborhoodOptions {
  const focusRef = url.searchParams.get("ref")?.trim() ?? "";
  if (!focusRef) throw new Error("ref is required");
  const rawDepth = url.searchParams.get("depth");
  const depth = rawDepth == null || rawDepth === "" ? GRAPH_NEIGHBORHOOD_DEFAULT_DEPTH : Number(rawDepth);
  if (!Number.isInteger(depth) || depth < 1 || depth > GRAPH_NEIGHBORHOOD_MAX_DEPTH) {
    throw new Error(`depth must be an integer from 1 to ${GRAPH_NEIGHBORHOOD_MAX_DEPTH}`);
  }
  const rawMentionMode = url.searchParams.get("mentions")?.trim() || "all";
  if (rawMentionMode !== "all" && rawMentionMode !== "direct") {
    throw new Error('mentions must be "all" or "direct"');
  }
  const rawScope = url.searchParams.get("scope")?.trim() || "neighborhood";
  if (rawScope !== "neighborhood" && rawScope !== "program") {
    throw new Error('scope must be "neighborhood" or "program"');
  }
  return { focusRef, depth, mentionMode: rawMentionMode, scope: rawScope };
}

// Traverse as undirected for neighbourhood membership, but return the original
// directed edge DTOs. Nodes/edges are deterministic: refs and DTO keys break all
// ties, and spanning-tree edges are retained before induced extras so a safety
// edge cap cannot disconnect nearer nodes in normal production limits.
export function buildGraphNeighborhood(input: BuildGraphNeighborhoodInput): GraphNeighborhoodResponse {
  const depth = input.depth ?? GRAPH_NEIGHBORHOOD_DEFAULT_DEPTH;
  const mentionMode = input.mentionMode ?? "all";
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
  const traversalEdges = mentionMode === "all" ? edges : edges.filter((edge) => edge.type !== "mentions");
  const byRef = new Map(mapped.items.map((item) => [item.id, item]));
  const incident = new Map<string, EdgeDTO[]>();
  for (const edge of traversalEdges) {
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

  // Mentions are useful immediate context but poor multi-hop topology: a single
  // highly referenced issue can connect most of the store in two hops. The UI's
  // direct mode therefore adds mentions incident to the focus as hop-1 leaves
  // after structural traversal; those leaves never enter the BFS frontier.
  if (mentionMode === "direct") {
    for (const edge of edges) {
      if (edge.type !== "mentions") continue;
      const other = otherRef(edge, input.focusRef);
      if (other === null) continue;
      if (!hops.has(other)) {
        if (hops.size >= maxNodes) {
          reasons.add("nodes");
          continue;
        }
        hops.set(other, 1);
      }
      treeEdgeKeys.add(edgeKey(edge));
    }
  }

  const eligibleEdges = mentionMode === "all"
    ? edges
    : edges.filter((edge) => edge.type !== "mentions" || edge.from === input.focusRef || edge.to === input.focusRef);
  const induced = eligibleEdges.filter((edge) => hops.has(edge.from) && hops.has(edge.to));
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

// The program of a tracker: its children (the targets of its `parent` edges),
// every `blocks` edge into a child, and every `closes` edge into a child. A
// blocker outside the program is kept because it decides a child's status.
// Structure wins under the caps: children are cut in ref order, then edges are
// kept as parent, blocks among children, closes, outside blockers. An item
// beyond the children is returned only with an edge that reaches it. An item
// without children is returned alone.
export function buildGraphProgram(input: BuildGraphProgramInput): GraphNeighborhoodResponse {
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
  const focusRef = input.focusRef;
  if (!byRef.has(focusRef) && !edges.some((edge) => edge.from === focusRef || edge.to === focusRef)) {
    throw new GraphNeighborhoodNotFoundError(`focus ref not found: ${focusRef}`);
  }

  const reasons = new Set<GraphNeighborhoodLimitReason>();
  const parentEdges = edges.filter((edge) => edge.type === "parent" && edge.from === focusRef && edge.to !== focusRef);
  const childRefs = [...new Set(parentEdges.map((edge) => edge.to))];
  if (childRefs.length > maxNodes - 1) reasons.add("nodes");
  const hops = new Map<string, number>([[focusRef, 0]]);
  for (const ref of childRefs.slice(0, maxNodes - 1)) hops.set(ref, 1);
  const isChild = (ref: string): boolean => hops.get(ref) === 1;

  const intoChild = (type: string) => edges.filter((edge) => edge.type === type && isChild(edge.to) && edge.from !== edge.to);
  const candidates = [
    ...parentEdges.filter((edge) => isChild(edge.to)),
    ...intoChild("blocks").filter((edge) => isChild(edge.from)),
    ...intoChild("closes"),
    ...intoChild("blocks").filter((edge) => !isChild(edge.from)),
  ];
  const selectedEdges: EdgeDTO[] = [];
  for (const edge of candidates) {
    if (selectedEdges.length >= maxEdges) {
      reasons.add("edges");
      break;
    }
    if (!hops.has(edge.from)) {
      if (hops.size >= maxNodes) {
        reasons.add("nodes");
        continue;
      }
      hops.set(edge.from, GRAPH_PROGRAM_DEPTH);
    }
    selectedEdges.push(edge);
  }
  const reached = new Set<string>([focusRef]);
  for (const edge of selectedEdges) reached.add(edge.from).add(edge.to);

  const nodes = [...hops.entries()]
    .filter(([ref]) => reached.has(ref))
    .map(([ref, hop]) => ({ ref, hop, item: byRef.get(ref) ?? null }))
    .sort((a, b) => a.hop - b.hop || a.ref.localeCompare(b.ref));
  const limitReasons = (["depth", "nodes", "edges"] as const).filter((reason) => reasons.has(reason));
  return {
    schema: "symphony-board-graph-neighborhood/1",
    generated_at: input.generatedAt,
    focus_ref: focusRef,
    requested_depth: GRAPH_PROGRAM_DEPTH,
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

function configuredRepoKey(sourceId: string, projectPath: string): string {
  return JSON.stringify([sourceId, projectPath]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("graph neighborhood request aborted", "AbortError");
}

// The focus must be a live item in a configured repo; both scopes start here.
async function readGraphFocus(cfg: AppConfig, focusRef: string, snapshot: Store, signal?: AbortSignal) {
  throwIfAborted(signal);
  const focus = splitRef(focusRef);
  if (!focus) throw new GraphNeighborhoodNotFoundError(`focus ref not found: ${focusRef}`);
  const configuredRepos = configuredRepoRefs(cfg);
  const configuredRepoKeys = new Set(configuredRepos.map((repo) => configuredRepoKey(repo.source_id, repo.project_path)));
  const configuredSourceIds = new Set(configuredRepos.map((repo) => repo.source_id));
  if (!configuredSourceIds.has(focus.sourceId)) {
    throw new GraphNeighborhoodNotFoundError(`focus ref not found: ${focusRef}`);
  }

  const focusRows = await snapshot.listLiveItemsBySourceRefs(focus.sourceId, [focus.externalId]);
  throwIfAborted(signal);
  const focusRow = focusRows[0];
  if (!focusRow || !focusRow.project_path || !configuredRepoKeys.has(configuredRepoKey(focusRow.source_id, focusRow.project_path))) {
    throw new GraphNeighborhoodNotFoundError(`focus ref not found: ${focusRef}`);
  }
  return { focus, focusRow, configuredRepos, configuredRepoKeys, configuredSourceIds };
}

// Two bounded reads: the tracker's own edges name its children, then the
// children's edges carry what blocks and closes them.
async function readGraphProgramSnapshot(
  cfg: AppConfig,
  options: GraphNeighborhoodOptions,
  snapshot: Store,
  signal?: AbortSignal,
): Promise<GraphNeighborhoodResponse> {
  const { focus, focusRow, configuredRepos, configuredSourceIds } = await readGraphFocus(cfg, options.focusRef, snapshot, signal);
  const configured = (ref: string): { sourceId: string; externalId: string } | null => {
    const parsed = splitRef(ref);
    return parsed && configuredSourceIds.has(parsed.sourceId) ? parsed : null;
  };
  const bySource = (refs: Iterable<string>): Array<[string, string[]]> => {
    const grouped = new Map<string, string[]>();
    for (const ref of [...refs].sort()) {
      const parsed = configured(ref);
      if (!parsed) continue;
      const ids = grouped.get(parsed.sourceId) ?? [];
      ids.push(parsed.externalId);
      grouped.set(parsed.sourceId, ids);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  let edgeReadCapped = false;
  let nodeReadCapped = false;
  const focusPage = await snapshot.listLiveEdgesForSourceRefs(focus.sourceId, [focus.externalId], GRAPH_PROGRAM_MAX_EDGE_READS);
  throwIfAborted(signal);
  if (focusPage.truncated) edgeReadCapped = true;
  const parentRows = focusPage.rows.filter((edge) =>
    edge.type === "parent" && rowRef(edge.from_source_id, edge.from_external_id) === options.focusRef,
  );
  const allChildRefs = [...new Set(parentRows.map((edge) => rowRef(edge.to_source_id, edge.to_external_id)))]
    .filter((ref) => ref !== options.focusRef && configured(ref))
    .sort();
  if (allChildRefs.length > GRAPH_NEIGHBORHOOD_MAX_NODES - 1) nodeReadCapped = true;
  const childRefs = new Set(allChildRefs.slice(0, GRAPH_NEIGHBORHOOD_MAX_NODES - 1));

  const edgeRows = parentRows.filter((edge) => childRefs.has(rowRef(edge.to_source_id, edge.to_external_id)));
  let remaining = GRAPH_PROGRAM_MAX_EDGE_READS;
  for (const [sourceId, externalIds] of bySource(childRefs)) {
    if (remaining <= 0) {
      edgeReadCapped = true;
      break;
    }
    const page = await snapshot.listLiveEdgesForSourceRefs(sourceId, externalIds, remaining);
    throwIfAborted(signal);
    remaining -= page.rows.length;
    edgeRows.push(...page.rows.filter((edge) =>
      (edge.type === "blocks" || edge.type === "closes") && childRefs.has(rowRef(edge.to_source_id, edge.to_external_id)),
    ));
    if (page.truncated) {
      edgeReadCapped = true;
      break;
    }
  }

  // A row in a repo the config no longer lists is dropped with its edges by
  // buildGraphProgram; a ref with no row at all stays as an untracked endpoint.
  const itemRefs = new Set<string>(childRefs);
  for (const edge of edgeRows) itemRefs.add(rowRef(edge.from_source_id, edge.from_external_id));
  itemRefs.delete(options.focusRef);
  const items: ItemRow[] = [focusRow];
  for (const [sourceId, externalIds] of bySource(itemRefs)) {
    items.push(...await snapshot.listLiveItemsBySourceRefs(sourceId, externalIds));
    throwIfAborted(signal);
  }

  const response = buildGraphProgram({
    sources: await snapshot.listSources(),
    items,
    labels: await snapshot.listLabelsByItemIds(items.map((item) => item.item_id)),
    edges: edgeRows,
    generatedAt: new Date().toISOString(),
    configuredRepos,
    focusRef: options.focusRef,
  });
  const reasons = new Set(response.limit_reasons);
  if (nodeReadCapped) reasons.add("nodes");
  if (edgeReadCapped) reasons.add("edges");
  return withLimitReasons(response, reasons);
}

// Report read-side truncation with the builder's own reasons, and drop the
// provider bodies the Graph never renders.
function withLimitReasons(response: GraphNeighborhoodResponse, reasons: ReadonlySet<GraphNeighborhoodLimitReason>): GraphNeighborhoodResponse {
  const limitReasons = (["depth", "nodes", "edges"] as const).filter((reason) => reasons.has(reason));
  return {
    ...response,
    complete: limitReasons.length === 0,
    limit_reasons: limitReasons,
    nodes: response.nodes.map((node) => {
      if (!node.item) return node;
      const { body: _body, ...item } = node.item;
      return { ...node, item: item as ItemDTO };
    }),
  };
}

async function readGraphNeighborhoodSnapshot(
  cfg: AppConfig,
  options: GraphNeighborhoodOptions,
  snapshot: Store,
  signal?: AbortSignal,
): Promise<GraphNeighborhoodResponse> {
  const { focusRow, configuredRepos, configuredRepoKeys, configuredSourceIds } = await readGraphFocus(cfg, options.focusRef, snapshot, signal);

  const itemsByRef = new Map<string, ItemRow>([[options.focusRef, focusRow]]);
  const allowedRefs = new Set<string>([options.focusRef]);
  const visitedRefs = new Set<string>();
  const edgesByKey = new Map<string, EdgeRow>();
  let frontier = [options.focusRef];
  let edgeReadCapped = false;

  // Read one frontier at a time through immutable-ref indexes. The +1 row is
  // a truncation sentinel; production work remains bounded even for an
  // invalid/depth-one focus in a very large store.
  for (let hop = 0; hop <= options.depth && frontier.length > 0; hop++) {
    throwIfAborted(signal);
    const grouped = new Map<string, string[]>();
    for (const ref of frontier.sort()) {
      if (visitedRefs.has(ref)) continue;
      visitedRefs.add(ref);
      const parsed = splitRef(ref);
      if (!parsed || !configuredSourceIds.has(parsed.sourceId)) continue;
      const refs = grouped.get(parsed.sourceId) ?? [];
      refs.push(parsed.externalId);
      grouped.set(parsed.sourceId, refs);
    }

    const frontierEdges: EdgeRow[] = [];
    for (const [sourceId, externalIds] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const remaining = GRAPH_NEIGHBORHOOD_MAX_EDGES + 1 - frontierEdges.length;
      if (remaining <= 0) {
        edgeReadCapped = true;
        break;
      }
      const page = await snapshot.listLiveEdgesForSourceRefs(
        sourceId,
        externalIds,
        remaining,
      );
      throwIfAborted(signal);
      frontierEdges.push(...page.rows);
      if (page.truncated) {
        edgeReadCapped = true;
        break;
      }
    }

    const eligibleFrontierEdges = options.mentionMode === "all"
      ? frontierEdges
      : frontierEdges.filter((edge) => edge.type !== "mentions" || hop === 0);
    const candidateRefs = new Set<string>();
    const traversalCandidateRefs = new Set<string>();
    for (const edge of eligibleFrontierEdges) {
      candidateRefs.add(rowRef(edge.from_source_id, edge.from_external_id));
      candidateRefs.add(rowRef(edge.to_source_id, edge.to_external_id));
      if (options.mentionMode === "all" || edge.type !== "mentions") {
        traversalCandidateRefs.add(rowRef(edge.from_source_id, edge.from_external_id));
        traversalCandidateRefs.add(rowRef(edge.to_source_id, edge.to_external_id));
      }
    }
    const candidatesBySource = new Map<string, string[]>();
    for (const ref of [...candidateRefs].sort()) {
      if (allowedRefs.has(ref)) continue;
      const parsed = splitRef(ref);
      if (!parsed || !configuredSourceIds.has(parsed.sourceId)) continue;
      const ids = candidatesBySource.get(parsed.sourceId) ?? [];
      ids.push(parsed.externalId);
      candidatesBySource.set(parsed.sourceId, ids);
    }
    const foundCandidateRefs = new Set<string>();
    const rejectedCandidateRefs = new Set<string>();
    for (const [sourceId, externalIds] of [...candidatesBySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const item of await snapshot.listLiveItemsBySourceRefs(sourceId, externalIds)) {
        const ref = rowRef(item.source_id, item.external_id);
        foundCandidateRefs.add(ref);
        if (item.project_path && configuredRepoKeys.has(configuredRepoKey(item.source_id, item.project_path))) {
          itemsByRef.set(ref, item);
          allowedRefs.add(ref);
        } else {
          rejectedCandidateRefs.add(ref);
        }
      }
      throwIfAborted(signal);
    }
    // Missing canonical rows are valid untracked endpoints as long as their
    // source remains configured. They may participate in traversal.
    for (const ref of candidateRefs) {
      const parsed = splitRef(ref);
      if (parsed && configuredSourceIds.has(parsed.sourceId) && !foundCandidateRefs.has(ref)) allowedRefs.add(ref);
    }

    for (const edge of eligibleFrontierEdges) {
      const from = rowRef(edge.from_source_id, edge.from_external_id);
      const to = rowRef(edge.to_source_id, edge.to_external_id);
      if (rejectedCandidateRefs.has(from) || rejectedCandidateRefs.has(to)) continue;
      if (!allowedRefs.has(from) || !allowedRefs.has(to)) continue;
      edgesByKey.set(edgeRowKey(edge), edge);
    }
    if (edgesByKey.size > GRAPH_NEIGHBORHOOD_MAX_EDGES) edgeReadCapped = true;

    frontier = [...traversalCandidateRefs]
      .filter((ref) => allowedRefs.has(ref) && !visitedRefs.has(ref))
      .sort()
      .slice(0, GRAPH_NEIGHBORHOOD_MAX_NODES + 1);
    if (edgeReadCapped) break;
  }

  throwIfAborted(signal);
  const items = [...itemsByRef.values()];
  const response = buildGraphNeighborhood({
    sources: await snapshot.listSources(),
    items,
    labels: await snapshot.listLabelsByItemIds(items.map((item) => item.item_id)),
    edges: [...edgesByKey.values()],
    generatedAt: new Date().toISOString(),
    configuredRepos,
    focusRef: options.focusRef,
    depth: options.depth,
    mentionMode: options.mentionMode,
  });
  const reasons = new Set(response.limit_reasons);
  if (edgeReadCapped) reasons.add("edges");
  return withLimitReasons(response, reasons);
}

async function loadGraphNeighborhoodProjection(
  cfg: AppConfig,
  options: GraphNeighborhoodOptions,
  signal?: AbortSignal,
): Promise<GraphNeighborhoodResponse> {
  const store = await openConfiguredStoreReadOnly(cfg);
  try {
    const read = options.scope === "program" ? readGraphProgramSnapshot : readGraphNeighborhoodSnapshot;
    return await store.readSnapshot((snapshot) => read(cfg, options, snapshot, signal));
  } finally {
    await store.close();
  }
}

interface InFlightProjection {
  promise: Promise<GraphNeighborhoodResponse>;
  controller: AbortController;
  consumers: number;
}

const inFlightProjections = new Map<string, InFlightProjection>();

function projectionKey(cfg: AppConfig, options: GraphNeighborhoodOptions): string {
  const store = cfg.db_url_env ? `postgres:${cfg.db_url_env}` : `sqlite:${cfg.db_path}`;
  const repos = configuredRepoRefs(cfg)
    .map((repo) => configuredRepoKey(repo.source_id, repo.project_path))
    .sort();
  return JSON.stringify([store, repos, options.focusRef, options.depth, options.mentionMode, options.scope]);
}

export async function graphNeighborhoodProjection(
  cfg: AppConfig,
  options: GraphNeighborhoodOptions,
  signal?: AbortSignal,
): Promise<GraphNeighborhoodResponse> {
  const key = projectionKey(cfg, options);
  return coalesceGraphNeighborhoodProjection(
    key,
    (sharedSignal) => loadGraphNeighborhoodProjection(cfg, options, sharedSignal),
    signal,
  );
}

export function coalesceGraphNeighborhoodProjection(
  key: string,
  loader: (signal: AbortSignal) => Promise<GraphNeighborhoodResponse>,
  signal?: AbortSignal,
): Promise<GraphNeighborhoodResponse> {
  let entry = inFlightProjections.get(key);
  if (!entry) {
    const controller = new AbortController();
    const promise = loader(controller.signal).finally(() => {
      if (inFlightProjections.get(key)?.promise === promise) inFlightProjections.delete(key);
    });
    entry = { promise, controller, consumers: 0 };
    inFlightProjections.set(key, entry);
  }
  entry.consumers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry!.consumers--;
    if (entry!.consumers === 0 && signal?.aborted) entry!.controller.abort();
  };
  if (signal?.aborted) {
    release();
    throw new DOMException("graph neighborhood request aborted", "AbortError");
  }
  return new Promise<GraphNeighborhoodResponse>((resolve, reject) => {
    const onAbort = () => {
      release();
      reject(new DOMException("graph neighborhood request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry!.promise.then(resolve, reject).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      release();
    });
  });
}

export async function handleGraphNeighborhoodRequest(
  cfg: AppConfig,
  url: URL,
  res: ServerResponse,
  acceptEncoding?: string | string[],
  signal?: AbortSignal,
): Promise<void> {
  let options: GraphNeighborhoodOptions;
  try {
    options = parseGraphNeighborhoodOptions(url);
  } catch (error) {
    sendJsonMaybeGzip(res, 400, {
      error: "invalid_graph_neighborhood",
      message: error instanceof Error ? error.message : String(error),
    }, acceptEncoding);
    return;
  }
  try {
    sendJsonMaybeGzip(res, 200, await graphNeighborhoodProjection(cfg, options, signal), acceptEncoding);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (error instanceof GraphNeighborhoodNotFoundError) {
      sendJsonMaybeGzip(res, 404, { error: "graph_focus_not_found", message: error.message }, acceptEncoding);
      return;
    }
    sendJsonMaybeGzip(
      res,
      500,
      { error: "internal_error", message: error instanceof Error ? error.message : String(error) },
      acceptEncoding,
    );
  }
}
