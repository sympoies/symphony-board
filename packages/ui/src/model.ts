// Pure view-model helpers over the contract: filtering, edge resolution, and
// small stats. No React here — easy to reason about and reuse.

import type {
  ActivityDTO,
  AggregateDTO,
  AggregateEdgeFilter,
  AggregateScope,
  ContractEnvelope,
  ItemDTO,
  EdgeDTO,
  RepoMetricDTO,
  RepoMetricSeriesPointDTO,
  ReviewThreadsDTO,
  SourceDTO,
} from "@symphony-board/contract";
import { SPOTLIGHT_LANES as SPOTLIGHT_LANE_CONFIG, type SpotlightLaneConfig } from "./spotlight.config.ts";
import { zonedDateOnly, zonedWeekday, zonedHour, zonedDayStartIso, zonedDayEndIso, shiftDateOnly } from "./tz.ts";

// The board buckets calendar days in this IANA zone (from the contract's
// `timezone`, defaulting to UTC). Threaded through the time-range presets,
// range filtering, and the activity heatmap; "UTC" keeps the original behavior.
export const DEFAULT_TIMEZONE = "UTC";

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
// board view. Each lane collects EVERY matching item (by created_at, newest
// first), REGARDLESS of open/closed/merged — so workflow-labeled issues stay
// visible even after they close. The view (FullBoard) caps how many cards render
// and shows the true total; lanes therefore return the full sorted list here. The
// lane CONVENTIONS (which labels/kinds) live in `spotlight.config.ts`; here we
// compile each declarative entry into a predicate.
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
  return SPOTLIGHT_LANES.map((lane) => ({ lane, items: items.filter(lane.pick).sort(recent) }));
}

// A board column renders as a slim rail when:
//   • non-empty: only if the viewer explicitly collapsed it (a persisted choice);
//   • empty: by default (automatic) — UNLESS the viewer clicked the rail open to
//     peek inside. `peeked` is transient (a peek reverts on reload), so an empty
//     lane (e.g. In Progress with nothing in flight) keeps reclaiming its width by
//     default while staying openable on demand.
// Routing on isEmpty — rather than OR-ing the two sets — keeps the regimes
// disjoint: a column collapsed while populated STAYS a rail even after it later
// empties. Kept here so FullBoard only renders the result and the policy stays in
// one tested place.
export function columnCollapsed(
  kind: string,
  isEmpty: boolean,
  collapsed: ReadonlySet<string>,
  peeked: ReadonlySet<string>,
): boolean {
  return isEmpty ? !peeked.has(kind) : collapsed.has(kind);
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
  // Review-thread lens: "threads" (review_threads.total > 0) and/or "unresolved"
  // (review_threads.open > 0). Empty = no review filter. OR within the set.
  reviews: ReadonlySet<string>;
  repos: ReadonlySet<string>; // exact project_path match; empty = all
}

export const emptyFilters = (): Filters => ({
  search: "",
  sources: new Set(),
  states: new Set(),
  kinds: new Set(),
  reviews: new Set(),
  repos: new Set(),
});

export function indexItems(env: ContractEnvelope): Map<string, ItemDTO> {
  return new Map(env.items.map((it) => [it.id, it]));
}

// Index used to resolve Activity review rows to their target PR's CURRENT review
// threads. A review's target can live in only ONE of two item sets, so neither
// alone is sufficient: the full-contract `items[]` is windowed (it omits a PR
// updated only inside a custom range that predates the static window), while the
// active /api/range projection omits a PR updated *after* the range. Union them
// — preferring the /api/range projection on overlap — so the unresolved lens
// resolves a review whether its target is in the static window OR the range.
//
// On overlap the range row wins because it is the fresher source: /api/range
// reads the canonical store live at request time, whereas the full contract is
// an emitted file loaded at page mount that can lag after a background sync.
export function mergeActivityIndex(
  fullVisible: ReadonlyMap<string, ItemDTO>,
  rangeProjected: ReadonlyMap<string, ItemDTO>,
): Map<string, ItemDTO> {
  const merged = new Map(fullVisible);
  for (const [id, it] of rangeProjected) merged.set(id, it);
  return merged;
}

// A DOM-safe anchor id for an item ref (refs contain '|', ':', '/'). The same
// encoding is used for the element id and the link fragment so they match.
export const anchorId = (ref: string): string => `item-${encodeURIComponent(ref)}`;

// --- hash route -----------------------------------------------------------
//
// The app routes purely on the URL hash (zero-dep): no hash / "#/" is the
// default Activity entry, "#/board" is the full board, "#/graph" relationship
// graph, "#/activity" feed, "#/settings". A board card can
// deep-link INTO the graph with a focus target — the item ref encoded as a
// query on the hash, e.g.
// "#/graph?focus=<encodeURIComponent(item.id)>". The Graph page seeds its focus
// view (and frames the camera) from it. Parse + build are kept pure here so the
// round-trip is unit-tested; refs contain '|' / ':' / '/' so they MUST be
// percent-encoded to survive the query.
export interface HashRoute {
  page: string; // "" | "board" | "graph" | "activity" | "commits" | "repo-analytics" | "settings" | "debug" (hidden; Cmd+/)
  focus: string | null; // an item ref to focus on the graph (side-list view + camera)
  q: string | null; // a search token to seed the search bar (narrows the graph)
  source: string | null; // source_id for source-aware Activity / Commits drill-downs
  repo: string | null; // a project_path the Commits page filters to
  branch: string | null; // a branch/ref name the Commits page filters to when commit refs are present
  kind: string | null; // Activity kind filter from internal drill-down links
  action: string | null; // Activity action filter from internal drill-down links
  // The shared item-facet lens for board / graph / repo-analytics: source, state,
  // and kind of work items. Distinct from the Activity `source`/`kind` fields so
  // the two never bleed when both ride the URL across a tab hop. Each is a comma
  // list (multi-select). See `nav.ts` (ItemFacets).
  isource: string | null;
  istate: string | null;
  ikind: string | null;
  // Board/graph review-thread lens: comma list of "threads" (has resolvable
  // review threads) and/or "unresolved" (open threads remain). Part of the
  // shared item lens, so it rides tab hops like isource/istate/ikind.
  ireview: string | null;
  // exact project_path pin for the board/graph lens (single value, rendered pinned; rides tab hops).
  irepo: string | null;
  // Activity-local toggle: "1" shows only review rows whose target PR/MR still
  // has open threads. Page-local (like source/kind/action), not part of the lens.
  unresolved: string | null;
  from: string | null; // YYYY-MM-DD explicit time-range start
  to: string | null; // YYYY-MM-DD explicit time-range end
  preset: TimeRangePresetId | null; // quick preset that produced from/to, for UI tie-breaks
  tab: string | null; // a sub-tab within a page (Settings: "sources" | default display)
}

