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

import { buildHashRoute, graphFocusHref, parseHashRoute, routeList, type HashRoute, type TimeRangePresetId } from "./model.ts";

// The board card -> graph focus link lives in model.ts (it needs ItemDTO); it is
// re-exported here so every cross-page link has a single import home.
export { graphFocusHref };

export type Page = "live" | "board" | "graph" | "activity" | "commits" | "reviews" | "repo-analytics" | "settings";

// Where a COLD START lands. A cold start is the app first executing its bundle:
// a fresh open, a reopen, or a reload — in all of them the in-memory route state
// is gone and the only input is the hash the host restored (the browser keeps
// `#/activity?...` across a reopen; the Tauri webview restores its last hash).
//
// The "default tab" setting is meant to decide that landing, but a restored hash
// used to win (the old rule only applied the default when the hash was empty, so
// the setting silently never took effect; the desktop launcher made it worse by
// hardcoding `#/activity`). This is the single source of truth for both hosts: a
// PLAIN tab landing yields to the configured default tab, so opening the app
// honors the setting — but an INTENTIONAL destination is kept verbatim so links,
// reloads, and shared URLs still render the same state (the nav.ts contract).
//
// A destination is intentional when it carries a drill-down field that `tabHref`
// does NOT carry across a plain tab hop: a graph `focus`, or an Activity/Commits
// page-local drill-down (source, repo, branch, kind, action, unresolved). Those
// only land on the URL via a deliberate deep-link (`activityDrilldownHref`,
// `commitsDrilldownHref`, a shared link), never on a bare tab click — so their
// presence means "keep me here".
//
// Critically, the fields `tabHref` DOES carry — the shared item lens
// (isource/istate/ikind/ireview/irepo), the search `q`, the range
// (from/to/preset), and a mobile sub-tab — are NOT identity: they ride along a
// plain tab hop, so a reopened `#/board?isource=…`, `#/graph?q=…`, or
// `#/activity?from=…&preset=1w` must STILL fall to the configured default (else
// the default-tab fix is defeated for anyone using the board/graph lens or
// search). Always-kept pages: the hidden `#/debug` console and `#/settings` (a
// deliberate place you navigated to, never a default tab), plus a hash already
// on the default tab (so its view params survive a reload).
const IDENTITY_FIELDS = [
  "focus",
  "source",
  "repo",
  "branch",
  "kind",
  "action",
  "unresolved",
] as const satisfies readonly (keyof HashRoute)[];

export function startupRouteHash(restoredHash: string, defaultTab: Page): string {
  const route = parseHashRoute(restoredHash);
  if (route.page === "debug" || route.page === "settings") return restoredHash;
  if (route.page === defaultTab) return restoredHash;
  if (route.page === "reviews" && (route.isource || route.ireview || route.irepo)) return restoredHash;
  if (IDENTITY_FIELDS.some((f) => route[f])) return restoredHash;
  return `#/${defaultTab}`;
}

// The Live tab is opt-in (off by default), so the configured default landing tab
// cannot be Live while it is disabled — a cold start would otherwise resolve to a
// hidden tab. Fall back to Activity (the next content tab) in that one case; every
// other default is honored unchanged. Resolution happens at READ time at every
// site that consumes the default tab — the landing hash (App + the desktop
// launcher in main.tsx) and the Settings picker's shown value — so the stored
// preference is never rewritten and a "live" default re-applies once Live is back
// on. Pure, so the link<->landing contract stays unit-tested.
export function resolveDefaultTab(defaultTab: Page, liveTabEnabled: boolean): Page {
  return defaultTab === "live" && !liveTabEnabled ? "activity" : defaultTab;
}

// --- Diagnostics sub-tabs --------------------------------------------------
//
// The hidden #/debug console is split into sub-tabs (see DebugPage.tsx), URL-
// backed through the shared `tab` field like Settings. The ORDER here is the
// display order, and the FIRST entry is the default landing tab — it maps to no
// `tab` param so #/debug stays clean. Kept pure (ids + parsing only; the labels
// live with the rendering in DebugPage) so the route<->tab contract is tested in
// nav.test.ts, the same as every other navigation rule.
export type DebugTab = "live" | "contract" | "store" | "sync" | "ratelimit" | "log";

export const DEBUG_TAB_IDS = ["live", "contract", "store", "sync", "ratelimit", "log"] as const satisfies readonly DebugTab[];

export const DEFAULT_DEBUG_TAB: DebugTab = DEBUG_TAB_IDS[0];

