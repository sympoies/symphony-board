// Pure view-model helpers over the contract: filtering, edge resolution, and
// small stats. No React here — easy to reason about and reuse.

import type { ContractEnvelope, ItemDTO, EdgeDTO } from "@symphony-board/contract";
import { SPOTLIGHT_LANES as SPOTLIGHT_LANE_CONFIG, SPOTLIGHT_KEEP, type SpotlightLaneConfig } from "./spotlight.config.ts";

// Board status columns, after project-board-automation's Status model
// (Open / Trailing / Closed) plus an explicit In Progress lane:
//   open        – open, no open linked PR
//   in_progress – open AND part of a `declared` edge (open linked PR = work underway)
//   trailing    – closed/merged BUT a related item is still open
//   closed      – closed/merged with no related item still open
// `trailing` was renamed from "Tracking" to avoid confusion with the
// `workflow::tracking` LABEL — this is a lifecycle status, not a label.
export type ItemStatus = "open" | "in_progress" | "trailing" | "closed";
export const STATUS_ORDER: ItemStatus[] = ["open", "in_progress", "trailing", "closed"];
export const STATUS_LABEL: Record<ItemStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  trailing: "Trailing",
  closed: "Closed",
};
export const STATUS_DESC: Record<ItemStatus, string> = {
  open: "open · no open linked PR",
  in_progress: "open · has an open linked PR",
  trailing: "closed/merged · a related item is still open",
  closed: "closed/merged · nothing related still open",
};

// Spotlight: recency lanes independent of status, after the predecessor's second
// board view. Each lane takes the latest N items (by created_at) that match,
// REGARDLESS of open/closed/merged — so follow-up / plan issues stay visible even
// after they close. The lane CONVENTIONS (which labels/kinds) live in
// `spotlight.config.ts`; here we compile each declarative entry into a predicate.
export interface SpotlightLane {
  key: string;
  label: string;
  hint: string;
  pick: (i: ItemDTO) => boolean;
}
const hasLabel = (i: ItemDTO, name: string) => i.labels.some((l) => l.name === name);
function compileLane(c: SpotlightLaneConfig): SpotlightLane {
  return {
    key: c.key,
    label: c.label,
    hint: c.hint,
    pick: (i) =>
      (c.kind === undefined || i.kind === c.kind) &&
      (c.anyLabel === undefined || c.anyLabel.some((name) => hasLabel(i, name))),
  };
}
export const SPOTLIGHT_LANES: SpotlightLane[] = SPOTLIGHT_LANE_CONFIG.map(compileLane);

export function spotlight(items: ItemDTO[]): Array<{ lane: SpotlightLane; items: ItemDTO[] }> {
  const recent = (a: ItemDTO, b: ItemDTO) => (b.created_at ?? "").localeCompare(a.created_at ?? "");
  return SPOTLIGHT_LANES.map((lane) => ({ lane, items: items.filter(lane.pick).sort(recent).slice(0, SPOTLIGHT_KEEP) }));
}

// Derive each item's board status from the full item + edge set (status is an
// intrinsic property — computed over ALL edges, then filtered items are placed
// into columns by the caller).
export function deriveStatuses(items: ItemDTO[], edges: EdgeDTO[]): Map<string, ItemStatus> {
  const hasRelatedOpen = new Map<string, boolean>(); // item id -> a related endpoint is open
  const inDeclared = new Set<string>(); // item id -> endpoint of a declared (in-flight) edge
  for (const e of edges) {
    if (e.to_state === "open") hasRelatedOpen.set(e.from, true);
    if (e.from_state === "open") hasRelatedOpen.set(e.to, true);
    if (e.lifecycle === "declared") {
      inDeclared.add(e.from);
      inDeclared.add(e.to);
    }
  }
  const status = new Map<string, ItemStatus>();
  for (const it of items) {
    if (it.state === "open") status.set(it.id, inDeclared.has(it.id) ? "in_progress" : "open");
    else status.set(it.id, hasRelatedOpen.get(it.id) ? "trailing" : "closed");
  }
  return status;
}

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

// --- repo visibility (Settings page) ------------------------------------
//
// A persistent, repo-level PRE-FILTER applied before the transient facet
// filters above. The unit is a repo = (source_id, project_path); the Settings
// page persists the choice in localStorage. We track HIDDEN keys (not the
// visible set) so a repo that first appears in a later sync defaults to visible
// — "everything visible" stays the default as the data grows.

export interface RepoOption {
  key: string; // stable id, also the localStorage unit
  source_id: string;
  project_path: string | null;
  count: number; // items in this repo
}

// Stable key for a repo — used both to dedupe rows and as the localStorage unit.
// Encoded as a JSON tuple so two distinct (source_id, project_path) pairs can
// never collide, whatever characters either field contains (and a null path
// stays distinct from an empty-string path).
export const repoKey = (source_id: string, project_path: string | null): string =>
  JSON.stringify([source_id, project_path]);

