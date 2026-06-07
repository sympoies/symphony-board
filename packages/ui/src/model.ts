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

// --- hash route -----------------------------------------------------------
//
// The app routes purely on the URL hash (zero-dep): "#/" board, "#/graph"
// relationship graph, "#/settings". A board card can deep-link INTO the graph
// with a focus target — the item ref encoded as a query on the hash, e.g.
// "#/graph?focus=<encodeURIComponent(item.id)>". The Graph page seeds its focus
// view (and frames the camera) from it. Parse + build are kept pure here so the
// round-trip is unit-tested; refs contain '|' / ':' / '/' so they MUST be
// percent-encoded to survive the query.
export interface HashRoute {
  page: string; // "" | "graph" | "settings" (the part before any '?')
  focus: string | null; // an item ref to focus on the graph (side-list view + camera)
  q: string | null; // a search token to seed the search bar (narrows the graph)
}

export function parseHashRoute(hash: string): HashRoute {
  const raw = hash.replace(/^#\/?/, "");
  const i = raw.indexOf("?");
  const page = i === -1 ? raw : raw.slice(0, i);
  const params = i === -1 ? null : new URLSearchParams(raw.slice(i + 1));
  return { page, focus: params?.get("focus") || null, q: params?.get("q") || null };
}

// The search-bar token a board card seeds when it deep-links into the graph: the
// repo + issue/PR number ("owner/repo #13"), which itemMatches pins to exactly
// this one item — so the graph narrows to it + its neighbours instead of loading
// the whole window (the slow path). Falls back to the title / external_id when an
// item has no repo+iid, so the token still narrows. Pairs with itemMatches'
// "#<n>" exact-iid rule; clearing the search returns to the unfiltered view.
export function itemSearchToken(it: ItemDTO): string {
  if (it.project_path && it.iid != null) return `${it.project_path} #${it.iid}`;
  return it.title ?? it.external_id ?? it.id;
}

// The hash a board card links to, to open the graph on `it`: `focus` drives the
// side-list focus view + camera, and `q` seeds the search bar with the item's
// token so the canvas narrows to it + its neighbours. Both live in the URL so the
// search applies synchronously on arrival (no full-graph flash, deep-link
// shareable). Pairs with parseHashRoute (encode here, decode there).
export const graphFocusHref = (it: ItemDTO): string =>
  `#/graph?focus=${encodeURIComponent(it.id)}&q=${encodeURIComponent(itemSearchToken(it))}`;

// Apply a route's "?q=" token to the filters: a present q SEEDS the search (how a
// board → graph deep-link narrows the graph); an ABSENT q leaves filters untouched
// so a search the user typed is never clobbered by a later navigation. Returns the
// SAME object when nothing changes (stable identity, so React skips a re-render).
// Used for both the initial filters and every hashchange, so the asymmetry lives
// in exactly one tested place.
export function applyRouteSearch(filters: Filters, route: HashRoute): Filters {
  if (route.q == null || route.q === filters.search) return filters;
  return { ...filters, search: route.q };
}

// The set of item ids that are an endpoint of at least one edge — i.e. items
// that have a node on the relationship graph. Gates the board card's "focus in
// graph" link: an item with no edge has nothing to focus. Both ends are
// collected (an untracked cross-repo ref is harmless — it never matches a board
// item id).
export function edgeEndpointIds(edges: EdgeDTO[]): Set<string> {
  const ids = new Set<string>();
  for (const e of edges) {
    ids.add(e.from);
    ids.add(e.to);
  }
  return ids;
}

export function itemMatches(it: ItemDTO, f: Filters): boolean {
  if (f.sources.size && !f.sources.has(it.source_id)) return false;
  if (f.states.size && !f.states.has(it.state)) return false;
  if (f.kinds.size && !f.kinds.has(it.kind)) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    // iid is intentionally NOT in the hay — it is matched ONLY via the exact
    // `#<n>` term below. Putting it in the hay would reintroduce substring
    // collisions (a search for "#13" matching "#130").
    const hay = [it.title, it.author, it.project_path, it.external_id, ...it.labels.map((l) => l.name)]
      .filter((s): s is string => !!s)
      .join(" ")
      .toLowerCase();
    // AND across whitespace-separated terms. A `#<n>` term is an explicit
    // issue/PR number — matched EXACTLY against iid (so "#13" never matches
    // "#130"); every other term is a case-insensitive substring of the hay. This
    // lets a "repo #iid" search (the board → graph deep-link) pin exactly one
    // item, while staying backward compatible for a plain single-word search.
    for (const term of q.split(/\s+/)) {
      const num = /^#(\d+)$/.exec(term);
      if (num) {
        if (it.iid == null || String(it.iid) !== num[1]) return false;
      } else if (!hay.includes(term)) {
        return false;
      }
    }
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

// Apply the visibility pre-filter, returning a contract VIEW with hidden items
// AND any edge touching them removed (an edge belongs to a repo if a resolvable
// endpoint does). Two INDEPENDENT layers gate an item: its source can be hidden
// (hiddenSources, by source_id) and/or its repo can be hidden (hiddenRepos, by
// repoKey) — effective-hidden = source hidden OR repo hidden. They are kept
// separate so toggling a source never mutates the remembered per-repo choices.
// An untracked endpoint cannot be hidden (no repo known), so an edge between
// visible/untracked ends survives. Returns env unchanged when nothing is hidden.
export function applyVisibility(
  env: ContractEnvelope,
  hiddenRepos: ReadonlySet<string>,
  hiddenSources: ReadonlySet<string> = new Set(),
): ContractEnvelope {
  if (hiddenRepos.size === 0 && hiddenSources.size === 0) return env;
  const isHidden = (it: ItemDTO) =>
    hiddenSources.has(it.source_id) || hiddenRepos.has(repoKey(it.source_id, it.project_path));
  const byId = indexItems(env);
  const items = env.items.filter((it) => !isHidden(it));
  const edges = env.edges.filter((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return !(from && isHidden(from)) && !(to && isHidden(to));
  });
  return { ...env, items, edges };
}

// --- highlight color (Settings page + board/graph rendering) ------------
//
// A repo/source can carry a highlight color so it stands out. Resolution, most
// specific first: a per-repo UI OVERRIDE (localStorage, this viewer) beats the
// configured REPO color (contract repos[]) beats the configured SOURCE color
// (contract sources[].color). null = no highlight. The config layers ride in on
// the contract; the override layer is supplied by the caller (the Settings page
// owns it). Only the override exists at repo granularity in the UI — a source's
// color is changed in config, not overridden per-viewer.

// A color is used in a CSS sink (the card bar, the node outline, a swatch), so
// the UI validates the format before trusting it — even though config colors are
// checked at emit, a hand-edited localStorage override or a malicious/old
// contract could carry anything. #rgb / #rrggbb only; everything else is dropped
// (no highlight) rather than injected into CSS.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const isHexColor = (c: unknown): c is string => typeof c === "string" && HEX_COLOR.test(c);

export interface ColorIndex {
  repo: Map<string, string>; // repoKey -> configured repo color
  source: Map<string, string>; // source_id -> configured source color
}

export function buildColorIndex(env: ContractEnvelope): ColorIndex {
  const repo = new Map<string, string>();
  for (const r of env.repos ?? []) {
    if (!isHexColor(r.color)) continue;
    repo.set(repoKey(r.source_id, r.project_path), r.color);
    // Case-insensitive fallback key: a GitLab item's project_path is the queried
    // config path verbatim, but GitHub returns the canonical nameWithOwner — so a
    // config path that differs only in case would otherwise miss the join.
    repo.set(repoKey(r.source_id, r.project_path.toLowerCase()), r.color);
  }
  const source = new Map<string, string>();
  for (const s of env.sources ?? []) if (isHexColor(s.color)) source.set(s.source_id, s.color);
  return { repo, source };
}

// The per-item color lookup the views call (board cards, graph nodes/list). A
// component closes over the ColorIndex + override map and passes this down.
export type ColorOf = (source_id: string, project_path: string | null) => string | null;

export function resolveRepoColor(
  source_id: string,
  project_path: string | null,
  index: ColorIndex,
  override: ReadonlyMap<string, string>,
): string | null {
  const key = repoKey(source_id, project_path);
  const ov = override.get(key);
  if (ov) return ov;
  const repoColor =
    index.repo.get(key) ?? (project_path !== null ? index.repo.get(repoKey(source_id, project_path.toLowerCase())) : undefined);
  if (repoColor) return repoColor;
  return index.source.get(source_id) ?? null;
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
  accentColor?: string | null; // repo/source highlight, resolved + attached by the page (not buildGraph)
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

// Graph side-list ordering (#32): actionable state first, then newest-created.
// Bucket 0 = `open` (still actionable); bucket 1 = everything else (closed /
// merged / unknown). Within a bucket, `created_at` DESC so the newest item is
// first; a node without a `created_at` (e.g. an untracked cross-repo ref) sorts
// after the dated ones; ties break stably on label then id. Demand is no longer
// the primary sort — it stays as node size / metadata only.
export function compareGraphNodes(a: GraphNode, b: GraphNode): number {
  const bucket = (a.state === "open" ? 0 : 1) - (b.state === "open" ? 0 : 1);
  if (bucket !== 0) return bucket;
  if (a.created_at && b.created_at) {
    if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at); // newest first
  } else if (a.created_at) return -1; // a dated, b not -> a first
  else if (b.created_at) return 1; //  b dated, a not -> b first
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

// A related endpoint of an item, for the graph side list's focus view: the other
// end of an edge, the edge type, and which way it points (out = this -> other,
// in = other -> this). Built from the FULL edge set — NOT the time-windowed graph
// — so focusing an item can surface relations the "active since" window hides
// (the side list marks those off-window). Deduped on (ref, type, direction).
export interface RelatedRef {
  ref: string;
  type: string;
  direction: "out" | "in";
}

export function buildAdjacency(edges: ResolvedEdge[]): Map<string, RelatedRef[]> {
  const adj = new Map<string, RelatedRef[]>();
  const add = (self: string, other: string, type: string, direction: "out" | "in") => {
    const list = adj.get(self);
    if (!list) {
      adj.set(self, [{ ref: other, type, direction }]);
    } else if (!list.some((r) => r.ref === other && r.type === type && r.direction === direction)) {
      list.push({ ref: other, type, direction });
    }
  };
  for (const re of edges) {
    add(re.edge.from, re.edge.to, re.edge.type, "out");
    add(re.edge.to, re.edge.from, re.edge.type, "in");
  }
  return adj;
}

// A related item for DISPLAY: ONE card per related ref. buildAdjacency's
// per-direction entries are collapsed two ways here:
//   1. mutual edges (A mentions B AND B mentions A — reciprocal mentions are
//      common) merge their out + in into direction "both" instead of listing the
//      neighbour twice;
//   2. when an item relates via several edge TYPES, the strongest one wins
//      (closes > mentions > relates) — a PR that both closes and mentions an issue
//      shows once as "closes", since the mention is redundant with the close.
export interface RelatedItem {
  ref: string;
  type: string;
  direction: "out" | "in" | "both";
}

// Lower rank = stronger / more lifecycle-meaningful. Unknown types sit between
// mentions and relates so a future edge type still ranks deterministically.
const RELATION_RANK: Record<string, number> = { closes: 0, mentions: 1, relates: 2 };
const relationRank = (type: string): number => RELATION_RANK[type] ?? 1.5;

export function relatedItems(refs: RelatedRef[]): RelatedItem[] {
  const byRef = new Map<string, { ref: string; type: string; dirs: Set<"out" | "in"> }>();
  for (const r of refs) {
    const cur = byRef.get(r.ref);
    if (!cur) {
      byRef.set(r.ref, { ref: r.ref, type: r.type, dirs: new Set([r.direction]) });
    } else if (relationRank(r.type) < relationRank(cur.type)) {
      cur.type = r.type; // a stronger type takes over; restart its direction set
      cur.dirs = new Set([r.direction]);
    } else if (r.type === cur.type) {
      cur.dirs.add(r.direction); // same (winning) type, other direction -> mutual
    }
    // a weaker type for an already-seen ref is dropped
  }
  return [...byRef.values()].map((e) => ({
    ref: e.ref,
    type: e.type,
    direction: e.dirs.has("out") && e.dirs.has("in") ? "both" : e.dirs.has("out") ? "out" : "in",
  }));
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
