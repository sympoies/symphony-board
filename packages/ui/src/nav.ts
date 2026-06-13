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

// --- Item facets (board / graph / repo-analytics) --------------------------
//
// The shared work-item lens — source / state / kind of items. Unlike the
// Activity facets, ONE set of params is shared by all three item pages and rides
// along across every tab hop (it is the board's sticky lens, route-backed so
// reload and share links agree). Kept in distinct route fields
// (isource/istate/ikind) so it never collides with the Activity drill-down
// facets when both are present in a URL.
export type ItemFacetDim = "sources" | "states" | "kinds" | "reviews";
type ItemRouteField = "isource" | "istate" | "ikind" | "ireview";

export interface ItemFacets {
  sources: ReadonlySet<string>;
  states: ReadonlySet<string>;
  kinds: ReadonlySet<string>;
  reviews: ReadonlySet<string>;
}

const ITEM_DIM_FIELD: Record<ItemFacetDim, ItemRouteField> = {
  sources: "isource",
  states: "istate",
  kinds: "ikind",
  reviews: "ireview",
};

export const ITEM_FACET_DIMS: ItemFacetDim[] = ["sources", "states", "kinds", "reviews"];

// The closed vocabulary of the review-thread lens (fixed, not data-derived).
export const ITEM_REVIEW_VALUES = ["threads", "unresolved"] as const;

// The route fields the board/graph/repo-analytics lens reads and writes.
type ItemRouteFields = Pick<HashRoute, "isource" | "istate" | "ikind" | "ireview">;

// Route -> the active item-facet set the pages filter by AND the chips show as on.
export function itemFacets(route: ItemRouteFields): ItemFacets {
  return {
    sources: routeList(route.isource),
    states: routeList(route.istate),
    kinds: routeList(route.ikind),
    reviews: routeList(route.ireview),
  };
}

// Active item facets -> the route fields, for re-encoding into a hash.
export function itemFacetFields(facets: ItemFacets): ItemRouteFields {
  return {
    isource: listField(facets.sources),
    istate: listField(facets.states),
    ikind: listField(facets.kinds),
    ireview: listField(facets.reviews),
  };
}

export function toggleItemFacet(facets: ItemFacets, dim: ItemFacetDim, value: string): ItemFacets {
  const next = {
    sources: new Set(facets.sources),
    states: new Set(facets.states),
    kinds: new Set(facets.kinds),
    reviews: new Set(facets.reviews),
  };
  if (next[dim].has(value)) next[dim].delete(value);
  else next[dim].add(value);
  return next;
}

// Internal: exported only so a test can assert the dim<->field mapping.
export const itemFacetField = (dim: ItemFacetDim): ItemRouteField => ITEM_DIM_FIELD[dim];

// --- navigation intents ----------------------------------------------------

// The top-nav tab links. The search token, the active time range/preset, AND the
// shared item-facet lens (isource/istate/ikind) travel across a tab hop; the
// page-local drill-down state — Activity `source`/`repo`/`kind`/`action`, graph
// `focus`, commit `repo`/`branch` — does NOT. Switching tabs is a fresh
// drill-down context but keeps the sticky board lens, matching the previous
// React-state behaviour now that the lens is route-backed. Centralized and
// tested here so the rule cannot quietly drift per call site.
export function tabHref(page: Page, ctx: { q?: string | null; range?: RangeRoute; item?: ItemRouteFields }): string {
  return buildHashRoute({
    page,
    q: ctx.q ?? null,
    isource: ctx.item?.isource ?? null,
    istate: ctx.item?.istate ?? null,
    ikind: ctx.item?.ikind ?? null,
    ireview: ctx.item?.ireview ?? null,
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

// Repo Analytics -> Board drill-down for the review-thread lens. Pins the source
// facet and the review facet ("unresolved" / "threads"), and seeds the search
// with the repo path (the Board has no repo facet; project_path is in the search
// hay) so the landing board shows just that repo's matching items.
export function boardReviewsHref(opts: { source: string; repo: string | null; range: RangeRoute; value: "threads" | "unresolved" }): string | null {
  if (!opts.repo) return null;
  return buildHashRoute({
    page: "board",
    isource: opts.source,
    ireview: opts.value,
    q: opts.repo,
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