// Distinct repos present in the contract's items, with counts, sorted by source
// then path — the rows the Settings page renders. Derived over the FULL item
// set so a hidden repo still appears and can be re-enabled.
export function deriveRepos(items: ItemDTO[]): RepoOption[] {
  const byKey = new Map<string, RepoOption>();
  for (const it of items) {
    const key = repoKey(it.source_id, it.project_path);
    const cur = byKey.get(key);
    if (cur) cur.count++;
    else byKey.set(key, { key, source_id: it.source_id, project_path: it.project_path, count: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) => a.source_id.localeCompare(b.source_id) || (a.project_path ?? "").localeCompare(b.project_path ?? ""),
  );
}

// Apply the repo-visibility pre-filter, returning a contract VIEW with hidden
// repos' items AND any edge touching them removed (an edge belongs to a repo if
// a resolvable endpoint does). An untracked endpoint cannot be hidden (no repo
// known), so an edge between visible/untracked ends survives. Returns env
// unchanged when nothing is hidden.
export function applyVisibility(env: ContractEnvelope, hidden: ReadonlySet<string>): ContractEnvelope {
  if (hidden.size === 0) return env;
  const isHidden = (it: ItemDTO) => hidden.has(repoKey(it.source_id, it.project_path));
  const byId = indexItems(env);
  const items = env.items.filter((it) => !isHidden(it));
  const edges = env.edges.filter((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return !(from && isHidden(from)) && !(to && isHidden(to));
  });
  return { ...env, items, edges };
}

// --- relationship graph (Graph page) ------------------------------------

export interface GraphNode {
  id: string; // the endpoint ref (item id; may be an untracked, unresolved ref)
  label: string; // item title (or the bare ref tail when untracked)
  repo: string | null; // project_path, so a node shows which repo it belongs to
  iid: number | null;
  kind: string; // issue | change_request | unknown (untracked)
  state: string; // open | closed | merged | unknown
  url: string | null;
  color: string; // node accent (state colour)
  demand: number | null; // comments + reactions; drives node size on the graph
  created_at: string | null; // ISO; rendered (relative) on the node card
  updated_at: string | null; // ISO; rendered (relative) on the node card
  untracked: boolean;
}
export interface GraphLink {
  id: string;
  source: string;
  target: string;
  type: string;
  color: string; // stroke, by lifecycle
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// Night Owl hexes duplicated here ONLY because the cytoscape canvas cannot read
// CSS custom properties; keep in sync with styles.css :root.
const NODE_FILL: Record<string, string> = { open: "#addb67", closed: "#c792ea", merged: "#7e57c2", unknown: "#637777" };
const EDGE_STROKE: Record<string, string> = { declared: "#ffcb6b", fulfilled: "#addb67", broken: "#f78c6c", other: "#637777" };

// ISO cutoff for "N days ago" (browser-side; now is injectable for tests).
export function cutoffIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

// Build a relationship graph from resolved edges, keeping only nodes that take
// part in an edge (no isolated-dot sea). An edge survives the time window if any
// tracked endpoint was updated at/after the cutoff; an edge whose endpoints are
// both untracked (undateable) is always kept.
export function buildGraph(edges: ResolvedEdge[], cutoff: string | null): GraphData {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  let i = 0;
  for (const re of edges) {
    const ends = [re.from, re.to];
    const within = ends.some((it) => it && (!cutoff || (it.updated_at ?? "") >= cutoff));
    const bothUntracked = !re.from && !re.to;
    if (cutoff && !within && !bothUntracked) continue;
    const ensure = (it: ItemDTO | null, ref: string) => {
      if (nodes.has(ref)) return;
      nodes.set(
        ref,
        it
          ? { id: ref, label: it.title ?? ref, repo: it.project_path ?? null, iid: it.iid ?? null, kind: it.kind, state: it.state, url: it.url ?? null, color: NODE_FILL[it.state] ?? "#637777", demand: it.demand ?? null, created_at: it.created_at ?? null, updated_at: it.updated_at ?? null, untracked: false }
          : { id: ref, label: ref.split("|").pop() ?? ref, repo: null, iid: null, kind: "unknown", state: "unknown", url: null, color: "#637777", demand: null, created_at: null, updated_at: null, untracked: true },
      );
    };
    ensure(re.from, re.edge.from);
    ensure(re.to, re.edge.to);
    links.push({ id: `g${i++}`, source: re.edge.from, target: re.edge.to, type: re.edge.type, color: EDGE_STROKE[re.edge.lifecycle ?? "other"] ?? "#637777" });
  }
  return { nodes: [...nodes.values()], links };
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
