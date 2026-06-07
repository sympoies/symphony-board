// Pure view-model helpers over the contract: filtering, grouping, edge
// resolution, and small stats. No React here — easy to reason about and reuse.

import type { ContractEnvelope, ItemDTO, EdgeDTO, EdgeLifecycle } from "@symphony-board/contract";

export type GroupBy = "source" | "repo" | "state" | "kind" | "none";

export interface Filters {
  search: string;
  sources: ReadonlySet<string>; // empty = all
  states: ReadonlySet<string>;
  kinds: ReadonlySet<string>;
}

export const emptyFilters = (): Filters => ({
  search: "",
  sources: new Set(),
  states: new Set(),
  kinds: new Set(),
});

export function indexItems(env: ContractEnvelope): Map<string, ItemDTO> {
  return new Map(env.items.map((it) => [it.id, it]));
}

// A DOM-safe anchor id for an item ref (refs contain '|', ':', '/'). The same
// encoding is used for the element id and the link fragment so they match.
export const anchorId = (ref: string): string => `item-${encodeURIComponent(ref)}`;

export function itemMatches(it: ItemDTO, f: Filters): boolean {
  if (f.sources.size && !f.sources.has(it.source_id)) return false;
  if (f.states.size && !f.states.has(it.state)) return false;
  if (f.kinds.size && !f.kinds.has(it.kind)) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = [it.title, it.author, it.project_path, it.external_id, ...it.labels.map((l) => l.name)]
      .filter((s): s is string => !!s)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function groupKey(it: ItemDTO, by: GroupBy): string {
  switch (by) {
    case "source":
      return it.source_id;
    case "repo":
      return it.project_path ?? "(no repo)";
    case "state":
      return it.state;
    case "kind":
      return it.kind;
    case "none":
      return "All items";
  }
}

export interface Group {
  key: string;
  items: ItemDTO[];
}

// Group filtered items, preserving the contract's within-group ordering (it is
// already sorted by recency). Groups are sorted by key for a stable layout.
export function groupItems(items: ItemDTO[], by: GroupBy): Group[] {
  const map = new Map<string, ItemDTO[]>();
  for (const it of items) {
    const k = groupKey(it, by);
    const arr = map.get(k);
    if (arr) arr.push(it);
    else map.set(k, [it]);
  }
  return [...map.entries()]
    .map(([key, groupItemsList]) => ({ key, items: groupItemsList }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export interface ResolvedEdge {
  edge: EdgeDTO;
  from: ItemDTO | null; // null = endpoint in an untracked project (cross-repo)
  to: ItemDTO | null;
}

export function resolveEdges(env: ContractEnvelope, byId: Map<string, ItemDTO>): ResolvedEdge[] {
  return env.edges.map((edge) => ({
    edge,
    from: byId.get(edge.from) ?? null,
    to: byId.get(edge.to) ?? null,
  }));
}

// An edge passes the filter if either resolved endpoint passes (so a cross-repo
// link whose tracked side matches still shows). An edge with both endpoints
// untracked always shows (we cannot filter what we cannot resolve).
export function edgeMatches(re: ResolvedEdge, f: Filters): boolean {
  const ends = [re.from, re.to].filter((x): x is ItemDTO => x !== null);
  if (ends.length === 0) return true;
  return ends.some((it) => itemMatches(it, f));
}

export const LIFECYCLE_ORDER: EdgeLifecycle[] = ["declared", "fulfilled", "broken"];

export function lifecycleBucket(re: ResolvedEdge): EdgeLifecycle | "other" {
  return re.edge.lifecycle ?? "other";
}

export interface Stats {
  items: number;
  byState: Record<string, number>;
  byKind: Record<string, number>;
  byLifecycle: Record<string, number>;
}

export function computeStats(items: ItemDTO[], edges: EdgeDTO[]): Stats {
  const byState: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const it of items) {
    byState[it.state] = (byState[it.state] ?? 0) + 1;
    byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  }
  const byLifecycle: Record<string, number> = {};
  for (const e of edges) {
    const k = e.lifecycle ?? "other";
    byLifecycle[k] = (byLifecycle[k] ?? 0) + 1;
  }
  return { items: items.length, byState, byKind, byLifecycle };
}

// "3d ago" / "just now" from an ISO timestamp. now is injectable for testing.
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((now - t) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}
