// Build the contract envelope (LAYER 3) from canonical DB rows. Pure mapping:
// given rows + a `generatedAt` instant, produce the versioned envelope. No DB
// access here, so it is unit-testable with fabricated rows.

import type { ActivityRow, ItemRow, LabelRow, EdgeRow, SourceRow } from "../db/repo.ts";
import type {
  ActivityDTO,
  ContractEnvelope,
  ItemDTO,
  EdgeDTO,
  SourceDTO,
  RepoDTO,
  RepoStatsDTO,
  LabelDTO,
  AggregateDTO,
  AggregateStatsDTO,
  AggregateWindowDTO,
  ItemWindowDTO,
  ItemWindowReason,
  TimeRangeDTO,
  ItemState,
  ReviewState,
  CiState,
  MergeState,
  EdgeLifecycle,
} from "@symphony-board/contract";
import { refOf } from "../model/ref.ts";
import { CONTRACT_VERSION, GENERATOR } from "./version.ts";

const asState = (s: string): ItemState => s as ItemState;
const orNull = <T extends string>(s: string | null): T | null => (s === null ? null : (s as T));
const ACTIVE_WINDOW_DAYS = [7, 14, 30, 90] as const;
const CONTRACT_ITEM_WINDOW_DAYS = 90;

function toLabelDTO(l: LabelRow): LabelDTO {
  return { name: l.name, scope: l.scope, color: l.color };
}

function toItemDTO(row: ItemRow, labels: LabelRow[], windowReasons?: ItemWindowReason[]): ItemDTO {
  return {
    id: refOf(row.source_id, row.external_id),
    source_id: row.source_id,
    external_id: row.external_id,
    kind: row.kind,
    project_path: row.project_path,
    iid: row.iid,
    url: row.url ?? "",
    title: row.title,
    state: asState(row.state),
    state_raw: row.state_raw,
    state_reason: row.state_reason,
    is_draft: row.is_draft === null ? null : row.is_draft !== 0,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    merged_at: row.merged_at,
    labels: labels.map(toLabelDTO),
    review_state: orNull<ReviewState>(row.review_state),
    ci_state: orNull<CiState>(row.ci_state),
    merge_state: orNull<MergeState>(row.merge_state),
    milestone: row.milestone,
    demand: row.demand,
    last_seen_at: row.last_seen_at,
    ...(windowReasons && windowReasons.length ? { window_reasons: windowReasons } : {}),
  };
}