const routeParam = (value: string | null | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

export function parseHashRoute(hash: string): HashRoute {
  const raw = hash.replace(/^#\/?/, "");
  const i = raw.indexOf("?");
  const page = i === -1 ? raw : raw.slice(0, i);
  const params = i === -1 ? null : new URLSearchParams(raw.slice(i + 1));
  const preset = routeParam(params?.get("preset"));
  return {
    page,
    focus: routeParam(params?.get("focus")),
    q: routeParam(params?.get("q")),
    source: routeParam(params?.get("source")),
    repo: routeParam(params?.get("repo")),
    branch: routeParam(params?.get("branch")),
    kind: routeParam(params?.get("kind")),
    action: routeParam(params?.get("action")),
    isource: routeParam(params?.get("isource")),
    istate: routeParam(params?.get("istate")),
    ikind: routeParam(params?.get("ikind")),
    ireview: routeParam(params?.get("ireview")),
    irepo: routeParam(params?.get("irepo")),
    unresolved: routeParam(params?.get("unresolved")),
    from: routeParam(params?.get("from")),
    to: routeParam(params?.get("to")),
    preset: isTimeRangePresetId(preset) ? preset : null,
    tab: routeParam(params?.get("tab")),
  };
}

export function buildHashRoute(route: { page: string; focus?: string | null; q?: string | null; source?: string | null; repo?: string | null; branch?: string | null; kind?: string | null; action?: string | null; isource?: string | null; istate?: string | null; ikind?: string | null; ireview?: string | null; irepo?: string | null; unresolved?: string | null; from?: string | null; to?: string | null; preset?: TimeRangePresetId | null; tab?: string | null }): string {
  const params: string[] = [];
  const focus = routeParam(route.focus);
  const q = routeParam(route.q);
  const source = routeParam(route.source);
  const repo = routeParam(route.repo);
  const branch = routeParam(route.branch);
  const kind = routeParam(route.kind);
  const action = routeParam(route.action);
  const isource = routeParam(route.isource);
  const istate = routeParam(route.istate);
  const ikind = routeParam(route.ikind);
  const ireview = routeParam(route.ireview);
  const irepo = routeParam(route.irepo);
  const unresolved = routeParam(route.unresolved);
  const from = routeParam(route.from);
  const to = routeParam(route.to);
  const preset = route.preset && isTimeRangePresetId(route.preset) ? route.preset : null;
  const tab = routeParam(route.tab);
  if (focus) params.push(`focus=${encodeURIComponent(focus)}`);
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  if (source) params.push(`source=${encodeURIComponent(source)}`);
  if (repo) params.push(`repo=${encodeURIComponent(repo)}`);
  if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
  if (kind) params.push(`kind=${encodeURIComponent(kind)}`);
  if (action) params.push(`action=${encodeURIComponent(action)}`);
  if (isource) params.push(`isource=${encodeURIComponent(isource)}`);
  if (istate) params.push(`istate=${encodeURIComponent(istate)}`);
  if (ikind) params.push(`ikind=${encodeURIComponent(ikind)}`);
  if (ireview) params.push(`ireview=${encodeURIComponent(ireview)}`);
  if (irepo) params.push(`irepo=${encodeURIComponent(irepo)}`);
  if (unresolved) params.push(`unresolved=${encodeURIComponent(unresolved)}`);
  if (from) params.push(`from=${encodeURIComponent(from)}`);
  if (to) params.push(`to=${encodeURIComponent(to)}`);
  if (preset) params.push(`preset=${encodeURIComponent(preset)}`);
  if (tab) params.push(`tab=${encodeURIComponent(tab)}`);
  return `#/${route.page}${params.length ? `?${params.join("&")}` : ""}`;
}

// The hash a board card links to, to open the graph on `it`: `focus` alone
// drives the side-list focus view AND the canvas — GraphPage renders the focused
// item's focusSubgraph (small by construction), so no `q` token is needed to
// keep the canvas tiny. Leaving `q` out keeps the global cross-tab search free
// of navigation state: hopping back to the Board after a deep-link no longer
// narrows it to one card. Pairs with parseHashRoute (encode here, decode there).
export const graphFocusHref = (it: ItemDTO, lens?: { isource?: string | null; istate?: string | null; ikind?: string | null; ireview?: string | null; irepo?: string | null }): string =>
  buildHashRoute({ page: "graph", focus: it.id, ...lens });

// Apply a route's "?q=" token to the filters. The URL is the source of truth for
// the visible search box: present q sets the search, absent q clears it. That
// avoids hidden search state when navigating Board ↔ Graph with plain tab links.
// Returns the SAME object when nothing changes (stable identity, so React skips a
// re-render).
export function applyRouteSearch(filters: Filters, route: HashRoute): Filters {
  const search = route.q ?? "";
  if (search === filters.search) return filters;
  return { ...filters, search };
}

// Per-item relation summary for the board card's meta row: how many DISTINCT
// items this one is related to, plus a strongest-type-first breakdown for the
// tooltip ("closes 2 · mentions 3"). Counts collapse exactly like the graph
// focus list's relatedItems(): a neighbour reached by several edge types is one
// related item under its strongest type, and reciprocal edges don't double-count.
// Keys are every edge endpoint ("any edge -> a graph node"), so map membership
// ALSO gates the card's "focus in graph" link — an item missing from the map has
// no node to focus. An untracked cross-repo ref getting an entry is harmless: it
// never matches a board item id.
export interface RelationCount {
  total: number;
  byType: Array<{ type: string; count: number }>;
}

export function relationCounts(edges: EdgeDTO[]): Map<string, RelationCount> {
  const out = new Map<string, RelationCount>();
  for (const [id, refs] of dtoAdjacency(edges)) {
    const count = relationCountOf(refs);
    if (count) out.set(id, count);
  }
  return out;
}

// The same summary for ONE item, fed from an already-built adjacency list — the
// graph side list reuses its page-level buildAdjacency() result instead of
// re-walking the edge set per card. null for an empty list (no chip); ids that
// came out of dtoAdjacency always have at least one ref.
export function relationCountOf(refs: RelatedRef[]): RelationCount | null {
  if (refs.length === 0) return null;
  const byType = new Map<string, number>();
  for (const r of relatedItems(refs)) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  return {
    total: [...byType.values()].reduce((n, c) => n + c, 0),
    byType: [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => relationRank(a.type) - relationRank(b.type) || a.type.localeCompare(b.type)),
  };
}

// Shared quick-set presets for Board, Graph, Activity, and Repo Analytics, in
// two groups the picker renders separately: `calendar` presets snap to local
// day/week boundaries (Sunday weeks), while `rolling` presets are windows of
// exactly `days` calendar days ending today (inclusive) — e.g. `1w` = 7 days.
export const TIME_RANGE_PRESETS = [
  { id: "today", label: "today", kind: "today", group: "calendar" },
  { id: "yesterday", label: "yesterday", kind: "yesterday", group: "calendar" },
  { id: "this-week", label: "this week", kind: "this-week", group: "calendar" },
  { id: "last-week", label: "last week", kind: "last-week", group: "calendar" },
  { id: "1w", label: "1w", kind: "rolling", days: 7, group: "rolling" },
  { id: "1mo", label: "1mo", kind: "rolling", days: 30, group: "rolling" },
  { id: "3mo", label: "3mo", kind: "rolling", days: 90, group: "rolling" },
  { id: "6mo", label: "6mo", kind: "rolling", days: 180, group: "rolling" },
  { id: "1y", label: "1y", kind: "rolling", days: 365, group: "rolling" },
] as const;
export type TimeRangePresetId = (typeof TIME_RANGE_PRESETS)[number]["id"];
export const DEFAULT_TIME_RANGE_PRESET_ID: TimeRangePresetId = "this-week";
export const DEFAULT_TIME_RANGE_DAYS = 90;

export interface TimeRange {
  from: string;
  to: string;
}

function generatedAtMs(env: ContractEnvelope): number {
  const parsedGenerated = Date.parse(env.generated_at);
  return Number.isFinite(parsedGenerated) ? parsedGenerated : Date.now();
}

export function isTimeRangePresetId(value: unknown): value is TimeRangePresetId {
  return typeof value === "string" && TIME_RANGE_PRESETS.some((preset) => preset.id === value);
}

export function timeRangeForPreset(presetId: TimeRangePresetId, now: number, tz: string = DEFAULT_TIMEZONE): TimeRange {
  const to = zonedDateOnly(now, tz);
  const preset = TIME_RANGE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return timeRangeForPreset(DEFAULT_TIME_RANGE_PRESET_ID, now, tz);
  if (preset.kind === "today") return { from: to, to };
  if (preset.kind === "yesterday") {
    // The most recent complete local day.
    const yesterday = shiftDateOnly(to, -1);
    return { from: yesterday, to: yesterday };
  }
  if (preset.kind === "this-week") {
    // Sunday of the local week: walk back from today's local weekday (0 = Sunday).
    const daysSinceSunday = zonedWeekday(now, tz);
    return { from: shiftDateOnly(to, -daysSinceSunday), to };
  }
  if (preset.kind === "last-week") {
    // The most recent complete Sunday..Saturday local week.
    const daysSinceSunday = zonedWeekday(now, tz);
    return { from: shiftDateOnly(to, -(daysSinceSunday + 7)), to: shiftDateOnly(to, -(daysSinceSunday + 1)) };
  }
  // Rolling window: exactly `days` calendar days ending today (inclusive), so
  // `1w` spans 7 local days (today and the 6 before it), not 8.
  return { from: shiftDateOnly(to, -(preset.days - 1)), to };
}

export function activeTimeRangePresetId(range: TimeRange, now: number, preferredPresetId?: TimeRangePresetId | null, tz: string = DEFAULT_TIMEZONE): TimeRangePresetId | null {
  const matchingPresetIds = TIME_RANGE_PRESETS
    .filter((candidate) => sameTimeRange(range, timeRangeForPreset(candidate.id, now, tz)))
    .map((candidate) => candidate.id);
  return preferredPresetId && matchingPresetIds.includes(preferredPresetId)
    ? preferredPresetId
    : (matchingPresetIds[0] ?? null);
}

export function preferredDefaultTimeRange(env: ContractEnvelope, presetId: TimeRangePresetId): TimeRange {
  return timeRangeForPreset(presetId, generatedAtMs(env), env.timezone ?? DEFAULT_TIMEZONE);
}

export function staticContractTimeRange(env: ContractEnvelope): TimeRange {
  const generatedAt = generatedAtMs(env);
  const tz = env.timezone ?? DEFAULT_TIMEZONE;
  const sinceMs =
    env.item_window?.window.kind === "active_since" && env.item_window.window.since && Number.isFinite(Date.parse(env.item_window.window.since))
      ? Date.parse(env.item_window.window.since)
      : generatedAt - DEFAULT_TIME_RANGE_DAYS * DAY_MS;
  return { from: zonedDateOnly(sinceMs, tz), to: zonedDateOnly(generatedAt, tz) };
}

export function isDateOnly(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeTimeRange(range: Partial<TimeRange> | null | undefined): TimeRange | null {
  if (!isDateOnly(range?.from) || !isDateOnly(range?.to)) return null;
  return range.from <= range.to ? { from: range.from, to: range.to } : null;
}

export function routeTimeRange(route: HashRoute): TimeRange | null {
  return normalizeTimeRange({ from: route.from ?? undefined, to: route.to ?? undefined });
}

export function sameTimeRange(a: TimeRange | null | undefined, b: TimeRange | null | undefined): boolean {
  return !!a && !!b && a.from === b.from && a.to === b.to;
}

export function timeRangeToIso(range: TimeRange, tz: string = DEFAULT_TIMEZONE): { from: string; to: string } {
  return { from: zonedDayStartIso(range.from, tz), to: zonedDayEndIso(range.to, tz) };
}

function timestampMs(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function timestampInTimeRange(value: string | null | undefined, range: TimeRange, tz: string = DEFAULT_TIMEZONE): boolean {
  const { from, to } = timeRangeToIso(range, tz);
  const valueMs = timestampMs(value);
  const fromMs = timestampMs(from);
  const toMs = timestampMs(to);
  return valueMs !== null && fromMs !== null && toMs !== null && valueMs >= fromMs && valueMs <= toMs;
}

export function itemInTimeRange(it: ItemDTO, range: TimeRange, tz: string = DEFAULT_TIMEZONE): boolean {
  return timestampInTimeRange(it.updated_at, range, tz);
}

export function activityInTimeRange(activity: ActivityDTO, range: TimeRange, tz: string = DEFAULT_TIMEZONE): boolean {
  return timestampInTimeRange(activity.occurred_at, range, tz);
}

function compareActivityInstantDesc(a: ActivityDTO, b: ActivityDTO): number {
  const aMs = timestampMs(a.occurred_at);
  const bMs = timestampMs(b.occurred_at);
  if (aMs !== null && bMs !== null && aMs !== bMs) return bMs - aMs;
  if (aMs !== null && bMs === null) return -1;
  if (aMs === null && bMs !== null) return 1;
  return 0;
}

export function filterActivitiesByRange(activities: ActivityDTO[], range: TimeRange, tz: string = DEFAULT_TIMEZONE): ActivityDTO[] {
  return activities.filter((a) => activityInTimeRange(a, range, tz)).sort(compareActivityInstantDesc);
}

// --- Activity heatmap -------------------------------------------------------
// A GitHub-style trailing-12-month calendar of activity density, derived purely
// from `occurred_at`. The Activity feed's range picker controls the *feed*; this
// overview is deliberately decoupled from it and always shows the same fixed
// trailing window so the long-term rhythm stays stable while filtering.

const DAY_MS = 86_400_000;
export const HEATMAP_WEEKS = 53;
const HEATMAP_MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export interface HeatmapCell {
  date: string; // YYYY-MM-DD local calendar date (the contract `timezone`)
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface ActivityKindCount {
  kind: string;
  count: number;
}

// The developer-significant activity kinds, in a fixed order, that the summary
// tiles surface — shared by both the "Activity overview" and "Selected range
// summary" panels so the two read identically. Other kinds (issue, branch, tag,
// repository, …) still count toward each panel's `events` total — they just
// don't get a dedicated tile. This is the single source of truth for the curated
// kind set: the trend chart's overlay lines derive from it, so the tiles and the
// chart can never drift apart. `review` is intentionally last so it anchors the
// end of both summaries.
export const ACTIVITY_SUMMARY_KINDS = ["commit", "change_request", "review"] as const;

// Project a `byKind` list (in any order) onto ACTIVITY_SUMMARY_KINDS in that
// fixed order, zero-filling any curated kind missing from the window. This is
// what keeps the two summaries aligned: the output order is driven by the
// constant, never by which kinds happened to be busiest in a given range.
export function activitySummaryKindCounts(byKind: readonly ActivityKindCount[]): ActivityKindCount[] {
  const counts = new Map(byKind.map((k) => [k.kind, k.count] as const));
  return ACTIVITY_SUMMARY_KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

export interface ActivityHeatmap {
  // Column-major: weeks[col] is one Sunday→Saturday column of 7 entries. Cells
  // before the window start or after `to` (today) are null so the grid stays a
  // clean rectangle without inventing out-of-range days.
  weeks: (HeatmapCell | null)[][];
  monthLabels: { col: number; label: string }[];
  from: string; // window start (the Sunday 52 weeks before today's week), YYYY-MM-DD
  to: string; // today, YYYY-MM-DD
  total: number; // events counted inside the window
  activeDays: number; // distinct calendar days with at least one event
  dayCount: number; // visible calendar days in the trailing window
  maxCount: number;
  busiest: HeatmapCell | null;
  byKind: ActivityKindCount[]; // descending, ties broken by kind name
}

export interface ActivityTrendPoint {
  date: string;
  label: string;
  count: number;
  average: number;
}

export type ActivityTrendBucket = "hour" | "day" | "week" | "month";

export interface ActivityTrendBusiest {
  date: string;
  label: string;
  count: number;
}

export interface ActivityTrendRepoCount {
  source_id: string;
  project_path: string | null;
  count: number;
}

// One plottable line: the aggregate ("total") or a single activity kind, with
// its points aligned 1:1 to the shared bucket axis so the chart can overlay
// several lines and let the viewer toggle / focus them.
export interface ActivityTrendSeries {
  kind: string; // "total" for the aggregate, else the activity kind
  total: number;
  maxCount: number;
  maxAverage: number;
  points: ActivityTrendPoint[];
}

export interface ActivityTrend {
  from: string;
  to: string;
  bucket: ActivityTrendBucket;
  points: ActivityTrendPoint[];
  total: number;
  activeDays: number;
  dayCount: number;
  maxCount: number;
  maxAverage: number;
  busiest: ActivityTrendBusiest | null;
  byKind: ActivityKindCount[];
  byRepo: ActivityTrendRepoCount[];
  // Chart series: total first, then one per kind seen. The total series sums the
  // curated activity kinds the chart displays, while top-level `total` / `points`
  // keep counting every selected event for summary panels.
  series: ActivityTrendSeries[];
}

// Map a per-nonzero-day count onto a 1..4 intensity using quartile thresholds of
// the observed nonzero counts. Empty days are level 0. Thresholds derive from the
// data (not fixed) so a quiet repo and a busy one each get a usable spread.
function heatmapLevelFn(counts: number[]): (count: number) => HeatmapCell["level"] {
  const nonzero = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (nonzero.length === 0) return () => 0;
  const at = (q: number) => nonzero[Math.min(nonzero.length - 1, Math.floor(q * nonzero.length))] ?? 0;
  const q1 = at(0.25);
  const q2 = at(0.5);
  const q3 = at(0.75);
  return (count) => {
    if (count <= 0) return 0;
    if (count <= q1) return 1;
    if (count <= q2) return 2;
    if (count <= q3) return 3;
    return 4;
  };
}

export function buildActivityHeatmap(
  activities: readonly ActivityDTO[],
  now: number = Date.now(),
  tz: string = DEFAULT_TIMEZONE,
): ActivityHeatmap {
  // Work in local calendar-date space so the grid and buckets honor `tz` (and
  // stay DST-immune): today's local date, its weekday, and whole-day shifts.
  const today = zonedDateOnly(now, tz);
  const endWeekday = zonedWeekday(now, tz); // 0 = Sunday
  // Last column is the week containing today; back up 52 further weeks → 53 cols.
  const startKey = shiftDateOnly(today, -(endWeekday + (HEATMAP_WEEKS - 1) * 7));

  const countByDay = new Map<string, number>();
  const kindCounts = new Map<string, number>();
  let total = 0;
  for (const a of activities) {
    const ms = timestampMs(a.occurred_at);
    if (ms === null) continue;
    const key = zonedDateOnly(ms, tz);
    // String compare is safe for fixed-width YYYY-MM-DD keys.
    if (key < startKey || key > today) continue;
    countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
    kindCounts.set(a.kind, (kindCounts.get(a.kind) ?? 0) + 1);
    total += 1;
  }

  const level = heatmapLevelFn([...countByDay.values()]);
  const activeDays = [...countByDay.values()].filter((count) => count > 0).length;
  const dayCount = daysBetween(startKey, today) + 1;
  const weeks: (HeatmapCell | null)[][] = [];
  const monthLabels: { col: number; label: string }[] = [];
  let busiest: HeatmapCell | null = null;
  let maxCount = 0;
  let prevMonth = -1;

  for (let col = 0; col < HEATMAP_WEEKS; col += 1) {
    const column: (HeatmapCell | null)[] = [];
    const colStart = shiftDateOnly(startKey, col * 7);
    const colMonth = Number(colStart.slice(5, 7)) - 1; // 0-11
    // Label a column when its Sunday opens a month not yet labelled.
    if (colMonth !== prevMonth) {
      monthLabels.push({ col, label: HEATMAP_MONTH_LABELS[colMonth] ?? "" });
      prevMonth = colMonth;
    }
    for (let row = 0; row < 7; row += 1) {
      const date = shiftDateOnly(startKey, col * 7 + row);
      if (date > today) {
        column.push(null);
        continue;
      }
      const count = countByDay.get(date) ?? 0;
      const cell: HeatmapCell = { date, count, level: level(count) };
      if (count > maxCount) {
        maxCount = count;
        busiest = cell;
      }
      column.push(cell);
    }
    weeks.push(column);
  }

  const byKind = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return { weeks, monthLabels, from: startKey, to: today, total, activeDays, dayCount, maxCount, busiest, byKind };
}

function dateOnlyUtcMs(date: string): number {
  const parts = date.split("-");
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((dateOnlyUtcMs(to) - dateOnlyUtcMs(from)) / DAY_MS));
}

function padHour(hour: number): string {
  return String(hour).padStart(2, "0");
}

function firstOfNextMonth(date: string): string {
  const parts = date.split("-");
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]), 1)).toISOString().slice(0, 10);
}

function monthBucketStart(date: string, rangeFrom: string): string {
  if (date <= rangeFrom) return rangeFrom;
  const first = `${date.slice(0, 7)}-01`;
  return first < rangeFrom ? rangeFrom : first;
}

function activityTrendBuckets(
  range: TimeRange,
  bucket: ActivityTrendBucket,
): Array<{ key: string; date: string; label: string }> {
  if (bucket === "hour") {
    return Array.from({ length: 24 }, (_, hour) => {
      const label = `${padHour(hour)}:00`;
      return { key: `${range.from}T${padHour(hour)}`, date: `${range.from}T${padHour(hour)}`, label };
    });
  }

  if (bucket === "day") {
    const out: Array<{ key: string; date: string; label: string }> = [];
    for (let date = range.from; date <= range.to; date = shiftDateOnly(date, 1)) {
      out.push({ key: date, date, label: date });
    }
    return out;
  }

  if (bucket === "week") {
    const out: Array<{ key: string; date: string; label: string }> = [];
    for (let date = range.from; date <= range.to; date = shiftDateOnly(date, 7)) {
      out.push({ key: date, date, label: date });
    }
    return out;
  }

  const out: Array<{ key: string; date: string; label: string }> = [];
  for (let date = range.from; date <= range.to; date = firstOfNextMonth(date)) {
    out.push({ key: date, date, label: date.slice(0, 7) });
  }
  return out;
}

function activityTrendBucketKey(
  day: string,
  ms: number,
  range: TimeRange,
  bucket: ActivityTrendBucket,
  tz: string,
): string {
  if (bucket === "hour") return `${day}T${padHour(zonedHour(ms, tz))}`;
  if (bucket === "day") return day;
  if (bucket === "week") {
    const bucketOffset = Math.floor(daysBetween(range.from, day) / 7) * 7;
    return shiftDateOnly(range.from, bucketOffset);
  }
  return monthBucketStart(day, range.from);
}

// Smooth a per-bucket count series into plottable points: a centered moving
// average (the line) carried alongside the raw count (the dots), using a wider
// window for the denser daily bucket. Shared by every trend line so the
// aggregate and per-kind series are smoothed identically.
function smoothTrendSeries(
  buckets: Array<{ key: string; date: string; label: string }>,
  countByKey: ReadonlyMap<string, number>,
  bucket: ActivityTrendBucket,
): { points: ActivityTrendPoint[]; maxCount: number; maxAverage: number } {
  const raw = buckets.map((point) => ({ ...point, count: countByKey.get(point.key) ?? 0 }));
  let maxCount = 0;
  let maxAverage = 0;
  const radius = bucket === "day" ? 2 : 1;
  const points = raw.map((point, index) => {
    maxCount = Math.max(maxCount, point.count);
    const start = Math.max(0, index - radius);
    const end = Math.min(raw.length, index + radius + 1);
    const sum = raw.slice(start, end).reduce((acc, next) => acc + next.count, 0);
    const average = raw.length > 1 ? sum / (end - start) : point.count;
    maxAverage = Math.max(maxAverage, average);
    return { date: point.date, label: point.label, count: point.count, average };
  });
  return { points, maxCount, maxAverage };
}

export function buildActivityTrend(
  activities: readonly ActivityDTO[],
  range: TimeRange,
  tz: string = DEFAULT_TIMEZONE,
): ActivityTrend {
  const normalized = normalizeTimeRange(range);
  if (!normalized) {
    return {
      from: range.from,
      to: range.to,
      bucket: "day",
      points: [],
      total: 0,
      activeDays: 0,
      dayCount: 0,
      maxCount: 0,
      maxAverage: 0,
      busiest: null,
      byKind: [],
      byRepo: [],
      series: [],
    };
  }

  const days = daysBetween(normalized.from, normalized.to) + 1;
  // Weekly buckets stretch through the 1y preset (366 covers a leap-year span);
  // month is only for custom multi-year ranges.
  const bucket: ActivityTrendBucket = days <= 1 ? "hour" : days <= 31 ? "day" : days <= 366 ? "week" : "month";
  const buckets = activityTrendBuckets(normalized, bucket);
  const countByKey = new Map<string, number>();
  const chartTotalCountByKey = new Map<string, number>();
  // Per-kind bucket counts, so each kind can be plotted as its own line.
  const countByKeyByKind = new Map<string, Map<string, number>>();
  const chartTotalKinds = new Set<string>(ACTIVITY_SUMMARY_KINDS);
  const kindCounts = new Map<string, number>();
  const repoCounts = new Map<string, ActivityTrendRepoCount>();
  const activeDayKeys = new Set<string>();
  let total = 0;
  let chartTotal = 0;
  for (const a of activities) {
    const ms = timestampMs(a.occurred_at);
    if (ms === null) continue;
    const day = zonedDateOnly(ms, tz);
    if (day < normalized.from || day > normalized.to) continue;
    activeDayKeys.add(day);
    const key = activityTrendBucketKey(day, ms, normalized, bucket, tz);
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
    if (chartTotalKinds.has(a.kind)) {
      chartTotalCountByKey.set(key, (chartTotalCountByKey.get(key) ?? 0) + 1);
      chartTotal += 1;
    }
    let kindKeys = countByKeyByKind.get(a.kind);
    if (!kindKeys) {
      kindKeys = new Map<string, number>();
      countByKeyByKind.set(a.kind, kindKeys);
    }
    kindKeys.set(key, (kindKeys.get(key) ?? 0) + 1);
    kindCounts.set(a.kind, (kindCounts.get(a.kind) ?? 0) + 1);
    const repoCountKey = repoKey(a.source_id, a.project_path);
    const repoCount = repoCounts.get(repoCountKey) ?? {
      source_id: a.source_id,
      project_path: a.project_path,
      count: 0,
    };
    repoCount.count += 1;
    repoCounts.set(repoCountKey, repoCount);
    total += 1;
  }

  const aggregate = smoothTrendSeries(buckets, countByKey, bucket);
  const points = aggregate.points;
  const maxCount = aggregate.maxCount;
  const maxAverage = aggregate.maxAverage;

  let busiest: ActivityTrendBusiest | null = null;
  for (const point of points) {
    if (point.count > (busiest?.count ?? 0)) {
      busiest = { date: point.date, label: point.label, count: point.count };
    }
  }

  const byKind = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const byRepo = [...repoCounts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (a.project_path ?? "").localeCompare(b.project_path ?? "") ||
      a.source_id.localeCompare(b.source_id),
  );

  // The aggregate line first, then one line per kind in `byKind` (descending)
  // order so the legend and overlay share a stable, count-ranked sequence.
  const chartAggregate = smoothTrendSeries(buckets, chartTotalCountByKey, bucket);
  const series: ActivityTrendSeries[] = [
    {
      kind: "total",
      total: chartTotal,
      maxCount: chartAggregate.maxCount,
      maxAverage: chartAggregate.maxAverage,
      points: chartAggregate.points,
    },
    ...byKind.map(({ kind, count }) => {
      const smoothed = smoothTrendSeries(buckets, countByKeyByKind.get(kind) ?? new Map(), bucket);
      return { kind, total: count, maxCount: smoothed.maxCount, maxAverage: smoothed.maxAverage, points: smoothed.points };
    }),
  ];

  return {
    from: normalized.from,
    to: normalized.to,
    bucket,
    points,
    total,
    activeDays: activeDayKeys.size,
    dayCount: days,
    maxCount,
    maxAverage,
    busiest,
    byKind,
    byRepo,
    series,
  };
}

export const ACTIVITY_ROW_HEIGHT_PX = 96;
export const ACTIVITY_ROW_GAP_PX = 6;
export const ACTIVITY_OVERSCAN_ROWS = 8;
export const ACTIVITY_DEFAULT_VIEWPORT_PX = 640;

export interface ActivityVirtualRange {
  start: number;
  end: number;
  visibleCount: number;
  totalHeightPx: number;
}

export function activityVirtualRange({
  count,
  scrollTop,
  viewportHeight,
  rowHeight = ACTIVITY_ROW_HEIGHT_PX,
  rowGap = ACTIVITY_ROW_GAP_PX,
  overscan = ACTIVITY_OVERSCAN_ROWS,
}: {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight?: number;
  rowGap?: number;
  overscan?: number;
}): ActivityVirtualRange {
  const safeCount = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
  const safeRowHeight = Math.max(1, Number.isFinite(rowHeight) ? rowHeight : ACTIVITY_ROW_HEIGHT_PX);
  const safeRowGap = Math.max(0, Number.isFinite(rowGap) ? rowGap : ACTIVITY_ROW_GAP_PX);
  const rowStride = safeRowHeight + safeRowGap;
  const totalHeightPx = safeCount === 0 ? 0 : safeCount * rowStride - safeRowGap;
  if (safeCount === 0) {
    return { start: 0, end: 0, visibleCount: 0, totalHeightPx };
  }

  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewportHeight = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : safeRowHeight);
  const safeOverscan = Math.max(0, Math.trunc(Number.isFinite(overscan) ? overscan : ACTIVITY_OVERSCAN_ROWS));
  const firstVisible = Math.min(safeCount - 1, Math.floor(safeScrollTop / rowStride));
  const viewportRows = Math.max(1, Math.ceil(safeViewportHeight / rowStride) + 1);
  const start = Math.max(0, firstVisible - safeOverscan);
  const end = Math.min(safeCount, firstVisible + viewportRows + safeOverscan);
  return { start, end, visibleCount: end - start, totalHeightPx };
}

