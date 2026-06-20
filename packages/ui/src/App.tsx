import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import { fetchContractWithMetadata, fetchRangeContract, parseContractWithMetadata, majorOf, resolveEndpoint, SUPPORTED_MAJOR, type ContractLoadMetadata } from "./contract.ts";
import {
  emptyFilters,
  activityRouteMatches,
  activityMatches,
  filterCommits,
  commitRepoOptions,
  commitBranchOptions,
  preferredDefaultTimeRange,
  staticContractTimeRange,
  activityDailyExtent,
  activityOccurredExtent,
  boardCommitTotal,
  isBoardEmpty,
  isCommitActivity,
  filterActivitiesByRange,
  indexItems,
  mergeActivityIndex,
  itemMatches,
  reviewActivityIsUnresolved,
  repoMetricMatches,
  sortRepoMetrics,
  resolveEdges,
  edgeMatches,
  deriveStatuses,
  deriveRepoOptions,
  applyVisibility,
  itemIsPrimaryWindow,
  buildColorIndex,
  resolveRepoColor,
  parseHashRoute,
  buildHashRoute,
  applyRouteSearch,
  relationCounts,
  routeTimeRange,
  sameTimeRange,
  sourceDisplayName,
  type TimeRangePresetId,
  type TimeRange,
  type Filters,
} from "./model.ts";
import {
  activityFacets,
  toggleActivityFacet,
  activityFacetFields,
  itemFacets,
  toggleItemFacet,
  itemFacetFields,
  tabHref,
  activityView,
  activityViewTab,
  graphView,
  graphViewTab,
  ITEM_REVIEW_VALUES,
  type ActivityFacetDim,
  type ActivityView,
  type GraphView,
  type ItemFacetDim,
  type Page,
} from "./nav.ts";
import {
  loadHidden,
  saveHidden,
  loadHiddenSources,
  saveHiddenSources,
  loadCollapsedColumns,
  saveCollapsedColumns,
  loadColorOverrides,
  saveColorOverrides,
  loadDefaultRangePreset,
  saveDefaultRangePreset,
  loadTheme,
  saveTheme,
  loadLivePreviewLines,
  saveLivePreviewLines,
  loadServerBaseUrl,
  saveServerBaseUrl,
  normalizeServerBaseUrl,
  type ViewTheme,
} from "./viewconfig.ts";
import { useSync } from "./useSync.ts";
import { useLiveAvailable } from "./useLive.ts";
import { useConfig } from "./useConfig.ts";
import { SourcesEditor } from "./components/SourcesEditor.tsx";
import { SyncControls } from "./components/SyncControls.tsx";
import { isRefreshShortcut, isDebugShortcut } from "./shortcuts.ts";
import { setupAutoHideScrollbars } from "./autoHideScrollbars.ts";
import { Header } from "./components/Header.tsx";
import { Controls, type ControlGroup } from "./components/Controls.tsx";
import { FullBoard } from "./components/FullBoard.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { ActivityPage } from "./components/ActivityPage.tsx";
import { CommitsPage } from "./components/CommitsPage.tsx";
import { RepoAnalyticsPage } from "./components/RepoAnalyticsPage.tsx";
import { DebugPage } from "./components/DebugPage.tsx";
import { LivePage } from "./components/LivePage.tsx";
import { TimeRangeControls } from "./components/TimeRangeControls.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { ServerConnectionForm } from "./components/ServerConnectionForm.tsx";

// The Graph page pulls in React Flow + layout libs — lazy-load it so the board
// page stays light; the chunk only loads when #/graph is opened.
const GraphPage = lazy(() => import("./components/GraphPage.tsx").then((m) => ({ default: m.GraphPage })));

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

// Stable singletons for the review-lens chip groups (avoid new Set() per render).
const EMPTY_SET: ReadonlySet<string> = new Set();
const UNRESOLVED_ON: ReadonlySet<string> = new Set(["unresolved"]);
// Chip labels for the review lens: "threads" -> "has threads", "unresolved" as-is.
const reviewFacetLabel = (v: string): string => (v === "threads" ? "has threads" : v);
type MobileControlPanel = "search" | "filters" | "range" | null;

// Pages via a zero-dep hash route: "" (first open) defaults to Activity,
// "board" (#/board) is the full-width board, "graph" (#/graph) the relationship
// graph, "activity" (#/activity) the event feed,
// "commits" (#/commits) the cross-repo commit log, "repo-analytics"
// (#/repo-analytics) the per-repo metrics view, and "settings" (#/settings) the
// persistent repo display filter. "debug" (#/debug) is the hidden Diagnostics
// page — not in the nav, toggled with Cmd+/ (Ctrl+/) or by typing the hash.
// The route may carry "?q=<search>" so the
// visible search box is URL-backed; graph routes may also carry "?focus=<ref>",
// written by a board-card deep-link AND by every in-graph focus change
// (setRouteFocus), and commits routes carry "?repo=<project_path>" and
// "?branch=<branch>" for the page-local SCM filters.
const readHash = (): string => (typeof location !== "undefined" ? location.hash : "");