function toEdgeDTO(row: EdgeRow): EdgeDTO {
  return {
    type: row.type,
    from: refOf(row.from_source_id, row.from_external_id),
    to: refOf(row.to_source_id, row.to_external_id),
    from_state: orNull<ItemState>(row.from_state),
    to_state: orNull<ItemState>(row.to_state),
    lifecycle: orNull<EdgeLifecycle>(row.lifecycle),
  };
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toActivityDTO(row: ActivityRow): ActivityDTO {
  const target_ref =
    row.target_source_id && row.target_external_id
      ? refOf(row.target_source_id, row.target_external_id)
      : null;
  return {
    id: refOf(row.source_id, row.external_id),
    source_id: row.source_id,
    external_id: row.external_id,
    kind: row.kind,
    action: row.action,
    project_path: row.project_path,
    target_kind: row.target_kind,
    target_ref,
    target_iid: row.target_iid,
    title: row.title,
    url: row.url,
    actor: row.actor,
    occurred_at: row.occurred_at,
    summary: row.summary,
    details: parseDetails(row.details),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  };
}

function toSourceDTO(row: SourceRow, sourceColors: Record<string, string>): SourceDTO {
  return {
    source_id: row.source_id,
    kind: row.kind,
    host: row.host,
    display_name: row.display_name,
    last_success_at: row.last_success_at,
    last_status: orNull<"ok" | "partial" | "error">(row.last_status),
    color: sourceColors[row.source_id] ?? null,
  };
}

function inc(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function computeItemEdgeStats(items: ItemDTO[], edges: EdgeDTO[]): AggregateStatsDTO {
  const by_state: Record<string, number> = {};
  const by_kind: Record<string, number> = {};
  for (const it of items) {
    inc(by_state, it.state);
    inc(by_kind, it.kind);
  }

  const by_lifecycle: Record<string, number> = {};
  for (const edge of edges) inc(by_lifecycle, edge.lifecycle ?? "other");
  return { items: items.length, by_state, by_kind, by_lifecycle };
}

function aggregateWindow(
  kind: AggregateWindowDTO["kind"],
  basis: AggregateWindowDTO["basis"],
  since: string | null,
  days: number | null,
  edgeFilter: AggregateWindowDTO["edge_filter"],
): AggregateWindowDTO {
  return { kind, basis, since, days, edge_filter: edgeFilter };
}

function cutoffIso(days: number, generatedAt: string): string {
  return new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString();
}

function timestampMs(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function timestampAtOrAfter(value: string | null | undefined, cutoff: string | null): boolean {
  if (!cutoff) return true;
  const valueMs = timestampMs(value);
  const cutoffMs = timestampMs(cutoff);
  return valueMs !== null && cutoffMs !== null && valueMs >= cutoffMs;
}

function timestampInRange(value: string | null | undefined, range: TimeRangeDTO): boolean {
  const valueMs = timestampMs(value);
  const fromMs = timestampMs(range.from);
  const toMs = timestampMs(range.to);
  return valueMs !== null && fromMs !== null && toMs !== null && valueMs >= fromMs && valueMs <= toMs;
}

function itemActiveSince(item: ItemDTO, cutoff: string | null): boolean {
  return timestampAtOrAfter(item.updated_at, cutoff);
}

function itemUpdatedInRange(item: ItemDTO, range: TimeRangeDTO): boolean {
  return timestampInRange(item.updated_at, range);
}

function activityOccurredInRange(activity: ActivityDTO, range: TimeRangeDTO): boolean {
  return timestampInRange(activity.occurred_at, range);
}

function boardWindowEdges(items: ItemDTO[], edges: EdgeDTO[]): EdgeDTO[] {
  const ids = new Set(items.map((item) => item.id));
  return edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to));
}

function graphWindowEdges(edges: EdgeDTO[], byId: Map<string, ItemDTO>, cutoff: string | null): EdgeDTO[] {
  return edges.filter((edge) => {
    if (!cutoff) return true;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from && !to) return true;
    return timestampAtOrAfter(from?.updated_at, cutoff) || timestampAtOrAfter(to?.updated_at, cutoff);
  });
}

function noMentions(edges: EdgeDTO[]): EdgeDTO[] {
  return edges.filter((edge) => edge.type !== "mentions");
}

function computeGraphStats(edges: EdgeDTO[], byId: Map<string, ItemDTO>): AggregateStatsDTO {
  const refs = new Set<string>();
  for (const edge of edges) {
    refs.add(edge.from);
    refs.add(edge.to);
  }

  const by_state: Record<string, number> = {};
  const by_kind: Record<string, number> = {};
  for (const ref of refs) {
    const item = byId.get(ref);
    inc(by_state, item?.state ?? "unknown");
    inc(by_kind, item?.kind ?? "unknown");
  }

  const by_lifecycle: Record<string, number> = {};
  for (const edge of edges) inc(by_lifecycle, edge.lifecycle ?? "other");
  return { items: refs.size, by_state, by_kind, by_lifecycle };
}

function buildRepoStats(items: ItemDTO[]): RepoStatsDTO[] {
  const byRepo = new Map<string, RepoStatsDTO>();
  for (const item of items) {
    const key = JSON.stringify([item.source_id, item.project_path]);
    let repo = byRepo.get(key);
    if (!repo) {
      repo = {
        source_id: item.source_id,
        project_path: item.project_path,
        items: 0,
        by_state: {},
        by_kind: {},
      };
      byRepo.set(key, repo);
    }
    repo.items += 1;
    inc(repo.by_state, item.state);
    inc(repo.by_kind, item.kind);
  }
  return [...byRepo.values()].sort(
    (a, b) => a.source_id.localeCompare(b.source_id) || (a.project_path ?? "").localeCompare(b.project_path ?? ""),
  );
}