// --- Commit timeline virtualization ---
// The commit log is variable-height: a row grows for a "Commits on <date>"
// separator and again when its body is expanded, so it can't use the fixed
// stride `activityVirtualRange` above. `buildCommitRows` lays out every row's
// offset/height once (replayable, pure), and `commitVirtualRange` walks that
// layout to pick the visible slice. The CommitTimeline component renders the
// slice; this is the pure math, kept here so it is testable and beside its
// fixed-height sibling.
export const COMMIT_ROW_BODY_HEIGHT_PX = 70;
export const COMMIT_ROW_BODY_HEIGHT_NARROW_PX = 128;
const COMMIT_DATE_SLOT_HEIGHT_PX = 22;
const COMMIT_ROW_GAP_PX = 8;
const COMMIT_EXPANDED_PANEL_CHROME_PX = 18;
const COMMIT_EXPANDED_PANEL_LINE_HEIGHT_PX = 18;
const COMMIT_EXPANDED_PANEL_MAIN_GAP_PX = 6;
export const COMMIT_DEFAULT_VIEWPORT_PX = 680;
const COMMIT_OVERSCAN_ROWS = 8;

// A commit's instant mapped to a calendar day in the viewer's timezone — the
// key the timeline groups rows under for its date separators.
function commitDateKey(iso: string, tz: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown";
  return zonedDateOnly(parsed, tz);
}