// A route `tab` value -> the active diagnostics tab. Anything unrecognized (or
// absent) falls to the default, so a stale or hand-typed hash never blanks the
// page.
export function parseDebugTab(tab: string | null): DebugTab {
  return DEBUG_TAB_IDS.includes(tab as DebugTab) ? (tab as DebugTab) : DEFAULT_DEBUG_TAB;
}

// The `tab` route value for a diagnostics tab: the default maps to null (no
// param) so #/debug is clean and a fresh open lands on the default.
export function debugTabField(tab: DebugTab): string | null {
  return tab === DEFAULT_DEBUG_TAB ? null : tab;
}

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

// --- Activity view (mobile sub-tab) ----------------------------------------
//
// On narrow viewports the Activity page shows EITHER the records feed OR the
// summary "overview" panel (overview + rhythm + trend), chosen by a segmented
// control, instead of stacking both. The choice is route-backed via the shared
// `tab` field — the same field Settings uses for its sub-tab — so a reload or a
// shared link reopens the same view. Because `tabHref` drops `tab` on a top-nav
// hop, a fresh visit to Activity always lands on the feed (the latest records),
// which is exactly the default the toggle exists to restore. On wide viewports
// both panes render side by side and the view is ignored.
export type ActivityView = "feed" | "overview";

export function activityView(route: Pick<HashRoute, "tab">): ActivityView {
  return route.tab === "overview" ? "overview" : "feed";
}

// The `tab` route value for a view. The feed is the default, so it maps to null
// (no `tab` field) to keep the URL clean and let a top-nav hop reset to the feed.
export function activityViewTab(view: ActivityView): string | null {
  return view === "overview" ? "overview" : null;
}

// --- Graph view (mobile sub-tab) -------------------------------------------
//
// The same mobile single-pane pattern, for the Graph page's coupled list +
// relationship canvas. Below the breakpoint the page shows EITHER the
// searchable/focus LIST or the React Flow CANVAS, chosen by a segmented control
// and route-backed via the shared `tab` field (`tab=graph`). The list is the
// default: it browses items AND, once one is focused (route `focus=`), surfaces
// that item's related issues/PRs inline — so selecting a node never forces the
// hard-to-touch canvas, which stays opt-in. A top-nav hop drops `tab` and lands
// back on the list. Wide viewports render both side by side and the view is
// ignored.
export type GraphView = "list" | "graph";

export function graphView(route: Pick<HashRoute, "tab">): GraphView {
  return route.tab === "graph" ? "graph" : "list";
}

// The `tab` route value for a view. The list is the default, so it maps to null
// (no `tab` field) to keep the URL clean and let a top-nav hop reset to the list.
export function graphViewTab(view: GraphView): string | null {
  return view === "graph" ? "graph" : null;
}

// --- Item facets (board / graph / repo-analytics) --------------------------
//
// The shared work-item lens — source / state / kind of items. Unlike the
// Activity facets, ONE set of params is shared by all three item pages and rides
// along across every tab hop (it is the board's sticky lens, route-backed so
// reload and share links agree). Kept in distinct route fields
// (isource/istate/ikind) so it never collides with the Activity drill-down
// facets when both are present in a URL.
export type ItemFacetDim = "sources" | "states" | "kinds" | "reviews" | "repos";
type ItemRouteField = "isource" | "istate" | "ikind" | "ireview" | "irepo";

export interface ItemFacets {
  sources: ReadonlySet<string>;
  states: ReadonlySet<string>;
  kinds: ReadonlySet<string>;
  reviews: ReadonlySet<string>;
  repos: ReadonlySet<string>;
}

const ITEM_DIM_FIELD: Record<ItemFacetDim, ItemRouteField> = {
  sources: "isource",
  states: "istate",
  kinds: "ikind",
  reviews: "ireview",
  repos: "irepo",
};

export const ITEM_FACET_DIMS: ItemFacetDim[] = ["sources", "states", "kinds", "reviews", "repos"];

// The closed vocabulary of the review-thread lens (fixed, not data-derived).
export const ITEM_REVIEW_VALUES = ["threads", "unresolved"] as const;

// The route fields the board/graph/repo-analytics lens reads and writes.
export type ItemRouteFields = Pick<HashRoute, "isource" | "istate" | "ikind" | "ireview" | "irepo">;

// Route -> the active item-facet set the pages filter by AND the chips show as on.
export function itemFacets(route: ItemRouteFields): ItemFacets {
  return {
    sources: routeList(route.isource),
    states: routeList(route.istate),
    kinds: routeList(route.ikind),
    reviews: routeList(route.ireview),
    repos: routeList(route.irepo),
  };
}

