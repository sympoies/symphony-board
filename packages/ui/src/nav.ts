// Cross-page navigation, in ONE place.
//
// The board has two ways a filter can reach a page: the shared facet `Controls`
// (React state, board/graph) and the URL hash route (every deep link and
// drill-down). They used to diverge — a Repo Analytics "reviews" link narrowed
// the Activity feed via the route, but the feed's `kind` chip never lit up
// because the chip was driven by the separate React state. This module removes
// that class of bug by making the Activity feed read its facets STRICTLY from
// the route and by owning every cross-page link here, so:
//
//   • a link, a reload, and a shared URL always agree (route is the truth), and
//   • whatever a link applies is exactly what the page renders as active,
//     clearable chips — the content filter and the chips parse the same fields.
//
// Pure functions only (no React, no DOM) so the link<->chip contract is
// unit-tested. `model.ts` owns the hash encode/decode (`buildHashRoute` /
// `parseHashRoute`) and the matching predicate (`activityRouteMatches`); this
// module owns the navigation INTENTS and the dim<->route-field mapping.

import { buildHashRoute, graphFocusHref, routeList, type HashRoute, type TimeRangePresetId } from "./model.ts";

// The board card -> graph focus link lives in model.ts (it needs ItemDTO); it is
// re-exported here so every cross-page link has a single import home.
export { graphFocusHref };

export type Page = "board" | "graph" | "activity" | "commits" | "repo-analytics" | "settings";

// The active time range a navigation should carry. `preset` is the quick-preset
// id that produced from/to, kept only as a UI tie-break.
export interface RangeRoute {
  from?: string | null;
  to?: string | null;
  preset?: TimeRangePresetId | null;
}

// --- Activity facets -------------------------------------------------------
//
// The Activity feed's transient filters are entirely route-backed. Each facet
// dimension is multi-value, serialized as a comma list in ONE route field.
export type ActivityFacetDim = "sources" | "repos" | "kinds" | "actions";

export interface ActivityFacets {
  sources: ReadonlySet<string>;
  repos: ReadonlySet<string>;
  kinds: ReadonlySet<string>;
  actions: ReadonlySet<string>;
}

// The single source of truth for dim <-> route-field. Adding a facet means one
// line here; everything else (parse, toggle, serialize) is derived from it.
const DIM_FIELD: Record<ActivityFacetDim, "source" | "repo" | "kind" | "action"> = {
  sources: "source",
  repos: "repo",
  kinds: "kind",
  actions: "action",
};

export const ACTIVITY_FACET_DIMS: ActivityFacetDim[] = ["sources", "repos", "kinds", "actions"];

// The route fields the Activity feed reads. Anything outside this set (focus,
// branch, q, from/to/preset) is owned elsewhere and untouched by facet edits.
type ActivityRouteFields = Pick<HashRoute, "source" | "repo" | "kind" | "action">;

// Route -> the active facet set the feed filters by AND the chips render as on.
export function activityFacets(route: ActivityRouteFields): ActivityFacets {
  return {
    sources: routeList(route.source),
    repos: routeList(route.repo),
    kinds: routeList(route.kind),
    actions: routeList(route.action),
  };
}

const listField = (values: ReadonlySet<string>): string | null => {
  const arr = [...values];
  return arr.length ? arr.join(",") : null;
};

// Active facets -> the four route fields, for re-encoding into a hash. Stable
// order so toggling a value yields a predictable, diffable URL.
export function activityFacetFields(facets: ActivityFacets): ActivityRouteFields {
  return {
    source: listField(facets.sources),
    repo: listField(facets.repos),
    kind: listField(facets.kinds),
    action: listField(facets.actions),
  };
}

// Flip one value in one dimension (add if absent, remove if present), returning
// the next facet set. The caller merges page/range/search and builds the hash.
export function toggleActivityFacet(facets: ActivityFacets, dim: ActivityFacetDim, value: string): ActivityFacets {
  const next = {
    sources: new Set(facets.sources),
    repos: new Set(facets.repos),
    kinds: new Set(facets.kinds),
    actions: new Set(facets.actions),
  };
  if (next[dim].has(value)) next[dim].delete(value);
  else next[dim].add(value);
  return next;
}

// --- navigation intents ----------------------------------------------------

// The top-nav tab links. ONE rule for what survives a tab hop: the search token
// and the active time range/preset travel; page-local drill-down state (facets,
// graph focus, commit repo/branch pins) does NOT — switching tabs is a fresh
// facet context. Centralized and tested here so the rule cannot quietly drift
// per call site.
export function tabHref(page: Page, ctx: { q?: string | null; range?: RangeRoute }): string {
  return buildHashRoute({
    page,
    q: ctx.q ?? null,
    from: ctx.range?.from ?? null,
    to: ctx.range?.to ?? null,
    preset: ctx.range?.preset ?? null,
  });
}

// Repo Analytics -> Activity drill-down: a repo-scoped feed, optionally pinned to
// a kind and/or action. Sets the SAME route fields the Activity chips read, so
// landing on the feed shows every applied filter as an active, removable chip.
export function activityDrilldownHref(opts: {
  source: string;
  repo: string;
  range: RangeRoute;
  kind?: string | null;
  action?: string | null;
}): string {
  return buildHashRoute({
    page: "activity",
    source: opts.source,
    repo: opts.repo,
    kind: opts.kind ?? null,
    action: opts.action ?? null,
    from: opts.range.from ?? null,
    to: opts.range.to ?? null,
    preset: opts.range.preset ?? null,
  });
}

// Repo Analytics -> Commits drill-down. The Commits page renders source/repo in
// its own repo combobox, so it reads these route fields directly (single-value,
// exact match) — no facet chips involved.
export function commitsDrilldownHref(opts: { source: string; repo: string; range: RangeRoute }): string {
  return buildHashRoute({
    page: "commits",
    source: opts.source,
    repo: opts.repo,
    from: opts.range.from ?? null,
    to: opts.range.to ?? null,
    preset: opts.range.preset ?? null,
  });
}

// Internal: exported only so a test can assert the dim<->field mapping stays in
// sync with the route shape.
export const activityFacetField = (dim: ActivityFacetDim): "source" | "repo" | "kind" | "action" => DIM_FIELD[dim];