export interface CommitVirtualRow {
  commit: ActivityDTO;
  index: number;
  offset: number;
  height: number;
  showDate: boolean;
  body: string | null;
  expanded: boolean;
}

function estimateCommitBodyPanelHeight(body: string, narrow: boolean): number {
  const wrapWidth = narrow ? 44 : 96;
  const estimatedLines = body
    .split(/\r\n|\r|\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / wrapWidth)), 0);
  return COMMIT_EXPANDED_PANEL_CHROME_PX + estimatedLines * COMMIT_EXPANDED_PANEL_LINE_HEIGHT_PX;
}

export function buildCommitRows({
  commits,
  rowBodyHeight,
  expandedBodyId,
  measuredExpandedBodyHeights,
  timezone,
}: {
  commits: ActivityDTO[];
  rowBodyHeight: number;
  expandedBodyId: string | null;
  measuredExpandedBodyHeights: ReadonlyMap<string, number>;
  timezone: string;
}): { rows: CommitVirtualRow[]; totalHeightPx: number } {
  const rows: CommitVirtualRow[] = [];
  let offset = 0;
  let previousDateKey: string | null = null;
  const narrow = rowBodyHeight > COMMIT_ROW_BODY_HEIGHT_PX;

  commits.forEach((commit, index) => {
    const key = commitDateKey(commit.occurred_at, timezone);
    const showDate = previousDateKey === null || previousDateKey !== key;
    const body = commitBody(commit);
    const expanded = body !== null && commit.id === expandedBodyId;
    const bodyHeight = expanded
      ? measuredExpandedBodyHeights.get(commit.id) ??
        rowBodyHeight + estimateCommitBodyPanelHeight(body, narrow) + COMMIT_EXPANDED_PANEL_MAIN_GAP_PX
      : rowBodyHeight;
    const height = bodyHeight + (showDate ? COMMIT_DATE_SLOT_HEIGHT_PX : 0) + COMMIT_ROW_GAP_PX;
    rows.push({ commit, index, offset, height, showDate, body, expanded });
    offset += height;
    previousDateKey = key;
  });

  return { rows, totalHeightPx: offset };
}

export function commitVirtualRange({
  rows,
  totalHeightPx,
  scrollTop,
  viewportHeight,
}: {
  rows: CommitVirtualRow[];
  totalHeightPx: number;
  scrollTop: number;
  viewportHeight: number;
}): { start: number; end: number; totalHeightPx: number } {
  if (rows.length === 0) return { start: 0, end: 0, totalHeightPx: 0 };

  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewportHeight = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : COMMIT_DEFAULT_VIEWPORT_PX);
  const viewportBottom = safeScrollTop + safeViewportHeight;

  let firstVisible = 0;
  while (firstVisible < rows.length - 1 && rows[firstVisible]!.offset + rows[firstVisible]!.height <= safeScrollTop) {
    firstVisible += 1;
  }

  let endVisible = firstVisible;
  while (endVisible < rows.length && rows[endVisible]!.offset < viewportBottom) {
    endVisible += 1;
  }

  const start = Math.max(0, firstVisible - COMMIT_OVERSCAN_ROWS);
  const end = Math.min(rows.length, Math.max(endVisible, firstVisible + 1) + COMMIT_OVERSCAN_ROWS);
  return { start, end, totalHeightPx };
}

export interface ActivityDisplay {
  title: string;
  repo: string | null; // project_path, rendered with the .card-repo accent (kept out of `meta`)
  meta: string[];
  chips: string[];
}

const WORK_ITEM_ACTIVITY_KINDS = new Set(["issue", "change_request"]);

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function detailText(details: ActivityDTO["details"], key: string): string | null {
  if (!details || typeof details !== "object") return null;
  return cleanText(details[key]);
}

function detailTextList(details: ActivityDTO["details"], key: string): string[] {
  if (!details || typeof details !== "object") return [];
  const value = details[key];
  if (Array.isArray(value)) return value.map(cleanText).filter((part): part is string => part !== null);
  const single = cleanText(value);
  return single ? [single] : [];
}

function shortSha(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

function shortNonZeroSha(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0+$/.test(trimmed) ? null : shortSha(trimmed);
}

function shortRef(value: string | null): string | null {
  const ref = cleanText(value);
  return ref?.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "") ?? null;
}

function displayKind(kind: string | null | undefined): string | null {
  const k = cleanText(kind);
  if (!k) return null;
  if (k === "change_request") return "change request";
  return k.replace(/_/g, " ");
}

function isWorkItemKind(kind: string | null | undefined): boolean {
  return !!kind && WORK_ITEM_ACTIVITY_KINDS.has(kind);
}