// Active item facets -> the route fields, for re-encoding into a hash.
export function itemFacetFields(facets: ItemFacets): ItemRouteFields {
  return {
    isource: listField(facets.sources),
    istate: listField(facets.states),
    ikind: listField(facets.kinds),
    ireview: listField(facets.reviews),
    irepo: listField(facets.repos),
  };
}

export function toggleItemFacet(facets: ItemFacets, dim: ItemFacetDim, value: string): ItemFacets {
  const next = {
    sources: new Set(facets.sources),
    states: new Set(facets.states),
    kinds: new Set(facets.kinds),
    reviews: new Set(facets.reviews),
    repos: new Set(facets.repos),
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
    irepo: ctx.item?.irepo ?? null,
    from: ctx.range?.from ?? null,
    to: ctx.range?.to ?? null,
    preset: ctx.range?.preset ?? null,
  });
}

// Clear the visible search/facet filters in one action while preserving view
// state that is not a filter: page, range, mobile sub-view, and graph focus.
export function clearFiltersHref(route: HashRoute, page: string = route.page): string {
  return buildHashRoute({
    page,
    focus: page === "graph" ? route.focus : null,
    from: route.from,
    to: route.to,
    preset: route.preset,
    tab: route.tab,
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
  item?: ItemRouteFields;
}): string {
  return buildHashRoute({
    page: "activity",
    source: opts.source,
    repo: opts.repo,
    kind: opts.kind ?? null,
    action: opts.action ?? null,
    isource: opts.item?.isource ?? null,
    istate: opts.item?.istate ?? null,
    ikind: opts.item?.ikind ?? null,
    ireview: opts.item?.ireview ?? null,
    irepo: opts.item?.irepo ?? null,
    from: opts.range.from ?? null,
    to: opts.range.to ?? null,
    preset: opts.range.preset ?? null,
  });
}

// Repo Analytics -> Reviews drill-down for the review-thread inbox. Pins the
// source facet, the review facet ("unresolved" / "threads"), and the exact repo
// via `irepo` (no free-text `q` substring, which collided on shared prefixes) so
// the landing tab shows just that repo's matching threads.
export function reviewThreadsHref(opts: { source: string; repo: string | null; range: RangeRoute; value: "threads" | "unresolved" }): string | null {
  if (!opts.repo) return null;
  return buildHashRoute({
    page: "reviews",
    isource: opts.source,
    ireview: opts.value,
    irepo: opts.repo,
    from: opts.range.from ?? null,
    to: opts.range.to ?? null,
    preset: opts.range.preset ?? null,
  });
}

export const boardReviewsHref = reviewThreadsHref;

// Reviews Repo Breakdown -> Thread Inbox search. This drives the visible search
// field (`q`) while also pinning source/repo facets so the link is stable on
// reload and exact when multiple sources or prefix-sharing repos exist.
export function reviewRepoSearchHref(opts: { source: string; repo: string | null; range: RangeRoute; review?: "threads" | "unresolved" | null }): string | null {
  if (!opts.repo) return null;
  return buildHashRoute({
    page: "reviews",
    q: opts.repo,
    isource: opts.source,
    ireview: opts.review ?? null,
    irepo: opts.repo,
    from: opts.range.from ?? null,
    to: opts.range.to ?? null,
    preset: opts.range.preset ?? null,
  });
}

// Repo Analytics -> Commits drill-down. The Commits page renders source/repo in
// its own repo combobox, so it reads these route fields directly (single-value,
// exact match) — no facet chips involved.
export function commitsDrilldownHref(opts: { source: string; repo: string; range: RangeRoute; item?: ItemRouteFields }): string {
  return buildHashRoute({
    page: "commits",
    source: opts.source,
    repo: opts.repo,
    isource: opts.item?.isource ?? null,
    istate: opts.item?.istate ?? null,
    ikind: opts.item?.ikind ?? null,
    ireview: opts.item?.ireview ?? null,
    irepo: opts.item?.irepo ?? null,
    from: opts.range.from ?? null,
    to: opts.range.to ?? null,
    preset: opts.range.preset ?? null,
  });
}

// Internal: exported only so a test can assert the dim<->field mapping stays in
// sync with the route shape.
export const activityFacetField = (dim: ActivityFacetDim): "source" | "repo" | "kind" | "action" => DIM_FIELD[dim];