function buildAggregates(items: ItemDTO[], edges: EdgeDTO[], generatedAt: string): AggregateDTO[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const graphBaseEdges = noMentions(edges);
  const aggregates: AggregateDTO[] = [
    {
      scope: "global",
      window: aggregateWindow("full", "full_contract", null, null, null),
      stats: computeItemEdgeStats(items, edges),
    },
    {
      scope: "boardWindow",
      window: aggregateWindow("full", "item_updated_at", null, null, null),
      stats: computeItemEdgeStats(items, boardWindowEdges(items, edges)),
    },
    {
      scope: "graphWindow",
      window: aggregateWindow("full", "edge_endpoint_updated_at", null, null, "no_mentions"),
      stats: computeGraphStats(graphBaseEdges, byId),
    },
  ];

  for (const days of ACTIVE_WINDOW_DAYS) {
    const since = cutoffIso(days, generatedAt);
    const boardItems = items.filter((item) => itemActiveSince(item, since));
    aggregates.push({
      scope: "boardWindow",
      window: aggregateWindow("active_since", "item_updated_at", since, days, null),
      stats: computeItemEdgeStats(boardItems, boardWindowEdges(boardItems, edges)),
    });

    const graphEdges = graphWindowEdges(graphBaseEdges, byId, since);
    aggregates.push({
      scope: "graphWindow",
      window: aggregateWindow("active_since", "edge_endpoint_updated_at", since, days, "no_mentions"),
      stats: computeGraphStats(graphEdges, byId),
    });
  }

  return aggregates;
}

function buildWindowedProjection(
  items: ItemDTO[],
  edges: EdgeDTO[],
  generatedAt: string,
): { items: ItemDTO[]; edges: EdgeDTO[]; itemWindow: ItemWindowDTO } {
  const since = cutoffIso(CONTRACT_ITEM_WINDOW_DAYS, generatedAt);
  const primaryIds = new Set(items.filter((item) => itemActiveSince(item, since)).map((item) => item.id));
  const selectedEdges = edges.filter((edge) => primaryIds.has(edge.from) || primaryIds.has(edge.to));

  const endpointIds = new Set<string>();
  for (const edge of selectedEdges) {
    endpointIds.add(edge.from);
    endpointIds.add(edge.to);
  }

  const emittedIds = new Set([...primaryIds, ...endpointIds]);
  const windowedItems = items
    .filter((item) => emittedIds.has(item.id))
    .map((item) => {
      const reasons: ItemWindowReason[] = [];
      if (primaryIds.has(item.id)) reasons.push("primary");
      if (endpointIds.has(item.id)) reasons.push("edge_endpoint");
      return { ...item, window_reasons: reasons };
    });

  const edgeEndpointItems = windowedItems.filter((item) => !primaryIds.has(item.id) && endpointIds.has(item.id)).length;
  return {
    items: windowedItems,
    edges: selectedEdges,
    itemWindow: {
      scope: "boardWindow",
      window: aggregateWindow("active_since", "item_updated_at", since, CONTRACT_ITEM_WINDOW_DAYS, null),
      primary_items: primaryIds.size,
      edge_endpoint_items: edgeEndpointItems,
      total_items: items.length,
      truncated: windowedItems.length < items.length,
    },
  };
}

function edgeKey(edge: EdgeDTO): string {
  return JSON.stringify([edge.type, edge.from, edge.to]);
}