function workItemTargetLabel(activity: ActivityDTO): string | null {
  const kind = isWorkItemKind(activity.target_kind)
    ? activity.target_kind
    : isWorkItemKind(activity.kind)
      ? activity.kind
      : null;
  const label = displayKind(kind);
  if (!label) return null;
  return activity.target_iid != null ? `${label} #${activity.target_iid}` : label;
}

function activityRefKind(activity: ActivityDTO, ref: string | null): string {
  if (activity.target_kind === "tag" || activity.kind === "tag" || ref?.startsWith("refs/tags/")) return "tag";
  if (activity.target_kind === "branch" || activity.kind === "branch" || activity.kind === "push" || ref) return "branch";
  return displayKind(activity.kind) ?? "ref";
}

function joinDistinct(parts: Array<string | null>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part && !out.includes(part)) out.push(part);
  }
  return out.join(" · ");
}

// Short label for a change_request's review-thread state, or null when there is
// nothing to show (no threads, or count unavailable). A glanceable summary, NOT
// a per-event fact — it reflects the target item's state as of its last sync.
export function reviewThreadsLabel(threads: ReviewThreadsDTO | null | undefined): string | null {
  if (!threads || threads.total <= 0) return null;
  return threads.open > 0 ? `${threads.open} open thread${threads.open === 1 ? "" : "s"}` : "threads resolved";
}

export function activityDisplay(
  activity: ActivityDTO,
  // The target change_request's review threads, when the caller resolved
  // `target_ref` to an item carrying them. Drives the review-resolution chip;
  // omitted by non-Activity callers, which then show no such chip.
  opts: { reviewThreads?: ReviewThreadsDTO | null } = {},
): ActivityDisplay {
  const title = cleanText(activity.title);
  const summary = cleanText(activity.summary);
  // repo is pulled out of `meta` so the feed can render it with the .card-repo
  // accent (teal), matching the board / commits cards; the rest stays muted.
  const repo = cleanText(activity.project_path);
  const meta = [displayKind(activity.kind), activity.actor ? `@${activity.actor}` : null].filter(
    (part): part is string => part !== null,
  );

  const chips: string[] = [];
  const sha = shortSha(detailText(activity.details, "sha"));
  if (sha) chips.push(`sha ${sha}`);

  const rawRef = detailText(activity.details, "ref");
  const ref = shortRef(rawRef);
  if (ref) chips.push(`ref ${ref}`);

  const from = shortNonZeroSha(detailText(activity.details, "commit_from") ?? detailText(activity.details, "before"));
  const to = shortNonZeroSha(detailText(activity.details, "commit_to") ?? detailText(activity.details, "after"));
  if (from) chips.push(`from ${from}`);
  if (to) chips.push(`to ${to}`);

  if (activity.kind === "review") {
    const threadChip = reviewThreadsLabel(opts.reviewThreads);
    if (threadChip) chips.push(threadChip);
  }

  const target = workItemTargetLabel(activity);
  if (target) return { title: joinDistinct([target, title ?? summary]), repo, meta, chips };

  if (activity.kind === "commit" || activity.target_kind === "commit") {
    const commitLabel = sha ? `commit ${sha}` : "commit";
    return { title: joinDistinct([commitLabel, title ?? detailText(activity.details, "message") ?? summary]), repo, meta, chips };
  }

  if (activity.kind === "push" || activity.kind === "branch" || activity.kind === "tag" || ref) {
    const kind = activityRefKind(activity, rawRef);
    return { title: ref ? `${kind} ${ref}` : (summary ?? title ?? `${activity.action} ${activity.kind}`), repo, meta, chips };
  }

  const kind = displayKind(activity.kind);
  return { title: joinDistinct([kind, title ?? summary]) || `${activity.action} ${activity.kind}`, repo, meta, chips };
}

// Does an item satisfy the review-thread lens? "threads" = has any resolvable
// review thread; "unresolved" = at least one still open. OR across the selected
// values (empty set = no constraint). A point-in-time, change_request-level
// signal — issues and unreported rows carry no review_threads, so never match.
export function itemReviewMatches(it: ItemDTO, reviews: ReadonlySet<string>): boolean {
  if (reviews.size === 0) return true;
  const rt = it.review_threads;
  if (!rt) return false;
  if (reviews.has("threads") && rt.total > 0) return true;
  if (reviews.has("unresolved") && rt.open > 0) return true;
  return false;
}

// Is this a review activity whose TARGET change_request still has open review
// threads? Resolved against the current item set, so it reflects the PR/MR's
// state as of the last sync (not the moment of the review event). Backs the
// Activity "unresolved only" toggle.
export function reviewActivityIsUnresolved(a: ActivityDTO, itemsById: ReadonlyMap<string, ItemDTO>): boolean {
  if (a.kind !== "review" || !a.target_ref) return false;
  const rt = itemsById.get(a.target_ref)?.review_threads;
  return !!rt && rt.open > 0;
}

export function itemMatches(it: ItemDTO, f: Filters): boolean {
  if (f.sources.size && !f.sources.has(it.source_id)) return false;
  if (f.states.size && !f.states.has(it.state)) return false;
  if (f.kinds.size && !f.kinds.has(it.kind)) return false;
  if (f.repos.size && !(it.project_path != null && f.repos.has(it.project_path))) return false;
  if (!itemReviewMatches(it, f.reviews)) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    // iid is intentionally NOT in the hay — it is matched ONLY via the exact
    // number term below. Putting it in the hay would reintroduce substring
    // collisions between short and longer identifiers.
    const hay = [it.title, it.author, it.project_path, it.external_id, ...it.labels.map((l) => l.name)]
      .filter((s): s is string => !!s)
      .join(" ")
      .toLowerCase();
    // AND across whitespace-separated terms. A number term is an explicit work
    // item number — matched EXACTLY against iid; every other term is a
    // case-insensitive substring of the hay. This lets a hand-typed repo+number
    // search pin exactly one item, while staying backward compatible for a plain
    // single-word search.
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

export function activityMatches(a: ActivityDTO, f: Filters): boolean {
  if (f.sources.size && !f.sources.has(a.source_id)) return false;
  if (f.kinds.size && !f.kinds.has(a.kind)) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const details = a.details ? JSON.stringify(a.details) : "";
    const hay = [a.title, a.summary, a.actor, a.project_path, a.target_kind, a.target_ref, details]
      .filter((s): s is string => !!s)
      .join(" ")
      .toLowerCase();
    for (const term of q.split(/\s+/)) {
      const num = /^#(\d+)$/.exec(term);
      if (num) {
        if (a.target_iid == null || String(a.target_iid) !== num[1]) return false;
      } else if (!hay.includes(term)) {
        return false;
      }
    }
  }
  return true;
}

// Split a route field into a SET of trimmed values. A drill-down link may carry
// one value ("review") or a comma list ("closed,merged"); the Activity content
// filter AND its facet chips both read through here, so a single drill-down
// value and a multi-select chip set parse identically. `nav.ts` owns the
// dim<->route-field mapping that produces and consumes these fields.
export function routeList(value: string | null): Set<string> {
  return new Set((value ?? "").split(",").map((part) => part.trim()).filter(Boolean));
}

export function activityRouteMatches(a: ActivityDTO, route: Pick<HashRoute, "source" | "repo" | "kind" | "action">): boolean {
  const sources = routeList(route.source);
  if (sources.size && !sources.has(a.source_id)) return false;
  const repos = routeList(route.repo);
  if (repos.size && !(a.project_path != null && repos.has(a.project_path))) return false;
  const kinds = routeList(route.kind);
  if (kinds.size && !kinds.has(a.kind)) return false;
  const actions = routeList(route.action);
  if (actions.size && !actions.has(a.action)) return false;
  return true;
}

// The Commits page is a focused SCM log over the Activity feed's `commit`
// records. Commit linking, the short SHA, message, author, and repo already ride
// on ActivityDTO, so the UI can render a provider-neutral log without a new
// contract surface.
export function isCommitActivity(a: ActivityDTO): boolean {
  return a.kind === "commit";
}

export function commitSha(activity: ActivityDTO): string | null {
  return detailText(activity.details, "sha");
}

export function commitShortSha(activity: ActivityDTO): string | null {
  return shortSha(commitSha(activity));
}

export function commitMessage(activity: ActivityDTO): string {
  return cleanText(activity.title) ?? detailText(activity.details, "message") ?? cleanText(activity.summary) ?? "Untitled commit";
}

export function commitBody(activity: ActivityDTO): string | null {
  return detailText(activity.details, "body");
}