export function App() {
  const [env, setEnv] = useState<ContractEnvelope | null>(null);
  const [contractMeta, setContractMeta] = useState<ContractLoadMetadata | null>(null);
  const [rangeEnv, setRangeEnv] = useState<ContractEnvelope | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingData, setRefreshingData] = useState(false);
  // Seed the search from the hash's "?q=" token if present; the URL is the source
  // of truth, so reloading/share links and Board ↔ Graph tab hops agree.
  const [filters, setFilters] = useState<Filters>(() => applyRouteSearch(emptyFilters(), parseHashRoute(readHash())));
  const [mobileControlPanel, setMobileControlPanel] = useState<MobileControlPanel>(null);
  const [hash, setHash] = useState<string>(readHash);
  // Persistent display preferences (the Settings page), loaded once from
  // localStorage and saved back on every change:
  //   • hidden        — HIDDEN repoKeys
  //   • hiddenSources — HIDDEN source_ids (an independent layer; see applyVisibility)
  //   • colorOverrides — repoKey -> hex, this viewer's per-repo highlight override
  //   • defaultRangePreset — which quick preset is used when the route has no from/to
  //   • theme — DEVICE-LOCAL palette preference (per browser / Android WebView)
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(loadHiddenSources);
  const [colorOverrides, setColorOverrides] = useState<Map<string, string>>(loadColorOverrides);
  const [defaultRangePreset, setDefaultRangePreset] = useState<TimeRangePresetId>(loadDefaultRangePreset);
  const [theme, setTheme] = useState<ViewTheme>(loadTheme);
  const [livePreviewLines, setLivePreviewLines] = useState<number>(loadLivePreviewLines);
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(loadServerBaseUrl);
  // Board columns the viewer manually collapsed to a rail (persisted). Empty
  // columns auto-collapse without being stored here; `peekedColumns` is the
  // transient opposite — empty columns the viewer clicked open to peek inside,
  // deliberately NOT persisted so a peek reverts on reload. See
  // model.columnCollapsed for how the two combine.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(loadCollapsedColumns);
  const [peekedColumns, setPeekedColumns] = useState<Set<string>>(() => new Set());

  // Scrollbars hide at rest and reveal on scroll (see autoHideScrollbars.ts and the
  // data-scrolling rules in styles.css).
  useEffect(() => setupAutoHideScrollbars(), []);

  useEffect(() => {
    const onHash = () => {
      const h = readHash();
      setHash(h);
      // A route carrying "?q=" applies its search token in the SAME update as the
      // route change (batched); absent q clears search, matching the URL.
      setFilters((prev) => applyRouteSearch(prev, parseHashRoute(h)));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const route = useMemo(() => parseHashRoute(hash), [hash]);
  const page =
    route.page === "live"
      ? "live"
      : route.page === "board"
      ? "board"
      : route.page === "graph"
        ? "graph"
        : route.page === "commits"
          ? "commits"
          : route.page === "repo-analytics" || route.page === "repos"
            ? "repo-analytics"
            : route.page === "settings"
              ? "settings"
              : "activity";
  useEffect(() => {
    setMobileControlPanel(null);
  }, [page]);
  // The shared item-facet lens (source/state/kind) for board / graph /
  // repo-analytics, read STRICTLY from the URL route (isource/istate/ikind) — the
  // single source of truth shared by the content filters AND the chips. One set
  // is shared by all three pages and carried across tab hops (see nav.tabHref),
  // kept distinct from the Activity feed's own source/repo/kind/action facets.
  const itemFacetState = useMemo(
    () => itemFacets(route),
    [route.isource, route.istate, route.ikind, route.ireview, route.irepo],
  );
  // A Filters view the item matchers (itemMatches / edgeMatches /
  // repoMetricMatches) consume: the route-backed item facets plus the URL-backed
  // search term. The React `filters` state now only carries `search`.
  const itemFilters = useMemo<Filters>(
    () => ({ search: filters.search, sources: itemFacetState.sources, states: itemFacetState.states, kinds: itemFacetState.kinds, reviews: itemFacetState.reviews, repos: itemFacetState.repos }),
    [filters.search, itemFacetState],
  );
  // The zone the contract buckets calendar days in (default UTC). Threaded into
  // every preset / range-filter / day-bucketing call so the UI's calendar days
  // match the configured timezone.
  const tz = env?.timezone ?? "UTC";
  const staticRange = useMemo(() => (env ? staticContractTimeRange(env) : null), [env]);
  // True data extents for the UNWINDOWED Activity / Commits feeds (staticRange is
  // only the 90-day item window, so it would understate older history and make
  // "Show all" / the extent copy overpromise). Board / Graph / Repo stay on
  // staticRange since their data is item-windowed. Fall back to staticRange when
  // there are no activities to measure.
  // Measure the true activity span from activity_daily (full history) rather than
  // the raw activities[] feed, which 4.0.0 windows to 30 days — otherwise
  // "Show all" / the extent copy would understate older history. Fall back to the
  // raw feed for a pre-4.0.0 contract that carries no activity_daily.
  const activityDataExtent = useMemo(
    () =>
      env
        ? (env.activity_daily ? activityDailyExtent(env.activity_daily) : activityOccurredExtent(env.activities ?? [], tz)) ?? staticRange
        : null,
    [env, tz, staticRange],
  );
  const commitDataExtent = useMemo(
    () =>
      env
        ? (env.activity_daily
            ? activityDailyExtent(env.activity_daily, "commit")
            : activityOccurredExtent(env.activities ?? [], tz, isCommitActivity)) ?? staticRange
        : null,
    [env, tz, staticRange],
  );
  const defaultRange = useMemo(() => (env ? preferredDefaultTimeRange(env, defaultRangePreset) : null), [env, defaultRangePreset]);
  const explicitRange = useMemo(() => routeTimeRange(route), [route]);
  const activeRange = explicitRange ?? defaultRange;
  const customRange = !!activeRange && !!staticRange && !sameTimeRange(activeRange, staticRange);
  const needsRangeEnv = customRange && page !== "settings";

  // Reload the active data in place after a successful manual sync. It only
  // re-fetches the contract (and the range response for a custom range); the
  // route, search, filters, time range, and display preferences are URL/state
  // backed and untouched, so they survive the reload.
  const reloadData = useCallback(async (): Promise<boolean> => {
    const pending: Promise<void>[] = [];
    let loadedContract = false;
    pending.push(fetchContractWithMetadata(undefined, serverBaseUrl)
      .then((loaded) => {
        setEnv(loaded.env);
        setContractMeta(loaded.meta);
        setError(null);
        loadedContract = true;
      })
      .catch((err: unknown) => setError((err as Error).message)));
    if (needsRangeEnv && activeRange) {
      setRangeLoading(true);
      setRangeError(null);
      pending.push(fetchRangeContract(activeRange, serverBaseUrl)
        .then((next) => {
          setRangeEnv(next);
          setRangeError(null);
        })
        .catch((err: unknown) => setRangeError((err as Error).message))
        .finally(() => setRangeLoading(false)));
    }
    await Promise.all(pending);
    return loadedContract;
  }, [needsRangeEnv, activeRange, serverBaseUrl]);
  const reloadDataAfterSync = useCallback(async () => {
    await reloadData();
  }, [reloadData]);
  const refreshData = useCallback(() => {
    setRefreshingData(true);
    void reloadData().finally(() => setRefreshingData(false));
  }, [reloadData]);
  const sync = useSync(reloadDataAfterSync, serverBaseUrl);
  // Probe the live receiver so the Live tab appears only where it is reachable
  // (hidden on the standalone app and any deployment without the receiver).
  const liveAvailable = useLiveAvailable(serverBaseUrl);
  const configState = useConfig(serverBaseUrl);
  // Settings sub-tab, URL-backed so refresh and deep links keep it. Only the
  // "sources" value is meaningful; anything else renders the Display tab.
  const settingsTab = route.tab === "sources" ? ("sources" as const) : ("display" as const);
  const setSettingsTab = useCallback((tab: "display" | "sources") => {
    const current = parseHashRoute(readHash());
    const next = buildHashRoute({ ...current, page: "settings", tab: tab === "sources" ? "sources" : null });
    if (readHash() !== next) window.location.hash = next;
  }, []);
  // Activity mobile sub-view (Feed default / Overview), URL-backed through the
  // same `tab` field so reload and share links agree; a top-nav hop drops `tab`
  // and lands back on the feed.
  const activityViewValue = activityView(route);
  const setActivityView = useCallback((next: ActivityView) => {
    const current = parseHashRoute(readHash());
    const nextHash = buildHashRoute({ ...current, page: "activity", tab: activityViewTab(next) });
    if (readHash() !== nextHash) window.location.hash = nextHash;
  }, []);
  // Graph mobile sub-view (List default / Graph canvas), URL-backed through the
  // same `tab` field; a top-nav hop drops `tab` and lands back on the list. The
  // focused item stays in its own `focus` route field, so the toggle and the
  // selection are independent — selecting never forces the canvas.
  const graphViewValue = graphView(route);
  const setGraphView = useCallback((next: GraphView) => {
    const current = parseHashRoute(readHash());
    const nextHash = buildHashRoute({ ...current, page: "graph", tab: graphViewTab(next) });
    if (readHash() !== nextHash) window.location.hash = nextHash;
  }, []);

  // Where Cmd+/ returns to when leaving the Diagnostics page: the last
  // non-debug hash seen (covers entering #/debug by URL too; "#/" otherwise).
  const lastNonDebugHash = useRef<string>("#/");
  useEffect(() => {
    if (route.page !== "debug") lastNonDebugHash.current = hash || "#/";
  }, [route.page, hash]);

  const toggleDebug = useCallback(() => {
    if (typeof window === "undefined") return;
    window.location.hash = parseHashRoute(readHash()).page === "debug" ? lastNonDebugHash.current : "#/debug";
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isDebugShortcut(event)) {
        event.preventDefault();
        toggleDebug();
        return;
      }
      if (!isRefreshShortcut(event)) return;
      event.preventDefault();
      refreshData();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refreshData, toggleDebug]);

  useEffect(() => {
    saveHidden(hidden);
  }, [hidden]);
  useEffect(() => {
    saveHiddenSources(hiddenSources);
  }, [hiddenSources]);
  useEffect(() => {
    saveColorOverrides(colorOverrides);
  }, [colorOverrides]);
  useEffect(() => {
    saveDefaultRangePreset(defaultRangePreset);
  }, [defaultRangePreset]);
  useEffect(() => {
    saveTheme(theme);
  }, [theme]);
  useEffect(() => {
    saveLivePreviewLines(livePreviewLines);
  }, [livePreviewLines]);
  useEffect(() => {
    saveCollapsedColumns(collapsedColumns);
  }, [collapsedColumns]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme === "paper" ? "light" : "dark";
  }, [theme]);

  const applyServerBaseUrl = useCallback((nextRaw: string | null) => {
    saveServerBaseUrl(normalizeServerBaseUrl(nextRaw));
    setServerBaseUrl(loadServerBaseUrl());
    setEnv(null);
    setContractMeta(null);
    setRangeEnv(null);
    setError(null);
    setRangeError(null);
    setLoading(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchContractWithMetadata(undefined, serverBaseUrl)
      .then((loaded) => {
        if (cancelled) return;
        setEnv(loaded.env);
        setContractMeta(loaded.meta);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl]);

  useEffect(() => {
    if (!activeRange || !staticRange) return;
    if (!needsRangeEnv) {
      setRangeEnv(null);
      setRangeError(null);
      setRangeLoading(false);
      return;
    }
    let cancelled = false;
    setRangeLoading(true);
    setRangeError(null);
    fetchRangeContract(activeRange, serverBaseUrl)
      .then((next) => {
        if (!cancelled) setRangeEnv(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRangeEnv(null);
          setRangeError((err as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) setRangeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRange, needsRangeEnv, serverBaseUrl, staticRange]);

  const activeEnv = needsRangeEnv ? rangeEnv : env;
  const chromeEnv = activeEnv ?? env;

  // The visibility pre-filter is applied FIRST: visibleEnv is the contract
  // narrowed to the repos + sources the Settings page leaves visible (items +
  // their edges). Everything below — facets, filters, stats, statuses — works
  // over visibleEnv, so a hidden repo/source disappears from every page. allRepos
  // is derived over the FULL contract so the Settings page can still list (and
  // re-enable) hidden repos.
  const visibleEnv = useMemo(() => (chromeEnv ? applyVisibility(chromeEnv, hidden, hiddenSources) : null), [chromeEnv, hidden, hiddenSources]);
  const primaryItems = useMemo(() => (visibleEnv ? visibleEnv.items.filter(itemIsPrimaryWindow) : []), [visibleEnv]);
  // Item index by ref for the edge resolver. When a historical range is active,
  // visibleEnv is the /api/range projection, so this index is intentionally
  // range-scoped (exactly the projected items + their edge endpoints).
  const itemsById = useMemo(() => (visibleEnv ? indexItems(visibleEnv) : new Map()), [visibleEnv]);
  // Index for resolving Activity review rows to their target PR's CURRENT review
  // threads. A review's target can live in only one of two item sets: the full
  // visible contract `items[]` is 90-day windowed (omits a PR updated only in a
  // custom range that predates the window), while the active /api/range
  // projection omits a PR updated *after* the range. Resolving against either
  // alone makes ?unresolved=1 wrongly hide real unresolved reviews (and drop the
  // thread chip), so union both. Visibility (hidden repos/sources) applies to
  // both. With no range active this equals itemsById.
  const fullVisibleEnv = useMemo(() => (env ? applyVisibility(env, hidden, hiddenSources) : null), [env, hidden, hiddenSources]);
  const activityItemsById = useMemo(
    () => mergeActivityIndex(fullVisibleEnv ? indexItems(fullVisibleEnv) : new Map(), itemsById),
    [fullVisibleEnv, itemsById],
  );
  const allRepos = useMemo(() => (env ? deriveRepoOptions(env) : []), [env]);
  const windowedActivities = useMemo(
    () => (visibleEnv && activeRange ? filterActivitiesByRange(visibleEnv.activities ?? [], activeRange, tz) : []),
    [visibleEnv, activeRange, tz],
  );
  const repoMetrics = useMemo(
    () => sortRepoMetrics((visibleEnv?.repo_metrics ?? []).filter((metric) => repoMetricMatches(metric, itemFilters))),
    [visibleEnv, itemFilters],
  );

  // Highlight color: the config layers (per-repo + per-source) ride in on the
  // contract; the per-repo override is this viewer's localStorage. colorOf
  // resolves an item's effective color (override -> repo -> source -> none) and
  // is handed to the board cards and graph nodes/side-list.
  const colorIndex = useMemo(() => (env ? buildColorIndex(env) : null), [env]);
  const colorOf = useCallback(
    (source_id: string, project_path: string | null): string | null =>
      colorIndex ? resolveRepoColor(source_id, project_path, colorIndex, colorOverrides) : null,
    [colorIndex, colorOverrides],
  );

  const facets = useMemo(() => {
    if (!visibleEnv) return { sources: [], states: [], kinds: [], actions: [], reviews: [] };
    if (page === "activity") {
      // `actions` is an Activity-only facet (issue opened/closed, PR merged, …):
      // it is what the Repo Analytics drill-downs pin, so the feed must offer it
      // as a visible chip. Other pages have no action dimension. `reviews` here
      // is the single-value "unresolved only" toggle, shown only when the window
      // actually has review rows to filter.
      return {
        sources: uniq(windowedActivities.map((a) => a.source_id)),
        states: [],
        kinds: uniq(windowedActivities.map((a) => a.kind)),
        actions: uniq(windowedActivities.map((a) => a.action)),
        reviews: windowedActivities.some((a) => a.kind === "review") ? ["unresolved"] : [],
      };
    }
    if (page === "repo-analytics") {
      const metrics = visibleEnv.repo_metrics ?? [];
      return {
        sources: uniq(metrics.map((m) => m.source_id)),
        states: uniq(metrics.flatMap((m) => Object.keys(m.totals.by_item_state))),
        kinds: uniq(metrics.flatMap((m) => Object.keys(m.totals.by_item_kind))),
        actions: [],
        reviews: [], // repo-analytics filters metrics, not items; no review lens
      };
    }
    const facetItems = page === "graph" ? visibleEnv.items : primaryItems;
    // The review lens (board/graph): offer the chips only when some item carries
    // review threads, so a board with no review data shows no empty toggle.
    const hasReviewThreads = facetItems.some((i) => i.review_threads != null && i.review_threads.total > 0);
    return {
      sources: uniq(facetItems.map((i) => i.source_id)),
      states: uniq(facetItems.map((i) => i.state)),
      kinds: uniq(facetItems.map((i) => i.kind)),
      actions: [],
      reviews: hasReviewThreads ? [...ITEM_REVIEW_VALUES] : [],
    };
  }, [visibleEnv, page, windowedActivities, primaryItems]);

  // source_id -> provider kind (github / gitlab), so a card can show its source
  // mark. Provider kind lives on SourceDTO, not the item — look it up here once.
  const sourceKind = useMemo(
    () => new Map((activeEnv?.sources ?? []).map((s) => [s.source_id, s.kind])),
    [activeEnv],
  );

  const filteredItems = useMemo(
    () => primaryItems.filter((i) => itemMatches(i, itemFilters)),
    [primaryItems, itemFilters],
  );

  // The Activity feed's facets (source/repo/kind/action) are route-backed — the
  // single source of truth shared by the content filter AND the visible chips,
  // so a drill-down link always lands with its filters lit up and clearable.
  const activityFacetState = useMemo(
    () => activityFacets(route),
    [route.source, route.repo, route.kind, route.action],
  );

  const routeActivities = useMemo(
    () => windowedActivities.filter((a) => activityRouteMatches(a, route)),
    [windowedActivities, route.source, route.repo, route.kind, route.action],
  );

  // routeActivities already applied the route facets; here we layer ONLY the
  // URL-backed search term. The shared React `filters` (board/graph chips) is
  // deliberately not consulted, so a board kind filter no longer bleeds into the
  // feed.
  const filteredActivities = useMemo(() => {
    const base = routeActivities.filter((a) => activityMatches(a, { ...emptyFilters(), search: filters.search }));
    // "unresolved only" (?unresolved=1): keep just the review rows whose target
    // PR/MR still has open threads. Resolves target_ref against the full visible
    // contract so an in-range review on a later-updated PR is not lost.
    return route.unresolved === "1" ? base.filter((a) => reviewActivityIsUnresolved(a, activityItemsById)) : base;
  }, [routeActivities, filters.search, route.unresolved, activityItemsById]);

  // The chip groups the shared Controls renders, built per page — every page now
  // drives its chips STRICTLY from the route. Activity uses its own
  // source/repo/kind/action facets (the repo group is a "pinned" mode showing
  // only the active drill-down repo); board / graph / repo-analytics share the
  // item-facet lens (isource/istate/ikind). Toggling any chip rewrites the URL.
  const controlGroups = useMemo<ControlGroup[]>(() => {
    if (page === "activity") {
      return [
        { dim: "sources", label: "source", values: facets.sources, active: activityFacetState.sources, displayValue: sourceDisplayName },
        { dim: "kinds", label: "kind", values: facets.kinds, active: activityFacetState.kinds },
        { dim: "actions", label: "action", values: facets.actions, active: activityFacetState.actions },
        // Boolean "unresolved only" switch (toggle mode shows the single value);
        // dim "unresolved" is dispatched to its own route flag, not a facet.
        { dim: "unresolved", label: "review", values: facets.reviews, active: route.unresolved === "1" ? UNRESOLVED_ON : EMPTY_SET, displayValue: reviewFacetLabel, mode: "toggle" },
        { dim: "repos", label: "repo", values: [...activityFacetState.repos], active: activityFacetState.repos, mode: "pinned" },
      ];
    }
    // board / graph / repo-analytics share the item lens.
    const groups: ControlGroup[] = [
      { dim: "sources", label: "source", values: facets.sources, active: itemFacetState.sources, displayValue: sourceDisplayName },
      { dim: "states", label: "state", values: facets.states, active: itemFacetState.states },
      { dim: "kinds", label: "kind", values: facets.kinds, active: itemFacetState.kinds },
    ];
    // The review lens filters items (board/graph) but not aggregated repo
    // metrics (repoMetricMatches has no review predicate), so omit it on
    // repo-analytics — otherwise an active ireview would render an inert,
    // never-clearing-anything chip there. It stays clearable on board/graph.
    if (page !== "repo-analytics") {
      groups.push({ dim: "reviews", label: "review", values: facets.reviews, active: itemFacetState.reviews, displayValue: reviewFacetLabel });
    }
    // Exact-repo pin: a drill-down sets it; rendered pinned (only the active
    // value shows as a removable chip), like the Activity feed's repo pin. Honored
    // by both itemMatches (board/graph) and repoMetricMatches (repo-analytics).
    groups.push({ dim: "repos", label: "repo", values: [...itemFacetState.repos], active: itemFacetState.repos, mode: "pinned" });
    return groups;
  }, [page, facets, itemFacetState, activityFacetState, route.unresolved]);

  // The Commits page is a focused SCM log over commit records, with SCM filters
  // in the URL. windowCommits is every commit in the
  // shared range (the window total + repo option source); repoCommits narrows to
  // the selected repo for branch options; commits applies the optional branch
  // filter when commit rows carry branch/ref details.
  const windowCommits = useMemo(() => filterCommits(windowedActivities, null), [windowedActivities]);
  const repoCommits = useMemo(() => filterCommits(windowedActivities, route.repo, null, route.source), [windowedActivities, route.repo, route.source]);
  const commits = useMemo(() => filterCommits(windowedActivities, route.repo, route.branch, route.source), [windowedActivities, route.repo, route.branch, route.source]);
  const commitRepos = useMemo(() => commitRepoOptions(windowCommits), [windowCommits]);
  const commitBranches = useMemo(() => commitBranchOptions(repoCommits), [repoCommits]);
  // Board-wide commit total from the full-history aggregate (4.0.0 windows
  // env.activities to ~30 days; counting commits there under-reports).
  const totalCommits = useMemo(() => boardCommitTotal(env ?? activeEnv), [env, activeEnv]);

  const filteredEdges = useMemo(() => {
    if (!visibleEnv) return [];
    return resolveEdges(visibleEnv, itemsById).filter((re) => edgeMatches(re, itemFilters));
  }, [visibleEnv, itemsById, itemFilters]);

  const filteredEdgeDTOs = useMemo(() => filteredEdges.map((re) => re.edge), [filteredEdges]);

  // Graph FOCUS edges: like filteredEdges (visibility + facets), but always from
  // the FULL contract payload. With a custom range active, the content pipeline
  // runs off the range-projected contract whose edges are windowed server-side
  // ("edges touch the primary item window") — fine for the overview, but a focus
  // view exists to show ONE item's complete neighbourhood, so it must not lose
  // relations to the range projection. Same reference as filteredEdges when no
  // range payload is active (no duplicated work).
  const graphFocusEdges = useMemo(() => {
    if (!needsRangeEnv || !env) return filteredEdges;
    const fullVisible = applyVisibility(env, hidden, hiddenSources);
    return resolveEdges(fullVisible, indexItems(fullVisible)).filter((re) => edgeMatches(re, itemFilters));
  }, [needsRangeEnv, env, hidden, hiddenSources, itemFilters, filteredEdges]);
  const canUseContractAggregates =
    hidden.size === 0 &&
    hiddenSources.size === 0 &&
    filters.search.trim() === "" &&
    itemFacetState.sources.size === 0 &&
    itemFacetState.states.size === 0 &&
    itemFacetState.kinds.size === 0 &&
    itemFacetState.reviews.size === 0 &&
    itemFacetState.repos.size === 0;
  const compatibleAggregates = canUseContractAggregates && !customRange ? (env?.aggregates ?? []) : [];

  // Status is intrinsic — derived over ALL visible items/edges, then filtered
  // items are placed into columns (so a closed item's Trailing status is correct
  // even when its related open item is removed by a transient facet filter).
  const statuses = useMemo(
    () => (visibleEnv ? deriveStatuses(primaryItems, visibleEnv.edges) : new Map()),
    [visibleEnv, primaryItems],
  );

  // Per-item relation summary (distinct related items + per-type breakdown),
  // over the FULL visible edge set — NOT the time-windowed / facet-filtered graph
  // — so the card's count matches what graph focus would show. Map membership
  // doubles as the old linkedIds set: the card's "focus in graph" link shows ONLY
  // for entries here, since an item with no relationships has no node to focus.
  const boardRelationCounts = useMemo(() => relationCounts(visibleEnv?.edges ?? []), [visibleEnv]);

  // Toggle one shared item-facet value (board / graph / repo-analytics) in the
  // URL — the single source of truth, so the chips, the filtered views, reload,
  // and a shared link never disagree. Preserves the graph focus and the time
  // range of the current page.
  function setItemFacet(dim: ItemFacetDim, value: string) {
    if (typeof window === "undefined") return;
    const current = parseHashRoute(readHash());
    const nextFacets = toggleItemFacet(itemFacets(current), dim, value);
    const next = buildHashRoute({
      page,
      focus: page === "graph" ? current.focus : null,
      ...itemFacetFields(nextFacets),
      q: filters.search,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  // Drop every search / facet / SCM filter for the current page in one step,
  // keeping the page, the graph focus, and the active time range. Wired into the
  // empty-state "Clear filters" escape hatch (the route is the single source of
  // truth, so the chips and views follow).
  function clearFilters() {
    if (typeof window === "undefined") return;
    const current = parseHashRoute(readHash());
    const next = buildHashRoute({
      page,
      focus: page === "graph" ? current.focus : null,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  // The board-empty CTA: jump straight to the Sources editor (where a user adds a
  // source + token), not the default Display tab. `tab=sources` is a no-op when
  // the config capability is unavailable, so a read-only deploy still lands on
  // Settings cleanly.
  function openSettings() {
    if (typeof window === "undefined") return;
    const next = buildHashRoute({ page: "settings", tab: "sources" });
    if (readHash() !== next) window.location.hash = next;
  }

  // Toggle one Activity facet value in the URL. Reads the live hash, flips the
  // value via nav.ts, and re-encodes — keeping the route the single source of
  // truth, so the chip state, the feed, and a shared link can never disagree.
  // The shared item-facet lens (isource/istate/ikind) rides along untouched.
  function setActivityFacet(dim: ActivityFacetDim, value: string) {
    if (typeof window === "undefined") return;
    const current = parseHashRoute(readHash());
    const nextFacets = toggleActivityFacet(activityFacets(current), dim, value);
    const next = buildHashRoute({
      page: "activity",
      // Keep the mobile Activity sub-view (Feed / Overview) the user is editing;
      // dropping `tab` here would snap a narrow-screen Overview back to the Feed.
      tab: current.tab,
      ...activityFacetFields(nextFacets),
      isource: current.isource,
      istate: current.istate,
      ikind: current.ikind,
      ireview: current.ireview,
      irepo: current.irepo,
      unresolved: current.unresolved,
      q: filters.search,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  // Flip the Activity "unresolved only" toggle (?unresolved=1). Preserves every
  // other Activity facet and the shared item lens, mirroring setActivityFacet.
  function setUnresolvedReviews() {
    if (typeof window === "undefined") return;
    const current = parseHashRoute(readHash());
    const next = buildHashRoute({
      page: "activity",
      tab: current.tab,
      ...activityFacetFields(activityFacets(current)),
      isource: current.isource,
      istate: current.istate,
      ikind: current.ikind,
      ireview: current.ireview,
      irepo: current.irepo,
      unresolved: current.unresolved === "1" ? null : "1",
      q: filters.search,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  function toggleRepo(key: string) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setReposVisible(keys: string[], visible: boolean) {
    setHidden((h) => {
      const next = new Set(h);
      for (const k of keys) {
        if (visible) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  // Source-level visibility is its own layer — toggling it never touches the
  // per-repo `hidden` set, so a source's repos keep their remembered choices.
  function toggleSource(source_id: string) {
    setHiddenSources((h) => {
      const next = new Set(h);
      if (next.has(source_id)) next.delete(source_id);
      else next.add(source_id);
      return next;
    });
  }

  // Collapse / expand one board column by its column kind (a status key, or
  // `lane-<key>` for a Spotlight lane). The click is routed by emptiness so the
  // two regimes stay disjoint (see model.columnCollapsed): toggling an EMPTY
  // column flips its transient peek; toggling a NON-EMPTY column flips its
  // persisted manual collapse.
  function toggleColumnCollapse(kind: string, isEmpty: boolean) {
    const setter = isEmpty ? setPeekedColumns : setCollapsedColumns;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function setColorOverride(key: string, color: string) {
    setColorOverrides((m) => new Map(m).set(key, color));
  }
  function clearColorOverride(key: string) {
    setColorOverrides((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  function loadFile(file: File) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    file
      .text()
      .then((t) => {
        const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const loaded = parseContractWithMetadata(t, file.name, Math.max(0, Math.round(finishedAt - startedAt)));
        setEnv(loaded.env);
        setContractMeta(loaded.meta);
        setRangeEnv(null);
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message));
  }

  // Tab links go through nav.tabHref, the one place that decides what carries
  // across a tab hop: search, time range, AND the shared item-facet lens travel;
  // page-local drill-down state (Activity facets, graph focus, commit repo/branch)
  // does not.
  function routeHref(nextPage: Page): string {
    return tabHref(nextPage, {
      q: filters.search,
      range: { from: explicitRange?.from, to: explicitRange?.to, preset: explicitRange ? route.preset : null },
      item: itemFacetFields(itemFacetState),
    });
  }

  function setRouteSearch(q: string) {
    setFilters((f) => ({ ...f, search: q }));
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page,
      // Keep the current page's sub-view (Activity Feed/Overview, Graph List/Graph)
      // so changing the search box does not reset it on a narrow screen.
      tab: route.tab,
      focus: page === "graph" ? route.focus : null,
      source: page === "activity" || page === "commits" ? route.source : null,
      repo: page === "activity" || page === "commits" ? route.repo : null,
      branch: page === "commits" ? route.branch : null,
      kind: page === "activity" ? route.kind : null,
      action: page === "activity" ? route.action : null,
      isource: route.isource,
      istate: route.istate,
      ikind: route.ikind,
      ireview: route.ireview,
      irepo: route.irepo,
      unresolved: route.unresolved,
      q,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  // The Graph page's focus is URL-backed BOTH ways: deep-links seed "?focus="
  // and every in-graph focus change (side-list click, canvas node click,
  // "← all items") writes it back here — so a focused view is shareable and the
  // browser back button steps through focus history. Only called while the
  // Graph page is mounted, hence the hard-coded page.
  function setRouteFocus(focus: string | null) {
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page: "graph",
      focus,
      isource: route.isource,
      istate: route.istate,
      ikind: route.ikind,
      ireview: route.ireview,
      irepo: route.irepo,
      unresolved: route.unresolved,
      q: filters.search,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  // The Commits page's SCM filters are URL-backed (like search/focus) so they
  // are shareable and survive reload. Clearing a value drops that query param.
  function setRouteRepo(repo: { source_id: string; project_path: string } | null) {
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page: "commits",
      source: repo?.source_id ?? null,
      repo: repo?.project_path ?? null,
      branch: route.branch,
      isource: route.isource,
      istate: route.istate,
      ikind: route.ikind,
      ireview: route.ireview,
      irepo: route.irepo,
      unresolved: route.unresolved,
      q: filters.search,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  function setRouteBranch(branch: string | null) {
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page: "commits",
      source: route.source,
      repo: route.repo,
      branch,
      isource: route.isource,
      istate: route.istate,
      ikind: route.ikind,
      ireview: route.ireview,
      irepo: route.irepo,
      unresolved: route.unresolved,
      q: filters.search,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  function setRouteRange(range: TimeRange, presetId: TimeRangePresetId | null = null) {
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page,
      // Preserve the current page's sub-view (Activity Feed/Overview, Graph
      // List/Graph) across a date-range change on a narrow screen.
      tab: route.tab,
      focus: page === "graph" ? route.focus : null,
      source: page === "activity" || page === "commits" ? route.source : null,
      repo: page === "activity" || page === "commits" ? route.repo : null,
      branch: page === "commits" ? route.branch : null,
      kind: page === "activity" ? route.kind : null,
      action: page === "activity" ? route.action : null,
      isource: route.isource,
      istate: route.istate,
      ikind: route.ikind,
      ireview: route.ireview,
      irepo: route.irepo,
      unresolved: route.unresolved,
      q: filters.search,
      from: range.from,
      to: range.to,
      preset: presetId,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  // The hidden Diagnostics page renders BEFORE the contract-loading gates on
  // purpose: it must stay reachable when the contract fails to load — that is
  // exactly when it is needed. It does its own data fetching (useDebug.ts).
  if (route.page === "debug") {
    return (
      <div className="app app-wide">
        <DebugPage serverBaseUrl={serverBaseUrl} env={env} contractMeta={contractMeta} onRefreshData={reloadData} onClose={toggleDebug} />
      </div>
    );
  }

  // The shared top tab bar, built once and rendered both on the Live route
  // (below, before the contract gates) and in the main shell return — so Live
  // switches like any other tab instead of being a separate full-screen view.
  // Live leads (the realtime headline) and appears only where the receiver
  // answers (liveAvailable). routeHref carries search/range/lens across the hop.
  const pageTabs = (
    <nav className="page-tabs">
      {liveAvailable ? (
        <a className={`tab tab-live${page === "live" ? " tab-on" : ""}`} href={routeHref("live")}>
          <span className="tab-live-dot" aria-hidden="true" />
          Live
        </a>
      ) : null}
      <a className={`tab${page === "activity" ? " tab-on" : ""}`} href={routeHref("activity")}>
        Activity
      </a>
      <a className={`tab${page === "commits" ? " tab-on" : ""}`} href={routeHref("commits")}>
        Commits
      </a>
      <a className={`tab${page === "board" ? " tab-on" : ""}`} href={routeHref("board")}>
        Board
      </a>
      <a className={`tab${page === "graph" ? " tab-on" : ""}`} href={routeHref("graph")}>
        Graph
      </a>
      <a className={`tab${page === "repo-analytics" ? " tab-on" : ""}`} href={routeHref("repo-analytics")}>
        Repo Analytics
      </a>
      <a className={`tab${page === "settings" ? " tab-on" : ""}`} href={routeHref("settings")}>
        Settings
      </a>
    </nav>
  );

  // The Live tab renders BEFORE the contract gates: it is contract-independent
  // (its own SSE/snapshot data path), so it must work even when the contract is
  // missing or failing to load. It keeps the shell header + tab bar so it reads
  // as a normal tab; the Header only shows once a contract is loaded.
  if (route.page === "live") {
    return (
      <div className="app app-wide">
        {env ? (
          <Header env={env} sync={sync} hiddenSources={hiddenSources} refreshing={refreshingData} onRefresh={refreshData} />
        ) : null}
        {pageTabs}
        <LivePage serverBaseUrl={serverBaseUrl} previewLines={livePreviewLines} />
      </div>
    );
  }

  if (loading) return <div className="state-msg">Loading contract…</div>;

  if (error && !env) {
    // First-run onboarding: the server is reachable and editable (the config
    // capability answered) but no contract exists yet — typically a fresh
    // standalone install. Guide the user through source -> token -> first
    // sync right here; the board loads as soon as the first emit lands.
    if (configState.available) {
      return (
        <div className="onboarding">
          <div className="onboarding-intro">
            <h2>Welcome to Symphony Board</h2>
            <p className="muted">
              No board data yet. Add a source and its repos below, paste the provider token, save, then run the first
              sync — the board appears as soon as the first contract is emitted.
            </p>
          </div>
          <SourcesEditor config={configState} sync={sync} />
          {sync.available ? <SyncControls sync={sync} /> : null}
        </div>
      );
    }
    return (
      <div className="state-msg error">
        <p>
          Could not load <code>{resolveEndpoint("./contract.json", serverBaseUrl)}</code>: {error}
        </p>
        <ServerConnectionForm serverBaseUrl={serverBaseUrl} onServerBaseUrl={applyServerBaseUrl} />
        <p className="muted">
          Emit one with <code>pnpm run emit --out packages/ui/public/contract.json</code>, or load a file:
        </p>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
          }}
        />
      </div>
    );
  }

  if (!env) return <div className="state-msg">Loading contract…</div>;
  if (!activeRange) return <div className="state-msg error">Could not derive a default range from the loaded contract.</div>;
  if (!visibleEnv) return null;
  const unsupported = majorOf(env.contract_version) !== SUPPORTED_MAJOR;
  const contentEnv = activeEnv;
  const rangeContentPending = needsRangeEnv && rangeLoading && !rangeEnv;
  const rangeContentError = needsRangeEnv && !!rangeError && !rangeEnv;

  // The whole board has no data at all (fresh install / not yet synced) — drives
  // the board-empty treatment instead of a misleading "nothing in this range".
  // 4.0.0 windows `activities` to ~30 days, so isBoardEmpty also consults the
  // full-history `activity_daily.total`: a dormant board can have an empty
  // windowed `activities` array yet real history (items long since aged out).
  const boardEmpty = isBoardEmpty(env);
  // Props shared by every page's empty state; the per-page noun + counts are
  // filled in at each render site below. `total` is the full-contract count
  // (board-wide) and `windowTotal` the in-range count, so emptyStateKind can
  // tell "this entity isn't on the board" from "not in this range". Visibility
  // hidden via Settings collapses windowTotal but not total; that rare
  // hide-everything case reads as range-empty, where the widen buttons are a
  // harmless no-help rather than wrong.
  const emptyStateShared = {
    boardEmpty,
    range: activeRange,
    dataExtent: staticRange,
    generatedAt: env.generated_at,
    timezone: tz,
    onRange: setRouteRange,
    onClearFilters: clearFilters,
    onOpenSettings: openSettings,
    sync,
  };

  return (
    <div className="app app-wide">
      <Header env={env} sync={sync} hiddenSources={hiddenSources} refreshing={refreshingData} onRefresh={refreshData} />
      {pageTabs}
      {unsupported && (
        <div className="banner warn">
          This UI targets contract major v{SUPPORTED_MAJOR}, but the loaded contract is {env.contract_version}. Some
          fields may not render correctly.
        </div>
      )}
      {/* The facet Controls drive the data views; page-local StatsBars live beside
          the Board/Graph windows they describe. Activity has no item/edge stats,
          Settings is a config surface, and Commits owns SCM-specific repo/branch
          filters (so it deliberately skips the shared facet Controls) — but
          every non-Settings page shares the date-range control. */}
      {page !== "settings" && (
        <div className="view-chrome" data-page={page}>
          {page !== "commits" && (
            <Controls
              search={filters.search}
              groups={controlGroups}
              mobilePanel={mobileControlPanel}
              onSearch={setRouteSearch}
              onToggle={(dim, value) => {
                if (dim === "unresolved") setUnresolvedReviews();
                else if (page === "activity") setActivityFacet(dim as ActivityFacetDim, value);
                else setItemFacet(dim as ItemFacetDim, value);
              }}
              onLoadFile={loadFile}
              onMobilePanel={setMobileControlPanel}
            />
          )}
          <TimeRangeControls
            range={activeRange}
            generatedAt={env.generated_at}
            timezone={tz}
            preferredPresetId={explicitRange ? route.preset : defaultRangePreset}
            loading={rangeLoading}
            error={rangeError}
            // A focused graph item shows its FULL neighbourhood (no time window),
            // so the range is visibly suspended there — selection kept, dimmed,
            // interaction off. Route-backed (?focus=), so reload/back agree.
            suspended={page === "graph" && route.focus != null}
            // On narrow/portrait, collapse the date controls behind a summary
            // disclosure on every page that shows them — the first screen should
            // be content (the feed, board, graph, …), not a tall stack of date
            // pickers. This block only renders for non-Settings pages, so the
            // range always collapses on a phone; desktop always shows it inline.
            collapsibleOnNarrow
            mobilePanel={mobileControlPanel}
            onRange={setRouteRange}
            onMobilePanel={setMobileControlPanel}
          />
        </div>
      )}
      {rangeContentPending ? (
        <div className="state-msg state-msg-inline">Loading range…</div>
      ) : rangeContentError ? (
        <div className="state-msg state-msg-inline error">
          <p>Could not load selected range: {rangeError}</p>
        </div>
      ) : !contentEnv ? (
        null
      ) : page === "settings" ? (
        <SettingsPage
          sources={env.sources}
          repos={allRepos}
          hidden={hidden}
          onToggle={toggleRepo}
          onSetVisible={setReposVisible}
          hiddenSources={hiddenSources}
          onToggleSource={toggleSource}
          colorOf={colorOf}
          colorOverrides={colorOverrides}
          onSetColor={setColorOverride}
          onClearColor={clearColorOverride}
          defaultRangePreset={defaultRangePreset}
          onDefaultRangePreset={setDefaultRangePreset}
          theme={theme}
          onTheme={setTheme}
          livePreviewLines={livePreviewLines}
          onLivePreviewLines={setLivePreviewLines}
          serverBaseUrl={serverBaseUrl}
          onServerBaseUrl={applyServerBaseUrl}
          sync={sync}
          config={configState}
          tab={settingsTab}
          onTab={setSettingsTab}
        />
      ) : page === "activity" ? (
        <ActivityPage
          activities={filteredActivities}
          allActivities={env.activities ?? activeEnv.activities ?? []}
          activityDaily={env.activity_daily ?? null}
          generatedAt={env.generated_at}
          windowTotal={windowedActivities.length}
          totalActivities={env.activity_daily?.total ?? env.activities?.length ?? activeEnv.activities?.length ?? 0}
          range={activeRange}
          timezone={tz}
          sourceKind={sourceKind}
          colorOf={colorOf}
          itemsById={activityItemsById}
          view={activityViewValue}
          onView={setActivityView}
          emptyState={
            <EmptyState noun="activity" total={env.activity_daily?.total ?? env.activities?.length ?? 0} windowTotal={windowedActivities.length} {...emptyStateShared} dataExtent={activityDataExtent} />
          }
        />
      ) : page === "commits" ? (
        <CommitsPage
          commits={commits}
          windowTotal={windowCommits.length}
          totalCommits={totalCommits}
          repoOptions={commitRepos}
          branchOptions={commitBranches}
          selectedSource={route.source}
          selectedRepo={route.repo}
          selectedBranch={route.branch}
          onRepo={setRouteRepo}
          onBranch={setRouteBranch}
          range={activeRange}
          timezone={tz}
          sourceKind={sourceKind}
          colorOf={colorOf}
          emptyState={
            <EmptyState noun="commits" total={totalCommits} windowTotal={windowCommits.length} {...emptyStateShared} dataExtent={commitDataExtent} />
          }
        />
      ) : page === "repo-analytics" ? (
        <RepoAnalyticsPage
          metrics={repoMetrics}
          windowTotal={visibleEnv.repo_metrics?.length ?? 0}
          range={activeRange}
          sourceKind={sourceKind}
          colorOf={colorOf}
          lens={itemFacetFields(itemFacetState)}
          emptyState={
            <EmptyState
              noun="repo metrics"
              total={env.repo_metrics?.length ?? 0}
              windowTotal={visibleEnv.repo_metrics?.length ?? 0}
              {...emptyStateShared}
            />
          }
        />
      ) : page === "graph" ? (
        <Suspense fallback={<div className="state-msg">Loading graph…</div>}>
          {/* Focus is CONTROLLED by the route: focusRef comes from "?focus="
              and every in-graph focus change goes back out through
              setRouteFocus, so no focus-keyed remount is needed (a stale seed
              cannot exist) and layout/mention toggles survive focus hops. */}
          <GraphPage
            edges={filteredEdges}
            focusEdges={graphFocusEdges}
            sourceKind={sourceKind}
            colorOf={colorOf}
            focusRef={route.focus}
            onFocusChange={setRouteFocus}
            aggregates={compatibleAggregates}
            itemWindow={contentEnv.item_window}
            range={activeRange}
            timezone={tz}
            emptyState={
              <EmptyState noun="relationships" total={env.edges.length} windowTotal={contentEnv.edges?.length ?? 0} {...emptyStateShared} />
            }
            onClearFilters={clearFilters}
            theme={theme}
            mobileView={graphViewValue}
            onMobileView={setGraphView}
          />
        </Suspense>
      ) : (
        <FullBoard
          items={filteredItems}
          edges={filteredEdgeDTOs}
          statuses={statuses}
          sourceKind={sourceKind}
          colorOf={colorOf}
          relationCounts={boardRelationCounts}
          collapsed={collapsedColumns}
          peeked={peekedColumns}
          onToggleCollapse={toggleColumnCollapse}
          aggregates={compatibleAggregates}
          itemWindow={contentEnv.item_window}
          range={activeRange}
          lens={itemFacetFields(itemFacetState)}
        />
      )}
    </div>
  );
}