function buildRangeProjection(
  items: ItemDTO[],
  edges: EdgeDTO[],
  activities: ActivityDTO[],
  range: TimeRangeDTO,
): { items: ItemDTO[]; edges: EdgeDTO[]; activities: ActivityDTO[]; itemWindow: ItemWindowDTO } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const primaryIds = new Set(items.filter((item) => itemUpdatedInRange(item, range)).map((item) => item.id));
  const boardEdges = edges.filter((edge) => primaryIds.has(edge.from) || primaryIds.has(edge.to));
  const graphEdges = edges.filter((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return (from ? itemUpdatedInRange(from, range) : false) || (to ? itemUpdatedInRange(to, range) : false);
  });

  const selectedByKey = new Map<string, EdgeDTO>();
  for (const edge of [...boardEdges, ...graphEdges]) selectedByKey.set(edgeKey(edge), edge);
  const selectedEdges = [...selectedByKey.values()];

  const endpointIds = new Set<string>();
  for (const edge of selectedEdges) {
    endpointIds.add(edge.from);
    endpointIds.add(edge.to);
  }

  const emittedIds = new Set([...primaryIds, ...endpointIds]);
  const windowedItems = items
    .filter((item) => emittedIds.has(item.id))
    .map((item) => {
      const reasons: ItemWindowReason[] = [];
      if (primaryIds.has(item.id)) reasons.push("primary");
      if (endpointIds.has(item.id)) reasons.push("edge_endpoint");
      return { ...item, window_reasons: reasons };
    });

  const edgeEndpointItems = windowedItems.filter((item) => !primaryIds.has(item.id) && endpointIds.has(item.id)).length;
  return {
    items: windowedItems,
    edges: selectedEdges,
    activities: activities.filter((activity) => activityOccurredInRange(activity, range)),
    itemWindow: {
      scope: "boardWindow",
      window: aggregateWindow("active_since", "item_updated_at", range.from, null, null),
      primary_items: primaryIds.size,
      edge_endpoint_items: edgeEndpointItems,
      total_items: items.length,
      truncated: windowedItems.length < items.length,
    },
  };
}

export interface BuildInput {
  sources: SourceRow[];
  items: ItemRow[];
  labels: LabelRow[];
  edges: EdgeRow[];
  activities?: ActivityRow[];
  generatedAt: string;
  // Config-derived display colors (NOT stored in the DB). Threaded in by the
  // emit CLI, which reads config; buildContract stays a pure mapping of its
  // inputs. Both default to empty, so existing callers/tests are unaffected.
  sourceColors?: Record<string, string>; // source_id -> hex
  repoColors?: RepoDTO[]; // sparse: only repos with a configured color
}

export function buildContract(input: BuildInput): ContractEnvelope {
  const mapped = mapRows(input);
  const windowed = buildWindowedProjection(mapped.items, mapped.edges, input.generatedAt);
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: input.generatedAt,
    generator: GENERATOR,
    sources: mapped.sources,
    items: windowed.items,
    edges: windowed.edges,
    activities: mapped.activities,
    repos: mapped.repos,
    aggregates: buildAggregates(mapped.items, mapped.edges, input.generatedAt),
    item_window: windowed.itemWindow,
    repo_stats: buildRepoStats(mapped.items),
  };
}

function mapRows(input: BuildInput): {
  sources: SourceDTO[];
  items: ItemDTO[];
  edges: EdgeDTO[];
  activities: ActivityDTO[];
  repos: RepoDTO[];
} {
  const labelsByItem = new Map<number, LabelRow[]>();
  for (const l of input.labels) {
    const arr = labelsByItem.get(l.item_id) ?? [];
    arr.push(l);
    labelsByItem.set(l.item_id, arr);
  }
  const sourceColors = input.sourceColors ?? {};
  const items = input.items.map((it) => toItemDTO(it, labelsByItem.get(it.item_id) ?? []));
  const edges = input.edges.map(toEdgeDTO);
  return {
    sources: input.sources.map((s) => toSourceDTO(s, sourceColors)),
    activities: (input.activities ?? []).map(toActivityDTO),
    repos: (input.repoColors ?? []).map((r) => ({ source_id: r.source_id, project_path: r.project_path, color: r.color })),
    items,
    edges,
  };
}

export interface BuildRangeInput extends BuildInput {
  range: TimeRangeDTO;
}

export function buildRangeContract(input: BuildRangeInput): ContractEnvelope {
  const mapped = mapRows(input);
  const ranged = buildRangeProjection(mapped.items, mapped.edges, mapped.activities, input.range);
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: input.generatedAt,
    generator: GENERATOR,
    sources: mapped.sources,
    items: ranged.items,
    edges: ranged.edges,
    activities: ranged.activities,
    repos: mapped.repos,
    aggregates: [],
    item_window: ranged.itemWindow,
    repo_stats: buildRepoStats(mapped.items),
    range_query: { kind: "time_range", timezone: "UTC", from: input.range.from, to: input.range.to },
  };
}