// Branch/ref membership is optional contract detail. Producers may emit the
// default commit feed branch as `ref`/`branch`; fixtures and future richer
// producers can carry `refs`/`branches` for multi-branch membership.
export function commitBranches(activity: ActivityDTO): string[] {
  const refs = [
    ...detailTextList(activity.details, "ref"),
    ...detailTextList(activity.details, "refs"),
    ...detailTextList(activity.details, "branch"),
    ...detailTextList(activity.details, "branches"),
  ];
  const out: string[] = [];
  for (const raw of refs) {
    const ref = shortRef(raw);
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out.sort();
}

// The Commits page filters by repo and, when the contract carries branch refs,
// by exact branch. Repo and branch are exact matches because both controls offer
// closed option sets; a stale URL value intentionally narrows to zero rows.
export function filterCommits(activities: ActivityDTO[], repoPath: string | null, branchName: string | null = null, sourceId: string | null = null): ActivityDTO[] {
  const repo = repoPath?.trim() || null;
  const branch = branchName?.trim() || null;
  const source = sourceId?.trim() || null;
  return activities.filter(
    (a) =>
      isCommitActivity(a) &&
      (source === null || a.source_id === source) &&
      (repo === null || a.project_path === repo) &&
      (branch === null || commitBranches(a).includes(branch)),
  );
}

// The repo options the Commits page's typeahead suggests: only repos that
// actually have a commit in the loaded window (so we never suggest an empty
// repo), each with its commit count and source for the option label. Sorted by
// count desc, then path, so the busiest repo is the first suggestion.
export interface CommitRepoOption {
  project_path: string;
  source_id: string;
  count: number;
}

export interface CommitBranchOption {
  branch: string;
  count: number;
}

export function commitRepoOptions(commits: ActivityDTO[]): CommitRepoOption[] {
  const byPath = new Map<string, CommitRepoOption>();
  for (const c of commits) {
    if (!isCommitActivity(c) || !c.project_path) continue;
    const key = repoKey(c.source_id, c.project_path);
    const existing = byPath.get(key);
    if (existing) existing.count += 1;
    else byPath.set(key, { project_path: c.project_path, source_id: c.source_id, count: 1 });
  }
  return [...byPath.values()].sort((a, b) => b.count - a.count || a.project_path.localeCompare(b.project_path) || a.source_id.localeCompare(b.source_id));
}

export function commitBranchOptions(commits: ActivityDTO[]): CommitBranchOption[] {
  const byBranch = new Map<string, CommitBranchOption>();
  for (const c of commits) {
    if (!isCommitActivity(c)) continue;
    for (const branch of commitBranches(c)) {
      const existing = byBranch.get(branch);
      if (existing) existing.count += 1;
      else byBranch.set(branch, { branch, count: 1 });
    }
  }
  return [...byBranch.values()].sort((a, b) => b.count - a.count || a.branch.localeCompare(b.branch));
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

export function deriveRepoOptions(env: ContractEnvelope): RepoOption[] {
  const stats = env.repo_stats;
  if (stats && stats.length > 0) {
    return stats
      .map((repo) => ({
        key: repoKey(repo.source_id, repo.project_path),
        source_id: repo.source_id,
        project_path: repo.project_path,
        count: repo.items,
      }))
      .sort(
        (a, b) => a.source_id.localeCompare(b.source_id) || (a.project_path ?? "").localeCompare(b.project_path ?? ""),
      );
  }
  return deriveRepos(env.items);
}

export function itemIsPrimaryWindow(item: ItemDTO): boolean {
  return item.window_reasons === undefined || item.window_reasons.includes("primary");
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
  const activities = (env.activities ?? []).filter(
    (a) => !hiddenSources.has(a.source_id) && !hiddenRepos.has(repoKey(a.source_id, a.project_path)),
  );
  const repo_metrics = (env.repo_metrics ?? []).filter(
    (m) => !hiddenSources.has(m.source_id) && !hiddenRepos.has(repoKey(m.source_id, m.project_path)),
  );
  const edges = env.edges.filter((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return !(from && isHidden(from)) && !(to && isHidden(to));
  });
  return env.repo_metrics ? { ...env, items, edges, activities, repo_metrics } : { ...env, items, edges, activities };
}

export function repoMetricKey(source_id: string, project_path: string | null): string {
  return repoKey(source_id, project_path);
}

export function sourceDisplayName(sourceId: string | null | undefined): string {
  const raw = sourceId?.trim();
  if (!raw) return "";
  const sep = raw.indexOf(":");
  if (sep === -1) return raw;
  const host = raw.slice(sep + 1).trim();
  return host || raw;
}

export function visibleHeaderSources(sources: readonly SourceDTO[], hiddenSources: ReadonlySet<string>): readonly SourceDTO[] {
  if (hiddenSources.size === 0) return sources;
  return sources.filter((source) => !hiddenSources.has(source.source_id));
}

export function repoMetricMatches(metric: RepoMetricDTO, f: Filters): boolean {
  if (f.sources.size && !f.sources.has(metric.source_id)) return false;
  if (f.states.size && ![...f.states].some((state) => (metric.totals.by_item_state[state] ?? 0) > 0)) return false;
  if (f.kinds.size && ![...f.kinds].some((kind) => (metric.totals.by_item_kind[kind] ?? 0) > 0)) return false;
  // The exact-repo lens (irepo) is a per-repo bucket, so it maps directly onto a
  // repo metric: keep only the pinned project_path(s). Without this the board
  // drill-down would pin a clearable repo chip while the metrics table still
  // listed every repo in the source.
  if (f.repos.size && !(metric.project_path != null && f.repos.has(metric.project_path))) return false;
  const q = f.search.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    metric.source_id,
    metric.project_path,
    ...Object.keys(metric.totals.by_item_state),
    ...Object.keys(metric.totals.by_item_kind),
    ...Object.keys(metric.totals.by_activity_kind),
    ...Object.keys(metric.totals.by_activity_action),
    ...Object.keys(metric.totals.by_label_scope),
    ...(metric.top_actors ?? []).flatMap((actor) => [actor.display_name, ...(actor.aliases ?? [])]),
    ...metric.data_quality.notes,
  ]
    .filter((part): part is string => !!part)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function sortRepoMetrics(metrics: readonly RepoMetricDTO[]): RepoMetricDTO[] {
  return [...metrics].sort(
    (a, b) =>
      (b.totals.activity_score ?? 0) - (a.totals.activity_score ?? 0) ||
      b.totals.commits - a.totals.commits ||
      b.totals.change_requests_merged - a.totals.change_requests_merged ||
      b.totals.items_active - a.totals.items_active ||
      (a.project_path ?? "").localeCompare(b.project_path ?? "") ||
      a.source_id.localeCompare(b.source_id),
  );
}

// How completely a repo metric row's window is backed by observed activity. The
// Repo Analytics "Quality" badge renders this so a window with no in-range
// activity is not painted as healthy "activity":
//   no_activity — no activity rows observed at all; commit/push/comment/review
//                 metrics are unreliable (only item lifecycle is trustworthy).
//   stale       — activity coverage exists but the latest observed activity
//                 predates the window, so the in-window zeros are real dormancy.
//   partial     — the earliest observed activity falls inside the window, so
//                 counts before it are missing data, not true zero.
//   ok          — observed activity spans the window start.
// observed_since / last_activity_at are the repo's all-time bounds (the producer
// computes them across every activity row, not just the window), which is why
// they can sit outside metric.window.
export type RepoCoverage = "ok" | "partial" | "stale" | "no_activity";

export function repoCoverage(metric: RepoMetricDTO): RepoCoverage {
  const dq = metric.data_quality;
  if (!dq.activity_available) return "no_activity";
  const from = Date.parse(metric.window.from);
  if (Number.isNaN(from)) return "ok";
  const last = dq.last_activity_at ? Date.parse(dq.last_activity_at) : Number.NaN;
  if (!Number.isNaN(last) && last < from) return "stale";
  const since = dq.observed_since ? Date.parse(dq.observed_since) : Number.NaN;
  if (!Number.isNaN(since) && since > from) return "partial";
  return "ok";
}

// --- repo activity sparkline (Repo Analytics TREND column) --------------
//
// The TREND cell draws each window bucket's activity_score as a bar scaled to
// the window's busiest bucket, with a 10% floor so a small non-zero bucket
// still shows. An idle / no-activity repo (every bucket zero, or no buckets at
// all) has nothing to scale: rendering 16 floor-height bars reads as a broken
// row of dashes — a blank-looking gap. So that case collapses to `flat`, which
// the cell renders as one continuous baseline line instead.
const REPO_TREND_BUCKETS = 16;
const REPO_TREND_MIN_HEIGHT = 10;

export interface RepoTrendBar {
  value: number; // the bucket's activity score, for the per-bar tooltip
  height: number; // bar height as an integer percentage (REPO_TREND_MIN_HEIGHT..100)
}

export interface RepoTrend {
  // True when the repo had no activity across the window (idle / no buckets) —
  // render a flat baseline; `bars` is empty. Otherwise `bars` holds the trailing
  // buckets to draw.
  flat: boolean;
  bars: RepoTrendBar[];
}

export function repoTrend(series: readonly RepoMetricSeriesPointDTO[]): RepoTrend {
  const values = series.map((point) => point.stats.activity_score ?? 0);
  const visible = values.slice(-REPO_TREND_BUCKETS);
  if (!visible.some((value) => value > 0)) return { flat: true, bars: [] };
  const max = Math.max(1, ...values);
  const bars = visible.map((value) => ({
    value,
    height: Math.max(REPO_TREND_MIN_HEIGHT, Math.round((value / max) * 100)),
  }));
  return { flat: false, bars };
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
  author: string | null; // item author, for the list-card-style counts row (@author)
  color: string; // node accent (state colour)
  demand: number | null; // comments + reactions; drives node size on the graph
  created_at: string | null; // ISO; rendered (relative) on the node card
  updated_at: string | null; // ISO; rendered (relative) on the node card
  untracked: boolean;
  accentColor?: string | null; // repo/source highlight, resolved + attached by the page (not buildGraph)
  related?: RelationCount | null; // FULL relation count (chain-link chip) from the page's adjacency, attached by the page (not buildGraph)
  relatedDrawn?: number; // distinct neighbours drawn in the CURRENT canvas view — the windowed overview may draw fewer than `related.total`
}
export interface GraphLink {
  id: string;
  source: string;
  target: string;
  type: string;
  lifecycle: string | null;
  color: string; // stroke, by lifecycle
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
export type GraphMentionTarget = "all" | "issue" | "change_request";
export interface GraphOverviewVisibility {
  candidateEdges: ResolvedEdge[];
  drawnEdges: ResolvedEdge[];
  candidateIds: Set<string>;
  drawnIds: Set<string>;
}

// Night Owl hexes duplicated here ONLY because the cytoscape canvas cannot read
// CSS custom properties; keep in sync with styles.css :root.
const NODE_FILL: Record<string, string> = { open: "#addb67", closed: "#c792ea", merged: "#7e57c2", unknown: "#637777" };
const EDGE_STROKE: Record<string, string> = { declared: "#ffcb6b", fulfilled: "#addb67", broken: "#f78c6c", other: "#637777" };

// ISO cutoff for "N days ago" (browser-side; now is injectable for tests).
export function cutoffIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

export function graphEdgeInTimeRange(re: ResolvedEdge, range: TimeRange, tz: string = DEFAULT_TIMEZONE): boolean {
  const ends = [re.from, re.to];
  const within = ends.some((it) => it && timestampInTimeRange(it.updated_at, range, tz));
  const bothUntracked = !re.from && !re.to;
  return within || bothUntracked;
}

export function graphWindowEdgesInRange(edges: ResolvedEdge[], range: TimeRange, tz: string = DEFAULT_TIMEZONE): ResolvedEdge[] {
  return edges.filter((re) => graphEdgeInTimeRange(re, range, tz));
}

function endpointIds(edges: ResolvedEdge[]): Set<string> {
  const ids = new Set<string>();
  for (const re of edges) {
    ids.add(re.edge.from);
    ids.add(re.edge.to);
  }
  return ids;
}

function graphMentionVisible(re: ResolvedEdge, mentionTarget: GraphMentionTarget): boolean {
  if (re.edge.type !== "mentions") return true;
  return mentionTarget === "all" || re.to?.kind === mentionTarget;
}

export function graphOverviewVisibility(
  edges: ResolvedEdge[],
  range: TimeRange,
  tz: string = DEFAULT_TIMEZONE,
  opts: { showMentions: boolean; mentionTarget: GraphMentionTarget } = { showMentions: false, mentionTarget: "all" },
): GraphOverviewVisibility {
  const candidateEdges = graphWindowEdgesInRange(edges, range, tz);
  const drawnEdges = opts.showMentions
    ? candidateEdges.filter((re) => graphMentionVisible(re, opts.mentionTarget))
    : candidateEdges.filter((re) => re.edge.type !== "mentions");
  return {
    candidateEdges,
    drawnEdges,
    candidateIds: endpointIds(candidateEdges),
    drawnIds: endpointIds(drawnEdges),
  };
}

// Why the OVERVIEW canvas is empty while the side list still lists candidates —
// the diagnosis that turns the dead-end "No relationships are drawn" message
// into a one-click recovery. `hiddenLinks` is how many in-range relationships
// the edge filter is currently suppressing.
export type GraphCanvasEmptyReason =
  | { kind: "mentions-hidden"; hiddenLinks: number } // mentions toggle off, every candidate is a mention
  | { kind: "mention-target-filtered"; mentionTarget: GraphMentionTarget; hiddenLinks: number } // mentions on, but the target filter drops them all
  | { kind: "filtered"; hiddenLinks: number }; // suppressed for some other filter combination (defensive fallback)

// Returns null when there is nothing actionable to explain: the canvas already
// has edges to draw, or there are no candidates at all (the outer "No
// relationships in this range." state owns the latter). Only meaningful for the
// overview canvas — a focus subgraph draws every edge type regardless.
export function graphCanvasEmptyReason(
  overview: GraphOverviewVisibility,
  opts: { showMentions: boolean; mentionTarget: GraphMentionTarget },
): GraphCanvasEmptyReason | null {
  if (overview.drawnEdges.length > 0) return null; // canvas has content
  if (overview.candidateEdges.length === 0) return null; // outer empty state
  const hiddenLinks = overview.candidateEdges.length;
  if (!opts.showMentions) return { kind: "mentions-hidden", hiddenLinks };
  if (opts.mentionTarget !== "all") return { kind: "mention-target-filtered", mentionTarget: opts.mentionTarget, hiddenLinks };
  return { kind: "filtered", hiddenLinks };
}

// Build a relationship graph from already-windowed resolved edges, keeping only
// nodes that take part in an edge (no isolated-dot sea).
export function buildGraph(edges: ResolvedEdge[]): GraphData {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  let i = 0;
  for (const re of edges) {
    const ensure = (it: ItemDTO | null, ref: string) => {
      if (nodes.has(ref)) return;
      nodes.set(
        ref,
        it
          ? { id: ref, label: it.title ?? ref, repo: it.project_path ?? null, iid: it.iid ?? null, kind: it.kind, state: it.state, url: it.url ?? null, author: it.author ?? null, color: NODE_FILL[it.state] ?? "#637777", demand: it.demand ?? null, created_at: it.created_at ?? null, updated_at: it.updated_at ?? null, untracked: false }
          : { id: ref, label: ref.split("|").pop() ?? ref, repo: null, iid: null, kind: "unknown", state: "unknown", url: null, author: null, color: "#637777", demand: null, created_at: null, updated_at: null, untracked: true },
      );
    };
    ensure(re.from, re.edge.from);
    ensure(re.to, re.edge.to);
    links.push({
      id: `g${i++}`,
      source: re.edge.from,
      target: re.edge.to,
      type: re.edge.type,
      lifecycle: re.edge.lifecycle ?? null,
      color: EDGE_STROKE[re.edge.lifecycle ?? "other"] ?? "#637777",
    });
  }
  return { nodes: [...nodes.values()], links };
}

// Graph side-list ordering: actionable state first, then newest-created.
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
// in = other -> this). Built from the full resolved edge set so focusing an item
// can surface every relation available in the loaded/range payload. Deduped on
// (ref, type, direction).
export interface RelatedRef {
  ref: string;
  type: string;
  direction: "out" | "in";
}

export function buildAdjacency(edges: ResolvedEdge[]): Map<string, RelatedRef[]> {
  return dtoAdjacency(edges.map((re) => re.edge));
}

// The adjacency loop over bare DTOs — shared by buildAdjacency (graph focus,
// resolved edges) and relationCounts (board cards, which never need resolution).
function dtoAdjacency(edges: EdgeDTO[]): Map<string, RelatedRef[]> {
  const adj = new Map<string, RelatedRef[]>();
  const add = (self: string, other: string, type: string, direction: "out" | "in") => {
    const list = adj.get(self);
    if (!list) {
      adj.set(self, [{ ref: other, type, direction }]);
    } else if (!list.some((r) => r.ref === other && r.type === type && r.direction === direction)) {
      list.push({ ref: other, type, direction });
    }
  };
  for (const e of edges) {
    add(e.from, e.to, e.type, "out");
    add(e.to, e.from, e.type, "in");
  }
  return adj;
}

// Build the focus-view subgraph for the Graph page's canvas: the focused item +
// its DIRECT neighbours (the other end of every edge touching it) and EVERY edge
// among that set (the focus's own edges PLUS neighbour-neighbour links). It is
// built from the full resolved edge set with mentions INCLUDED, on
// purpose: a focus view exists to inspect ONE item's relationships, so it should
// show all of them — closes, mentions, and relates — independent of the overview
// graph's range and "+ mentions" toggle (those declutter the
// whole-graph view, not a single item's neighbourhood). Returns an empty graph
// when the focus has no edges, so the caller can fall back to the full graph.
// Pure: same inputs -> same GraphData, so it is unit-testable.
export function focusSubgraph(edges: ResolvedEdge[], focusId: string): GraphData {
  const keep = new Set<string>([focusId]);
  for (const re of edges) {
    if (re.edge.from === focusId) keep.add(re.edge.to);
    else if (re.edge.to === focusId) keep.add(re.edge.from);
  }
  const sub = edges.filter((re) => keep.has(re.edge.from) && keep.has(re.edge.to));
  return buildGraph(sub);
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

export const VIEW_SCOPES = ["global", "boardWindow", "graphWindow", "focus"] as const satisfies ReadonlyArray<AggregateScope>;
export type ViewScope = AggregateScope;

export const VIEW_SCOPE_LABEL: Record<ViewScope, string> = {
  global: "global",
  boardWindow: "board window",
  graphWindow: "graph window",
  focus: "focus",
};

export interface ScopedStats {
  scope: ViewScope;
  stats: Stats;
}

export interface ContractStatsRequest {
  scope: Exclude<ViewScope, "focus">;
  since: string;
  edgeFilter?: AggregateEdgeFilter | null;
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

export function computeGlobalStats(items: ItemDTO[], edges: EdgeDTO[]): ScopedStats {
  return { scope: "global", stats: computeStats(items, edges) };
}

export function aggregateToScopedStats(aggregate: AggregateDTO): ScopedStats {
  return {
    scope: aggregate.scope,
    stats: {
      items: aggregate.stats.items,
      byState: aggregate.stats.by_state,
      byKind: aggregate.stats.by_kind,
      byLifecycle: aggregate.stats.by_lifecycle,
    },
  };
}

export function findContractScopedStats(
  aggregates: readonly AggregateDTO[] | undefined,
  request: ContractStatsRequest,
): ScopedStats | null {
  const edgeFilter = request.edgeFilter ?? null;
  const kind = request.since === "" ? "full" : "active_since";
  const aggregate = (aggregates ?? []).find((candidate) => {
    if (candidate.scope !== request.scope) return false;
    if (candidate.window.kind !== kind) return false;
    if ((candidate.window.edge_filter ?? null) !== edgeFilter) return false;
    if (kind === "full") return candidate.window.since === null;
    return candidate.window.since?.slice(0, 10) === request.since;
  });
  return aggregate ? aggregateToScopedStats(aggregate) : null;
}

export function boardWindowEdges(items: ItemDTO[], edges: EdgeDTO[]): EdgeDTO[] {
  const ids = new Set(items.map((it) => it.id));
  return edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to));
}

export function computeBoardWindowStats(items: ItemDTO[], edges: EdgeDTO[]): ScopedStats {
  return { scope: "boardWindow", stats: computeStats(items, boardWindowEdges(items, edges)) };
}

export function computeGraphStats(graph: GraphData, scope: Extract<ViewScope, "graphWindow" | "focus">): ScopedStats {
  const byState: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const node of graph.nodes) {
    byState[node.state] = (byState[node.state] ?? 0) + 1;
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  }
  const byLifecycle: Record<string, number> = {};
  for (const link of graph.links) {
    const k = link.lifecycle ?? "other";
    byLifecycle[k] = (byLifecycle[k] ?? 0) + 1;
  }
  return { scope, stats: { items: graph.nodes.length, byState, byKind, byLifecycle } };
}

// --- UI-triggered manual sync control plane ---
// The board daemon owns the writer; the UI is a thin client over its control
// surface (see docs/DESIGN.md). These mirror the daemon's status JSON. The UI
// stays liberal in what it accepts (it never re-validates the shapes).

export type SyncMode = "incremental" | "full";
// "skipped": the daemon refused the run because another live writer held the
// store's writer lease — benign; the next scheduled tick tries again.
export type SyncRunStatusValue = "running" | "ok" | "partial" | "error" | "skipped";

export interface SyncSourceResult {
  source_id: string;
  status: string;
  items: number;
  edges: number;
  activities: number;
  soft_deleted: number;
  soft_deleted_edges: number;
  error: string | null;
}

export interface SyncRunStatus {
  run_id: string;
  trigger: "manual" | "scheduled";
  mode: SyncMode;
  dry_run: boolean;
  source_scope: string | null;
  status: SyncRunStatusValue;
  started_at: string;
  finished_at: string | null;
  emitted: boolean;
  totals: { items: number; edges: number; activities: number; soft_deleted: number; soft_deleted_edges: number } | null;
  sources: SyncSourceResult[];
  // While running: finished sources land in `sources` incrementally and this
  // names the source currently being fetched. Optional — an older daemon
  // without mid-run progress simply never sets it.
  active_source_id?: string | null;
  error: string | null;
}

export interface SyncSourceOption {
  source_id: string;
  display_name: string | null;
  kind: string;
  enabled?: boolean;
}

export interface SyncControlInfo {
  enabled: boolean;
  sources: SyncSourceOption[];
  current: SyncRunStatus | null;
  last: SyncRunStatus | null;
  interval_seconds?: number;
  full_every?: number;
}

export interface SyncRunRequest {
  mode: SyncMode;
  dry_run: boolean;
  source_id: string | null;
}

export function isSyncRunActive(run: SyncRunStatus | null | undefined): boolean {
  return !!run && run.status === "running";
}

// A finished run produced fresh data the UI should reload only when it actually
// wrote a contract: not a dry-run, it emitted, and the sync did not fail. A
// dry-run or failed run must never reload the data view as if it were fresh.
export function syncProducedFreshData(run: SyncRunStatus | null | undefined): boolean {
  return !!run && run.status !== "running" && !run.dry_run && run.emitted && (run.status === "ok" || run.status === "partial");
}

// Live per-source state for a header source chip while a run is in flight:
// "syncing" for the source currently being fetched, the fresh per-source
// outcome (ok | partial | error | skipped) for a source this run already
// finished, and null when the run says nothing about the source — the chip
// then keeps the contract's last status. Per-source progress lives here, on
// the chips, so the status text line stays short.
export function liveSourceStatus(run: SyncRunStatus | null | undefined, sourceId: string): string | null {
  if (!isSyncRunActive(run)) return null;
  if (run!.active_source_id === sourceId) return "syncing";
  return run!.sources.find((s) => s.source_id === sourceId)?.status ?? null;
}

// A short, human status line for the Sync control. now is injectable for tests.
// Running copy names the trigger (a daemon-scheduled run is not the user's
// click) and ticks elapsed time, so a long full sweep visibly makes progress.
export function syncRunSummary(run: SyncRunStatus | null | undefined, now: number = Date.now()): string {
  if (!run) return "";
  const scope = run.source_scope ? ` · ${run.source_scope}` : "";
  if (run.status === "running") {
    const verb = run.trigger === "scheduled" ? "Background sync running" : "Syncing";
    return `${verb} ${run.mode}${run.dry_run ? " dry-run" : ""}${scope}${elapsedSince(run.started_at, now)}`;
  }
  const when = relativeTime(run.finished_at ?? run.started_at, now);
  if (run.dry_run) {
    return run.status === "error" ? `Dry-run failed ${when}` : `Dry-run completed ${when}${scope}`;
  }
  if (run.status === "error") return `Sync failed ${when}${run.error ? `: ${run.error}` : ""}`;
  if (run.status === "skipped") return `Sync skipped ${when} — another writer holds the store`;
  const items = run.totals?.items ?? 0;
  const reloaded = run.emitted ? " · contract reloaded" : "";
  const partial = run.status === "partial" ? " (partial)" : "";
  return `Synced ${when}${scope} · ${items} item${items === 1 ? "" : "s"}${partial}${reloaded}`;
}

// " · 12s" / " · 2m 5s" since an ISO start; empty on a bad timestamp so the
// running line degrades to no elapsed segment instead of reading NaN.
function elapsedSince(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  return sec < 60 ? ` · ${sec}s` : ` · ${Math.floor(sec / 60)}m ${sec % 60}s`;
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

// The noun for a count: singular when exactly one, else `plural` (default the
// regular "+s"). Returns only the word — callers render the number themselves —
// so it composes both as `{n} {pluralize(n, "repo")}` and standalone. Pass an
// explicit plural for irregulars ("branch" -> "branches", "match" -> "matches").
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

// --- writer-owned config control plane (Settings -> Sources editor) ---
// The UI edits a typed subset of the producer config and round-trips every
// other field untouched (identities, exclude_actors, $comment_*, …). Server
// validation is authoritative; these types stay liberal mirrors of the
// daemon's /api/config JSON, like the sync types above.

export type ConfigProjectEntry = string | { path: string; color?: string };

export interface ConfigSourceDoc {
  source_id: string;
  kind: string;
  host: string;
  display_name?: string;
  enabled?: boolean;
  color?: string;
  token_env: string;
  fallback_token_envs?: string[];
  graphql_url: string;
  rest_url?: string;
  projects: ConfigProjectEntry[];
  [extra: string]: unknown;
}

export interface ConfigDocument {
  db_path: string;
  timezone?: string;
  sources: ConfigSourceDoc[];
  [extra: string]: unknown;
}

// Every token env-var name a source can authenticate with: the primary
// `token_env` followed by any `fallback_token_envs` (the PAT fallback pool).
// Empty names are dropped. Settings renders one secret control per entry, and a
// source counts as token-present when ANY of these is set (see
// `isSourceTokenSet`) — the daemon's `runConfiguredSync` will use a fallback
// even when the primary is absent.
export function sourceTokenEnvs(source: Pick<ConfigSourceDoc, "token_env" | "fallback_token_envs">): string[] {
  return [source.token_env, ...(source.fallback_token_envs ?? [])].filter((env) => env.length > 0);
}

// True when ANY of a source's token envs (primary or fallback) has a secret set.
export function isSourceTokenSet(
  source: Pick<ConfigSourceDoc, "token_env" | "fallback_token_envs">,
  secrets: Record<string, boolean>,
): boolean {
  return sourceTokenEnvs(source).some((env) => secrets[env] === true);
}

export interface ConfigControlInfo {
  enabled: boolean;
  config: ConfigDocument | null;
  error: string | null;
}

export interface SecretsInfo {
  enabled: boolean;
  writable: boolean;
  secrets: Record<string, boolean>;
}

export function configProjectPath(entry: ConfigProjectEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

// --- diagnostics (the hidden #/debug page) ---
// Liberal mirrors of the read-only operational surfaces: GET /api/stats (store
// statistics from the api sidecar / app server) and GET /api/logs (the writer
// daemon's in-memory recent-log tail). Neither is part of the versioned
// contract; both follow the probe pattern — any failure reads as "unavailable".

export interface StoreStatsSyncRun {
  run_id: number;
  source_id: string;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  items_seen: number;
  edges_seen: number;
  activities_seen: number;
  error: string | null;
}

export interface StoreStats {
  generated_at: string;
  db: {
    driver?: string;
    path?: string;
    database?: string;
    schema?: string;
    size_bytes?: number;
    wal_size_bytes?: number;
    page_size?: number;
    page_count?: number;
    schema_version: number;
  };
  tables: Record<string, number>;
  items: {
    live: number;
    tombstoned: number;
    by_kind: Record<string, number>;
    by_state: Record<string, number>;
    by_source: Record<string, number>;
  };
  edges: {
    live: number;
    tombstoned: number;
    by_type: Record<string, number>;
    by_lifecycle: Record<string, number>;
  };
  activities: {
    total: number;
    by_kind: Record<string, number>;
    earliest: string | null;
    latest: string | null;
  };
  sync_runs: StoreStatsSyncRun[];
}

export interface DaemonLogEntry {
  seq: number;
  ts: string;
  level: string; // "info" | "warn" | "error" (liberal: render unknown levels as-is)
  message: string;
}

export interface DaemonLogsInfo {
  enabled: boolean;
  entries: DaemonLogEntry[];
  latest_seq: number;
  capacity: number;
}

// "53.2 MiB" from a byte count, for the Diagnostics store-size pills.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  let v = n;
  for (const unit of ["KiB", "MiB", "GiB", "TiB"]) {
    v /= 1024;
    if (v < 1024) return `${v >= 100 ? Math.round(v).toString() : v.toFixed(1)} ${unit}`;
  }
  return `${Math.round(v)} PiB`;
}

// "12s" / "3m 20s" between a sync run's start and finish ("—" while running).
export function runDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

// db_path seeded into a config created in-app. Relative to the daemon's
// working directory — the standalone data dir — matching the shipped template.
export const NEW_CONFIG_DB_PATH = "data/symphony.db";

export type ConfigSourceKind = "github" | "gitlab";

// Field defaults when adding a source in the editor: canonical hosts get the
// conventional token env names and API endpoints; self-hosted instances get
// the provider's standard URL shapes and a host-derived env name.
export function suggestSourceDefaults(
  kind: ConfigSourceKind,
  hostRaw: string,
): Pick<ConfigSourceDoc, "source_id" | "kind" | "host" | "token_env" | "graphql_url" | "rest_url"> {
  const host = hostRaw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const hostSlug = host.replace(/[^a-z0-9]+/g, "_").toUpperCase();
  if (kind === "github") {
    const canonical = host === "github.com";
    return {
      source_id: `github:${host}`,
      kind,
      host,
      token_env: canonical ? "GITHUB_TOKEN" : `GITHUB_TOKEN_${hostSlug}`,
      graphql_url: canonical ? "https://api.github.com/graphql" : `https://${host}/api/graphql`,
      rest_url: canonical ? "https://api.github.com" : `https://${host}/api/v3`,
    };
  }
  const canonical = host === "gitlab.com";
  return {
    source_id: `gitlab:${host}`,
    kind,
    host,
    token_env: canonical ? "GITLAB_TOKEN" : `GITLAB_TOKEN_${hostSlug}`,
    graphql_url: `https://${host}/api/graphql`,
    rest_url: `https://${host}/api/v4`,
  };
}

// Immutable draft mutations for the Sources editor. Each returns a new
// document and leaves fields the editor does not own untouched.

export function configWithSource(doc: ConfigDocument | null, source: ConfigSourceDoc): ConfigDocument {
  const base = doc ?? { db_path: NEW_CONFIG_DB_PATH, sources: [] };
  if (base.sources.some((s) => s.source_id === source.source_id)) return base;
  return { ...base, sources: [...base.sources, source] };
}

export function configWithoutSource(doc: ConfigDocument, sourceId: string): ConfigDocument {
  return { ...doc, sources: doc.sources.filter((s) => s.source_id !== sourceId) };
}

export function configWithSourcePatch(doc: ConfigDocument, sourceId: string, patch: Partial<ConfigSourceDoc>): ConfigDocument {
  return { ...doc, sources: doc.sources.map((s) => (s.source_id === sourceId ? { ...s, ...patch } : s)) };
}

export function configWithProject(doc: ConfigDocument, sourceId: string, pathRaw: string): ConfigDocument {
  const path = pathRaw.trim();
  if (!path) return doc;
  return {
    ...doc,
    sources: doc.sources.map((s) => {
      if (s.source_id !== sourceId) return s;
      if (s.projects.some((p) => configProjectPath(p) === path)) return s;
      return { ...s, projects: [...s.projects, path] };
    }),
  };
}

export function configWithoutProject(doc: ConfigDocument, sourceId: string, path: string): ConfigDocument {
  return {
    ...doc,
    sources: doc.sources.map((s) => (s.source_id === sourceId ? { ...s, projects: s.projects.filter((p) => configProjectPath(p) !== path) } : s)),
  };
}

// Sources whose project set grew between two documents (or are entirely new):
// after a save these need a first (full) sync before their data shows up, so
// the editor offers a source-scoped run for each.
export function sourcesNeedingSync(prev: ConfigDocument | null, next: ConfigDocument | null): string[] {
  if (!next) return [];
  const prevProjects = new Map((prev?.sources ?? []).map((s) => [s.source_id, new Set(s.projects.map(configProjectPath))]));
  const prevEnabled = new Map((prev?.sources ?? []).map((s) => [s.source_id, s.enabled !== false]));
  const out: string[] = [];
  for (const s of next.sources) {
    if (s.enabled === false) continue;
    const before = prevProjects.get(s.source_id);
    if (!before) {
      out.push(s.source_id);
      continue;
    }
    if (prevEnabled.get(s.source_id) === false) {
      out.push(s.source_id);
      continue;
    }
    if (s.projects.some((p) => !before.has(configProjectPath(p)))) out.push(s.source_id);
  }
  return out;
}
