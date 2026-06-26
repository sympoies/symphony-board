import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContractEnvelope, ActivityDailyDTO } from "@symphony-board/contract";
import { fetchContractWithMetadata, fetchRangeContractWithMetadata, fetchActivityDaily, parseContractWithMetadata, majorOf, resolveEndpoint, endpointRequiresServerUrl, SUPPORTED_MAJOR, INIT_LOAD_PATIENT_ATTEMPTS, initLoadRetryDelayMs, contractLoadingViewVisible, type ContractLoadMetadata } from "./contract.ts";
import { dismissBootSplash, setBootSplashStatus, bootSplashReady, BOOT_SPLASH_MAX_MS } from "./boot-splash.ts";
import { applyWideViewport } from "./runtime.ts";
import { loadCachedContract, saveCachedContract, pickColdStartEnv } from "./contract-cache.ts";
import {
  emptyFilters,
  activityRouteMatches,
  activityMatches,
  filterCommits,
  commitRepoOptions,
  commitBranchOptions,
  preferredDefaultTimeRange,
  staticContractTimeRange,
  timeRangeForPreset,
  TIME_RANGE_PRESETS,
  timeRangeForDays,
  activityDailyExtent,
  activityOccurredExtent,
  boardCommitTotal,
  isBoardEmpty,
  isCommitActivity,
  filterActivitiesByRange,
  filterItemsByRange,
  indexItems,
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
  rangeQueryWindow,
  sourceDisplayName,
  reviewSortFromRoute,
  type TimeRangePresetId,
  type TimeRange,
  type Filters,
  type ReviewSort,
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
  clearFiltersHref,
  startupRouteHash,
  resolveDefaultTab,
  liveTabVisible,
  parseDebugTab,
  debugTabField,
  ITEM_REVIEW_VALUES,
  type ActivityFacetDim,
  type ActivityView,
  type GraphView,
  type ItemFacetDim,
  type Page,
  type DebugTab,
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
  loadColorMode,
  saveColorMode,
  resolveViewTheme,
  subscribeSystemColorScheme,
  systemPrefersDark,
  THEME_META_COLORS,
  loadLivePreviewLines,
  saveLivePreviewLines,
  loadLiveTabEnabled,
  saveLiveTabEnabled,
  loadBoardScope,
  saveBoardScope,
  deviceCeilingDays,
  clampRangeToCeiling,
  usesStaticContractFastPath,
  isStaticDeployment,
  liveControlsDisabled,
  effectiveLiveTabEnabled,
  loadLastContractTimezone,
  saveLastContractTimezone,
  loadWideLayout,
  saveWideLayout,
  currentClientKind,
  loadHiddenEventTypes,
  saveHiddenEventTypes,
  loadDefaultTab,
  saveDefaultTab,
  loadServerBaseUrl,
  saveServerBaseUrl,
  normalizeServerBaseUrl,
  type BoardScope,
  type ResolvedViewTheme,
  type ViewColorMode,
} from "./viewconfig.ts";
import { useSync } from "./useSync.ts";
import { useLive } from "./useLive.ts";
import { useConfig } from "./useConfig.ts";
import { SourcesEditor } from "./components/SourcesEditor.tsx";
import { SyncControls } from "./components/SyncControls.tsx";
import { isRefreshShortcut, isDebugShortcut } from "./shortcuts.ts";
import { setupAutoHideScrollbars } from "./autoHideScrollbars.ts";
import { BrandHeader, Header } from "./components/Header.tsx";
import { Controls, type ControlGroup } from "./components/Controls.tsx";
import { FullBoard } from "./components/FullBoard.tsx";
import { ItemsPage } from "./components/ItemsPage.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { ActivityPage } from "./components/ActivityPage.tsx";
import { CommitsPage } from "./components/CommitsPage.tsx";
import { ReviewsPage } from "./components/ReviewsPage.tsx";
import { RepoAnalyticsPage } from "./components/RepoAnalyticsPage.tsx";
import { DebugPage } from "./components/DebugPage.tsx";
import { LivePage } from "./components/LivePage.tsx";
import { TimeRangeControls } from "./components/TimeRangeControls.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { ServerConnectionForm } from "./components/ServerConnectionForm.tsx";
import { isValidTimezone } from "./tz.ts";

// The Graph page pulls in React Flow + layout libs — lazy-load it so the board
// page stays light; the chunk only loads when #/graph is opened.
const GraphPage = lazy(() => import("./components/GraphPage.tsx").then((m) => ({ default: m.GraphPage })));

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

// Stable singletons for the review-lens chip groups (avoid new Set() per render).
const EMPTY_SET: ReadonlySet<string> = new Set();
const UNRESOLVED_ON: ReadonlySet<string> = new Set(["unresolved"]);
// Chip labels for the review lens: "threads" -> "has threads", "unresolved" as-is.
const reviewFacetLabel = (v: string): string => (v === "threads" ? "has threads" : v);
const itemKindFacetLabel = (v: string): string => (v === "change_request" ? "PR/MR" : v);
type MobileControlPanel = "search" | "filters" | "range" | null;
type EnvAuthority = "server" | "file";

const normalizeContractTimezone = (value: unknown): string | null => (isValidTimezone(value) ? value : null);

function useSystemPrefersDark(enabled: boolean): boolean {
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeSystemColorScheme(setPrefersDark);
  }, [enabled]);

  return enabled ? systemPrefersDark() : prefersDark;
}

function applyDocumentTheme(theme: ResolvedViewTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "paper" ? "light" : "dark";
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", THEME_META_COLORS[theme]);
}

// Pages via a zero-dep hash route: "" (first open) defaults to Activity,
// "activity" (#/activity) is the event feed, "items" (#/items) the cross-repo
// work-item log, "commits" (#/commits) the cross-repo commit log, "reviews"
// (#/reviews) the current provider review-thread inbox, "board" (#/board) the
// full-width board, "graph" (#/graph) the relationship graph, "repo-analytics"
// (#/repo-analytics) the per-repo metrics view, and "settings" (#/settings) the
// persistent repo display filter. "debug" (#/debug) is the hidden Diagnostics
// page — not in the nav, toggled with Cmd+/ (Ctrl+/) or by typing the hash.
// The route may carry "?q=<search>" so the
// visible search box is URL-backed; graph routes may also carry "?focus=<ref>",
// written by a board-card deep-link AND by every in-graph focus change
// (setRouteFocus), and commits routes carry "?repo=<project_path>" and
// "?branch=<branch>" for the page-local SCM filters.
const readHash = (): string => (typeof location !== "undefined" ? location.hash : "");
const readStartupHash = (): string =>
  // A static, server-less deployment (the Pages demo) has no live receiver, so a
  // stored Live opt-in must NOT seed a Live landing here — the tab can never show
  // and the route would just bounce. Resolve the startup tab with Live forced off
  // there (matches App's liveTabEffectivelyEnabled); the stored preference is left
  // untouched and re-applies on a real, server-backed deployment.
  startupRouteHash(readHash(), resolveDefaultTab(loadDefaultTab(), effectiveLiveTabEnabled(loadLiveTabEnabled(), isStaticDeployment())));
const historyStateObject = (): Record<string, unknown> => {
  const state = window.history.state;
  return state && typeof state === "object" && !Array.isArray(state) ? { ...(state as Record<string, unknown>) } : {};
};

export function App() {
  // Compute the cold-start hash once and seed every startup consumer from it.
  // Otherwise the normalized page route and URL-backed search could disagree for
  // one render when startupRouteHash intentionally drops transient query params.
  const startupHashRef = useRef<string | null>(null);
  if (startupHashRef.current === null) startupHashRef.current = readStartupHash();
  const initialStartupHash = startupHashRef.current;
  const [env, setEnv] = useState<ContractEnvelope | null>(null);
  const [envAuthority, setEnvAuthority] = useState<EnvAuthority | null>(null);
  const [contractMeta, setContractMeta] = useState<ContractLoadMetadata | null>(null);
  const fileEnvAuthoritativeRef = useRef(false);
  // Full-history activity_daily for the Activity Overview, fetched independently of
  // the board window. Only populated when the primary env is itself windowed (a
  // bounded Board data scope loads a /api/range projection whose activity_daily
  // covers only the window); null otherwise, so the overview reads env.activity_daily
  // directly. See the fetch effect below and ./contract.ts fetchActivityDaily.
  const [fullActivityDaily, setFullActivityDaily] = useState<ActivityDailyDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingData, setRefreshingData] = useState(false);
  // Cold-start init retry: a contract that is briefly unreachable at launch must
  // self-heal into a working board WITHOUT an app restart. `reloadKey` bumps to
  // re-run the init fetch; `initAttemptRef` counts consecutive failures (drives
  // the patient-window splash vs. the actionable error UI); `retrying` flags that
  // a background retry is pending; `bootDismissed` tracks whether the cold-start
  // splash has been removed yet.
  const [reloadKey, setReloadKey] = useState(0);
  // Bumps after every in-place data reload (reloadData: manual refresh / post-sync /
  // daemon fresh-data). Unlike reloadKey it does NOT re-run the init fetch — it only
  // re-triggers the side aggregates a reload must refresh but that key off neither env
  // nor reloadKey, namely the full-history Activity overlay (#409). Kept separate so a
  // reload does not pay for a full cold-start init round.
  const [dataReloadEpoch, setDataReloadEpoch] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [bootDismissed, setBootDismissed] = useState(false);
  const initAttemptRef = useRef(0);
  const initRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Seed the search from the hash's "?q=" token if present; the URL is the source
  // of truth, so reloading/share links and Board ↔ Graph tab hops agree.
  const [filters, setFilters] = useState<Filters>(() => applyRouteSearch(emptyFilters(), parseHashRoute(initialStartupHash)));
  const [mobileControlPanel, setMobileControlPanel] = useState<MobileControlPanel>(null);
  const [hash, setHash] = useState<string>(initialStartupHash);
  // Persistent display preferences (the Settings page), loaded once from
  // localStorage and saved back on every change:
  //   • hidden        — HIDDEN repoKeys
  //   • hiddenSources — HIDDEN source_ids (an independent layer; see applyVisibility)
  //   • colorOverrides — repoKey -> hex, this viewer's per-repo highlight override
  //   • defaultRangePreset — which quick preset is used when the route has no from/to
  //   • colorMode — DEVICE-LOCAL display preference (per browser / Android WebView)
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(loadHiddenSources);
  const [colorOverrides, setColorOverrides] = useState<Map<string, string>>(loadColorOverrides);
  const [defaultRangePreset, setDefaultRangePreset] = useState<TimeRangePresetId>(loadDefaultRangePreset);
  const [colorMode, setColorMode] = useState<ViewColorMode>(loadColorMode);
  const systemDark = useSystemPrefersDark(colorMode === "system");
  const resolvedTheme = resolveViewTheme(colorMode, systemDark);
  const [livePreviewLines, setLivePreviewLines] = useState<number>(loadLivePreviewLines);
  // Live tab is opt-in (off by default): gates the tab, the SSE/poll stream, AND
  // the snapshot probe. `hiddenEventTypes` is the persistent per-category Live
  // filter (an independent layer, like hidden sources).
  const [liveTabEnabled, setLiveTabEnabled] = useState<boolean>(loadLiveTabEnabled);
  // Whether THIS device loads contract-backed board data at all. Date range owns
  // download size; this setting only gates "full/on" vs "off/Live-only".
  const [boardScope, setBoardScope] = useState<BoardScope>(loadBoardScope);
  // Force the wide (desktop) layout on this device (Android WebView only). Persisted
  // device-local; main.tsx applies it before mount, and the effect below re-applies
  // it when toggled at runtime so the layout flips without an app restart.
  const [wideLayout, setWideLayout] = useState<boolean>(loadWideLayout);
  const [hiddenEventTypes, setHiddenEventTypes] = useState<Set<string>>(loadHiddenEventTypes);
  const [defaultTab, setDefaultTab] = useState<Page>(loadDefaultTab);
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(loadServerBaseUrl);
  const [lastContractTimezone, setLastContractTimezone] = useState<string | null>(() => loadLastContractTimezone(loadServerBaseUrl()));
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
      : route.page === "items"
        ? "items"
      : route.page === "board"
        ? "board"
        : route.page === "graph"
          ? "graph"
          : route.page === "commits"
            ? "commits"
            : route.page === "reviews"
              ? "reviews"
              : route.page === "repo-analytics" || route.page === "repos"
                ? "repo-analytics"
                : route.page === "settings"
                  ? "settings"
                  : "activity";
  useEffect(() => {
    setMobileControlPanel(null);
  }, [page]);
  // The shared item-facet lens (source/state/kind) for items / board / graph /
  // repo-analytics, read STRICTLY from the URL route (isource/istate/ikind) — the
  // single source of truth shared by the content filters AND the chips. One set
  // is shared by these work-item pages and carried across tab hops (see nav.tabHref),
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
  const tz = normalizeContractTimezone(env?.timezone) ?? lastContractTimezone ?? "UTC";
  // board-scope derived flags. "off" loads no contract (Live-only); otherwise the
  // SELECTED range is the primary download (#488): the static ./contract.json
  // fast-path for the default 90-day window / static deploy, else a dynamic
  // /api/range projection.
  const contractDisabled = boardScope === "off";
  const contractEnabled = !contractDisabled;
  // #488: whether the LOADED env is a range projection — i.e. it carries
  // `range_query` (only buildRangeContract / the /api/range surface emits it).
  // Under range-as-download this is true for the common case (the primary env IS
  // the selected range) and false only for the static contract.json fast-path and
  // uploaded file envs, which keep their true item_window extent. The Activity
  // Overview keys off it to pull the full 12-month /api/activity-daily overlay,
  // since a range projection's own activity_daily covers only the window.
  const windowedEnv = !!env?.range_query;
  const shouldFetchFullActivityDaily = windowedEnv && envAuthority !== "file";
  // The instant calendar quick presets resolve against — the contract's generated-at
  // (stable per load), falling back to "now" only before the first contract arrives.
  const generatedNowMs = env ? (Number.isFinite(Date.parse(env.generated_at)) ? Date.parse(env.generated_at) : Date.now()) : Date.now();
  // #488: the loaded env's display window. For a range projection it is exactly
  // the fetched window (read back from range_query), so the landing range equals
  // staticRange and customRange stays false — no overlay, no refetch loop. For the
  // static contract.json fast-path / an uploaded file env (no range_query) it is
  // the true item_window extent.
  const staticRange = useMemo(
    () => (env ? (rangeQueryWindow(env) ?? staticContractTimeRange(env)) : null),
    [env],
  );
  // True data extents for the UNWINDOWED Activity / Commits feeds. staticRange is
  // a bounded window — the generated_at rolling window for a windowed scope, or the
  // item_window extent (≤ ~90 days) for full/off — so it would understate older
  // history and make "Show all" / the extent copy overpromise. Board / Graph / Repo
  // stay on staticRange since their data is window-bounded. Fall back to staticRange
  // when there are no activities to measure.
  // Measure the true activity span from activity_daily (full history) rather than
  // the raw activities[] feed, which 4.0.0 windows to 30 days — otherwise
  // "Show all" / the extent copy would understate older history. Fall back to the
  // raw feed for a pre-4.0.0 contract that carries no activity_daily.
  // Prefer the full-history overlay (when a windowed Board data scope made
  // env.activity_daily cover only the window) so the extent copy reaches the true
  // span, matching the Activity Overview.
  const activityDataExtent = useMemo(
    () => {
      const daily = fullActivityDaily ?? env?.activity_daily;
      return env
        ? (daily ? activityDailyExtent(daily) : activityOccurredExtent(env.activities ?? [], tz)) ?? staticRange
        : null;
    },
    [env, fullActivityDaily, tz, staticRange],
  );
  const commitDataExtent = useMemo(
    () => {
      const daily = fullActivityDaily ?? env?.activity_daily;
      return env
        ? (daily
            ? activityDailyExtent(daily, "commit")
            : activityOccurredExtent(env.activities ?? [], tz, isCommitActivity)) ?? staticRange
        : null;
    },
    [env, fullActivityDaily, tz, staticRange],
  );
  // Static/demo deployments have no /api/range server. They land on the bundled
  // contract extent and suspend the range controls so narrowing is visibly
  // unavailable instead of silently failing.
  // A static, server-less deployment (the Pages demo, VITE_SYMPHONY_BOARD_STATIC)
  // can fetch ./contract.json but 404s ./api/range. Treat it like a file env
  // (#424): never project a sub-range over the network, and land on the full
  // loaded extent so a fresh visitor sees the whole contract, not an out-of-window
  // empty range. A build-time constant; unset everywhere else, so false.
  const staticDeployment = isStaticDeployment();
  const defaultRange = useMemo(() => {
    if (!env) return null;
    // Static demo: land on the full loaded extent (staticRange) so all data shows
    // and customRange stays false — there is no server to project a sub-range (#432).
    if (staticDeployment && staticRange) return staticRange;
    // #488: the landing range is the viewer's preset resolved against the contract's
    // generated_at — env-value-stable per local day, so the load effect (keyed on the
    // range's day STRINGS) does not re-fire when setEnv merely recomputes the same day.
    // The selected/displayed range is clamped below; the picker disables
    // beyond-ceiling presets, so the stored preset is normally already within it.
    return preferredDefaultTimeRange(env, defaultRangePreset);
  }, [env, staticDeployment, staticRange, defaultRangePreset]);
  // Default range options the Settings control disables.
  // #488: the picker is capped by the device CEILING (1y desktop / 30d Android),
  // not a board-data window. `ceilingFrom` is the earliest day the device may
  // request; presets reaching before it are disabled / hidden.
  const deviceCeiling = deviceCeilingDays();
  const ceilingFrom = useMemo(() => timeRangeForDays(deviceCeiling, generatedNowMs, tz).from, [deviceCeiling, generatedNowMs, tz]);
  const disabledRangePresets = useMemo(
    () => new Set(TIME_RANGE_PRESETS.filter((p) => timeRangeForPreset(p.id, generatedNowMs, tz).from < ceilingFrom).map((p) => p.id)),
    [ceilingFrom, generatedNowMs, tz],
  );
  // #432: a static deployment cannot project a sub-range (./api/range 404s) and
  // its pre-aggregated repo_metrics cannot be re-windowed client-side, so a picked
  // sub-range would silently leave the views on the full bundled contract. Ignore
  // any route range there and pin the active range to the full loaded extent; the
  // range control is suspended (below) so the lock is visible, not silent.
  const explicitRange = useMemo(() => (staticDeployment ? null : routeTimeRange(route)), [route, staticDeployment]);
  const selectedRange = explicitRange ?? defaultRange;
  // #488: the selected range IS the primary download. `primaryRange` is the range
  // the client actually fetches: the active range clamped to the device ceiling
  // (the Android weak-hardware guard — 30d there, 1y elsewhere). On cold start
  // (no env yet) it seeds from the stored landing preset against the live clock so
  // the first fetch has a range before any contract exists. It resolves to
  // calendar-day strings, so the load effects below key on `primaryRange.from` /
  // `.to` (NOT the object): a later setEnv that recomputes the SAME day strings
  // leaves those deps unchanged and does not re-fire the fetch — convergence by
  // construction, no refetch loop.
  const primaryRange = useMemo(() => {
    if (contractDisabled) return null;
    const clock = env ? generatedNowMs : Date.now();
    const base = selectedRange ?? timeRangeForPreset(defaultRangePreset, clock, tz);
    return clampRangeToCeiling(base, deviceCeiling, clock, tz);
  }, [contractDisabled, selectedRange, defaultRangePreset, env, generatedNowMs, tz, deviceCeiling]);
  const activeRange = useMemo(() => {
    if (!selectedRange) return null;
    const clock = env ? generatedNowMs : Date.now();
    return clampRangeToCeiling(selectedRange, deviceCeiling, clock, tz);
  }, [selectedRange, env, generatedNowMs, tz, deviceCeiling]);
  const customRange = !!activeRange && !!staticRange && !sameTimeRange(activeRange, staticRange);
  // #488: the primary env follows the selected range directly. File /
  // static-deploy envs keep their loaded payload and the views filter them to
  // activeRange client-side.

  const rememberContractTimezone = useCallback((loadedEnv: ContractEnvelope) => {
    const nextTimezone = normalizeContractTimezone(loadedEnv.timezone) ?? "UTC";
    saveLastContractTimezone(serverBaseUrl, nextTimezone);
    setLastContractTimezone(nextTimezone);
  }, [serverBaseUrl]);

  useEffect(() => {
    setLastContractTimezone(loadLastContractTimezone(serverBaseUrl));
  }, [serverBaseUrl]);

  // Reload the active data in place after a successful manual sync. It only
  // re-fetches the primary contract payload (static or selected-range); the
  // route, search, filters, time range, and display preferences are URL/state
  // backed and untouched, so they survive the reload.
  const reloadData = useCallback(async (): Promise<boolean> => {
    // Manual refresh / post-sync reload is the explicit escape hatch that lets a
    // network load replace an uploaded file contract.
    fileEnvAuthoritativeRef.current = false;
    // board-scope OFF: no contract to reload (Live-only) — a manual refresh /
    // post-sync reload is a no-op for the (absent) board, never an error.
    if (contractDisabled) {
      setEnv(null);
      setEnvAuthority(null);
      setContractMeta(null);
      setFullActivityDaily(null);
      setError(null);
      return false;
    }
    const pending: Promise<void>[] = [];
    let loadedContract = false;
    // #488: reload the SELECTED range as the primary env — the static contract.json
    // fast-path for the default 90-day window (and the static/demo deploy), else a
    // dynamic /api/range projection. No separate overlay: the primary IS the range.
    const range = primaryRange!;
    const primaryLoad = usesStaticContractFastPath(range, staticDeployment, env ? generatedNowMs : Date.now(), tz)
      ? fetchContractWithMetadata(undefined, serverBaseUrl)
      : fetchRangeContractWithMetadata(range, serverBaseUrl);
    pending.push(primaryLoad
      .then((loaded) => {
        if (fileEnvAuthoritativeRef.current) return;
        setEnv(loaded.env);
        setEnvAuthority("server");
        setContractMeta(loaded.meta);
        rememberContractTimezone(loaded.env);
        // Refresh the cold-start cache keyed by the loaded range (#488).
        void saveCachedContract(serverBaseUrl, loaded.env, { range });
        setError(null);
        loadedContract = true;
      })
      .catch((err: unknown) => setError((err as Error).message)));
    await Promise.all(pending);
    // The primary env is refreshed above, but the
    // full-history Activity overlay (fullActivityDaily) is fetched by a separate effect
    // that keys off windowedEnv — which is unchanged across a reload (same scope, the
    // new /api/range env still carries range_query). Bump the reload epoch so that
    // effect re-runs and the Activity Overview reflects the freshly emitted contract
    // instead of staying pinned to the pre-reload aggregate (#409).
    //
    // Gate the bump on a successful primary load: on failure the catch only sets
    // `error` and leaves env on the PRE-reload contract, so refetching the overlay
    // would paint a fresher /api/activity-daily aggregate against the unchanged env.
    // The overlay is derived only from env, so the primary load is the complete
    // coverage check. Skip the bump on failure so the overlay stays consistent
    // with the unchanged env.
    if (loadedContract) {
      setDataReloadEpoch((e) => e + 1);
    }
    return loadedContract;
  }, [contractDisabled, staticDeployment, tz, primaryRange, serverBaseUrl, env, generatedNowMs, rememberContractTimezone]);
  const reloadDataAfterSync = useCallback(async () => {
    await reloadData();
  }, [reloadData]);
  const refreshData = useCallback(() => {
    setRefreshingData(true);
    void reloadData().finally(() => setRefreshingData(false));
  }, [reloadData]);
  // Manual "Retry now" from the load-error screen: cancel any pending backoff and
  // fire an immediate init round (the init effect re-runs on the reloadKey bump).
  const retryContractLoad = useCallback(() => {
    if (initRetryTimerRef.current) {
      clearTimeout(initRetryTimerRef.current);
      initRetryTimerRef.current = null;
    }
    setRetrying(true);
    setReloadKey((k) => k + 1);
  }, []);
  const sync = useSync(reloadDataAfterSync, serverBaseUrl);
  // Live can't run on a static, server-less deployment (the Pages demo): it has no
  // SSE/snapshot receiver, so the Settings Live controls render disabled there
  // (liveControlsDisabled). A stale `live-tab-enabled=true` in localStorage must
  // not leak past that disabled UI — otherwise the static build would still probe
  // ./api/live-snapshot (404), show the Live tab, and bounce off a dead #/live. So
  // derive an EFFECTIVE opt-in that is forced off on a static deployment and feed
  // it to the hook + tab visibility below. The raw `liveTabEnabled` stays the
  // persisted preference (Settings shows it, unchanged), so it re-applies on a
  // real server-backed deployment.
  const livePreferencesDisabled = liveControlsDisabled(staticDeployment);
  const liveTabEffectivelyEnabled = effectiveLiveTabEnabled(liveTabEnabled, staticDeployment);
  // The live stream lives HERE, at the always-mounted shell — not inside LivePage
  // — so the event buffer survives tab switches: switching to Live is instant and
  // current instead of re-seeding from /api/live-snapshot (a >1s empty flash) on
  // every visit. The hook owns the WHOLE Live lifecycle off two gates: the Settings
  // opt-in (`liveTabEffectivelyEnabled` — off costs zero requests and never
  // connects) and whether the Live tab is currently shown (the third arg opens the
  // SSE/poll stream only while active; enabled-but-inactive does one cold-start prewarm).
  const live = useLive(serverBaseUrl, liveTabEffectivelyEnabled, route.page === "live");
  // Receiver availability is the SAME signal as the stream's connect tri-state:
  // the single snapshot the hook probes doubles as the reachability check, so
  // there is no separate probe. null = still probing, false = unavailable
  // (disabled / no receiver / server-less), true = reachable. It gates the Live
  // tab (pageTabs) and the stale-#/live redirect below — so `useLive`'s `connected`
  // semantics carry navigation blast radius: a cold-start TRANSIENT probe failure
  // is deliberately kept at null (not false) so it never hides the tab or bounces
  // a Live deploy (see resolveProbeFailure); only a definitive failure resolves
  // false. Weigh that when changing how the hook resolves `connected`.
  const liveAvailable = live.connected;
  // Whether the Live tab is shown. Visible while connecting too (see liveTabVisible)
  // so a slow seed never hides the tab and strands the user with no way into Live;
  // only a definitive "unavailable" (connected === false) hides it. The bounce below
  // still keys off liveAvailable === false (definitive), so connecting never bounces.
  const liveTabShown = liveTabVisible(liveTabEffectivelyEnabled, liveAvailable);
  // A host WITHOUT the live receiver (the standalone app, or any deploy missing
  // it) must never strand the user on a dead Live page — which can happen now
  // that the default tab can be Live and the cold-start redirect honors it. When
  // availability resolves false while we're on Live, fall back to Activity (the
  // old desktop default). Only fires on a confirmed-false probe, so a host that
  // DOES have Live (liveAvailable null -> true) is never bounced.
  useEffect(() => {
    if (liveAvailable === false && route.page === "live") window.location.hash = "#/activity";
  }, [liveAvailable, route.page]);
  const configState = useConfig(serverBaseUrl);
  // Settings sub-tab, URL-backed so refresh and deep links keep it. Only the
  // "sources" value is meaningful; anything else renders the Display tab.
  const settingsTab = route.tab === "sources" ? ("sources" as const) : ("display" as const);
  const setSettingsTab = useCallback((tab: "display" | "sources") => {
    const current = parseHashRoute(readHash());
    const next = buildHashRoute({ ...current, page: "settings", tab: tab === "sources" ? "sources" : null });
    if (readHash() !== next) window.location.hash = next;
  }, []);
  // Diagnostics sub-tab, URL-backed through the same `tab` field so a refresh —
  // common on an operator console — keeps you on the surface you were reading.
  // The default tab maps to no `tab` param so #/debug stays clean.
  const debugTab = parseDebugTab(route.tab);
  const setDebugTab = useCallback((tab: DebugTab) => {
    const current = parseHashRoute(readHash());
    const next = buildHashRoute({ ...current, page: "debug", tab: debugTabField(tab) });
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
    saveColorMode(colorMode);
  }, [colorMode]);
  useEffect(() => {
    saveLivePreviewLines(livePreviewLines);
  }, [livePreviewLines]);
  useEffect(() => {
    saveLiveTabEnabled(liveTabEnabled);
  }, [liveTabEnabled]);
  useEffect(() => {
    saveBoardScope(boardScope);
  }, [boardScope]);
  // Persist + re-apply the wide-layout preference. useLayoutEffect so the viewport
  // change lands before the browser paints the toggled layout. A no-op off Android.
  useLayoutEffect(() => {
    saveWideLayout(wideLayout);
    applyWideViewport(wideLayout, currentClientKind());
  }, [wideLayout]);
  useEffect(() => {
    saveHiddenEventTypes(hiddenEventTypes);
  }, [hiddenEventTypes]);
  // A "live" default with the Live tab off is resolved AT READ TIME — the landing
  // hash (here + main.tsx) and the Settings picker's value all run through
  // resolveDefaultTab — so the stored preference is left untouched and re-applies
  // the moment Live is turned back on (the opt-out is reversible, not destructive).
  useEffect(() => {
    saveDefaultTab(defaultTab);
  }, [defaultTab]);
  // Cold start: reflect the resolved landing route into the URL so it matches the
  // rendered page (the hash state already seeded it above). startupRouteHash
  // honors the configured default tab over a restored hash — the web counterpart
  // of the desktop launcher in main.tsx — while preserving debug / graph focus.
  useEffect(() => {
    const target = startupHashRef.current ?? readStartupHash();
    if (readHash() !== target) window.location.hash = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    saveCollapsedColumns(collapsedColumns);
  }, [collapsedColumns]);
  useLayoutEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  const applyServerBaseUrl = useCallback((nextRaw: string | null) => {
    const next = normalizeServerBaseUrl(nextRaw);
    saveServerBaseUrl(next);
    fileEnvAuthoritativeRef.current = false;
    setServerBaseUrl(next);
    setLastContractTimezone(loadLastContractTimezone(next));
    setEnv(null);
    setEnvAuthority(null);
    setContractMeta(null);
    setFullActivityDaily(null);
    setError(null);
    // Reset the init-retry loop so the new server gets a fresh patient window.
    if (initRetryTimerRef.current) {
      clearTimeout(initRetryTimerRef.current);
      initRetryTimerRef.current = null;
    }
    initAttemptRef.current = 0;
    setRetrying(false);
    setLoading(true);
  }, []);

  // Cold-start accelerator: paint the last (stale) contract for this server from
  // the IndexedDB cache the instant we mount, so the board shows immediately
  // while the init fetch below revalidates and REPLACES it (the dominant launch
  // cost is the ~1.5MB download, not parsing). Only fills a STILL-EMPTY env — a
  // fetch that already won is authoritative and must not be clobbered — and is
  // per-server, so switching servers never paints another server's board.
  useEffect(() => {
    // #488: paint the cached env for the range we are ABOUT to load (keyed by
    // range so a different landing window never flashes first), unless the board
    // is off (no contract) or no range exists yet. The fetch below revalidates
    // and replaces it.
    if (contractDisabled || !primaryRange) return;
    let cancelled = false;
    void loadCachedContract(serverBaseUrl, { range: primaryRange }).then((cached) => {
      if (cancelled || !cached) return;
      if (fileEnvAuthoritativeRef.current) return;
      setEnv((cur) => pickColdStartEnv(cur, cached));
      setEnvAuthority("server");
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl, contractDisabled, primaryRange?.from, primaryRange?.to]);

  useEffect(() => {
    let cancelled = false;
    // board-scope OFF: load no contract (Live-only). Clear loading so the app
    // renders Live / Settings / the "board data off" panel instead of hanging on
    // the "Loading contract…" gate (which never resolves with no fetch in flight).
    if (contractDisabled) {
      fileEnvAuthoritativeRef.current = false;
      initAttemptRef.current = 0;
      setEnv(null);
      setEnvAuthority(null);
      setContractMeta(null);
      setFullActivityDaily(null);
      setError(null);
      setRetrying(false);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (fileEnvAuthoritativeRef.current) {
      initAttemptRef.current = 0;
      setError(null);
      setRetrying(false);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    // A missing server URL on an Android client is a configuration error, not a
    // transient one — surface it so the user sets a server, and do NOT loop on it.
    const definitiveConfigError = endpointRequiresServerUrl("./contract.json", serverBaseUrl);
    // Keep the blocking loading view (covered by the cold-start splash) up only
    // while still within the patient window with no data yet; past that the
    // actionable error UI takes over while we keep retrying in the background.
    if (!env && !definitiveConfigError && initAttemptRef.current < INIT_LOAD_PATIENT_ATTEMPTS) {
      setLoading(true);
    }
    // Single fetch per outer round (retries: 0) so the visible status reflects each
    // try; this effect owns the spacing + retry between rounds. A windowed scope
    // loads a small /api/range AS the primary env (avoids the full-contract OOM on
    // weak hardware); "full" loads ./contract.json. tz is unknown before the first
    // env, so the window is computed in UTC — the server re-zones it to its own
    // timezone, and the loaded env then drives the displayed range.
    // #432: static deployment loads the full ./contract.json even under a windowed
    // scope (./api/range 404s on the Pages demo), so a fresh visitor lands on data
    // instead of a contract-load error.
    // #488: fetch the SELECTED range as the primary env — the static contract.json
    // fast-path for the default 90-day window (and the static/demo deploy), else a
    // dynamic /api/range projection. tz is unknown before the first env, so
    // primaryRange seeds in UTC; the loaded env then drives the displayed range.
    const range = primaryRange!;
    const primaryLoad = usesStaticContractFastPath(range, staticDeployment, env ? generatedNowMs : Date.now(), tz)
      ? fetchContractWithMetadata(undefined, serverBaseUrl, undefined, { retries: 0 })
      : fetchRangeContractWithMetadata(range, serverBaseUrl, { retries: 0 });
    primaryLoad
      .then((loaded) => {
        if (cancelled) return;
        if (fileEnvAuthoritativeRef.current) return;
        initAttemptRef.current = 0;
        fileEnvAuthoritativeRef.current = false;
        setEnv(loaded.env);
        setEnvAuthority("server");
        setContractMeta(loaded.meta);
        rememberContractTimezone(loaded.env);
        // Refresh the cold-start cache so the NEXT launch paints this board before
        // its download resolves (full scope only — see the cache effect above).
        void saveCachedContract(serverBaseUrl, loaded.env, { range });
        setError(null);
        setRetrying(false);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError((err as Error).message);
        if (definitiveConfigError) {
          setRetrying(false);
          setLoading(false);
          return;
        }
        initAttemptRef.current += 1;
        // Past the patient window, reveal the actionable error UI but keep
        // retrying — a late-arriving server then restores the board on its own.
        if (initAttemptRef.current >= INIT_LOAD_PATIENT_ATTEMPTS) setLoading(false);
        setRetrying(true);
        const delay = initLoadRetryDelayMs(initAttemptRef.current);
        if (initRetryTimerRef.current) clearTimeout(initRetryTimerRef.current);
        initRetryTimerRef.current = setTimeout(() => {
          initRetryTimerRef.current = null;
          if (!cancelled) setReloadKey((k) => k + 1);
        }, delay);
      });
    return () => {
      cancelled = true;
      if (initRetryTimerRef.current) {
        clearTimeout(initRetryTimerRef.current);
        initRetryTimerRef.current = null;
      }
    };
  }, [serverBaseUrl, reloadKey, contractDisabled, staticDeployment, primaryRange?.from, primaryRange?.to, rememberContractTimezone]);

  // Remove the cold-start boot splash (index.html) once the first view has actual
  // CONTENT — never the blank/"Connecting…" gap. On the Live route that means the
  // feed has events: the per-server cache paints them instantly on a warm launch,
  // otherwise the splash holds until the (now small + bounded) snapshot probe
  // resolves the connection, so a cold start dismisses INTO a ready feed rather
  // than a bare "Connecting…". A hard timeout guarantees the splash can never
  // strand if a signal never lands.
  const [bootTimedOut, setBootTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setBootTimedOut(true), BOOT_SPLASH_MAX_MS);
    return () => clearTimeout(timer);
  }, []);
  const bootSplashDone = bootSplashReady({
    routePage: route.page,
    loading,
    // With board-scope OFF there is no contract to wait for — Live and Settings
    // render immediately — so treat "content" as satisfied to dismiss the splash
    // instead of holding it until the hard timeout.
    hasContent: env !== null || contractDisabled,
    liveConnected: live.connected,
    liveHasContent: live.events.length > 0,
    timedOut: bootTimedOut,
  });
  useEffect(() => {
    if (!bootSplashDone || bootDismissed) return;
    dismissBootSplash();
    setBootDismissed(true);
  }, [bootSplashDone, bootDismissed]);

  // Reflect the init / retry state in the splash's status line while it is up.
  useEffect(() => {
    if (bootDismissed) return;
    setBootSplashStatus(retrying ? "Reconnecting…" : "Loading…");
  }, [bootDismissed, retrying]);

  // Keep the Activity Overview a true trailing 12 months even when a bounded Board
  // data scope makes the primary env a windowed /api/range projection (whose
  // activity_daily covers only the window). The full aggregate is small and
  // board-scope-independent, so fetch it separately from /api/activity-daily; on any
  // failure it stays null and the overview falls back to env.activity_daily (the
  // prior behavior). File-loaded contracts are self-contained and must not trigger
  // a server aggregate fetch even if they carry `range_query`. With scope "full"/"off"
  // the primary env already carries the full aggregate (or there is no contract), so
  // no overlay fetch is needed.
  // dataReloadEpoch is in the deps so an in-place reload (manual refresh / post-sync /
  // daemon fresh-data, via reloadData) refetches this overlay too — without it the
  // windowedEnv gate stays true->true across a reload, the effect never re-runs, and
  // the Activity Overview would stay pinned to the pre-reload aggregate (#409).
  useEffect(() => {
    if (contractDisabled || !shouldFetchFullActivityDaily) {
      setFullActivityDaily(null);
      return;
    }
    let cancelled = false;
    void fetchActivityDaily(serverBaseUrl).then((daily) => {
      if (!cancelled) setFullActivityDaily(daily);
    });
    return () => {
      cancelled = true;
    };
  }, [contractDisabled, shouldFetchFullActivityDaily, serverBaseUrl, reloadKey, dataReloadEpoch]);

  // The visibility pre-filter is applied FIRST: visibleEnv is the contract
  // narrowed to the repos + sources the Settings page leaves visible (items +
  // their edges). Everything below — facets, filters, stats, statuses — works
  // over visibleEnv, so a hidden repo/source disappears from every page. allRepos
  // is derived over the FULL contract so the Settings page can still list (and
  // re-enable) hidden repos.
  const visibleEnv = useMemo(() => (env ? applyVisibility(env, hidden, hiddenSources) : null), [env, hidden, hiddenSources]);
  const primaryItems = useMemo(() => (visibleEnv ? visibleEnv.items.filter(itemIsPrimaryWindow) : []), [visibleEnv]);
  // Item index by ref for the edge resolver. When a historical range is active,
  // visibleEnv is the /api/range projection, so this index is intentionally
  // range-scoped (exactly the projected items + their edge endpoints).
  const itemsById = useMemo(() => (visibleEnv ? indexItems(visibleEnv) : new Map()), [visibleEnv]);
  // Index for resolving Activity review rows to their target PR's CURRENT review
  // threads. Range contracts include in-range review activity targets as support
  // rows, so the active projection is enough here.
  const activityItemsById = itemsById;
  const allRepos = useMemo(() => (env ? deriveRepoOptions(env) : []), [env]);
  const windowedActivities = useMemo(
    () => (visibleEnv && activeRange ? filterActivitiesByRange(visibleEnv.activities ?? [], activeRange, tz) : []),
    [visibleEnv, activeRange, tz],
  );
  const repoMetrics = useMemo(
    () => sortRepoMetrics((visibleEnv?.repo_metrics ?? []).filter((metric) => repoMetricMatches(metric, itemFilters))),
    [visibleEnv, itemFilters],
  );
  const fullEntityTotals = useMemo(() => {
    if (!env) {
      return { fullItemTotal: 0, fullRepoMetricTotal: 0, fullChangeRequestTotal: 0, loadedReviewThreadTotal: 0, reviewThreadEntityTotal: 0 };
    }

    const fullItemTotal = env.item_window?.total_items ?? env.repo_stats?.reduce((sum, stat) => sum + stat.items, 0) ?? env.items.length;

    let fullChangeRequestTotal = 0;
    if (env.repo_stats) {
      for (const stat of env.repo_stats) fullChangeRequestTotal += stat.by_kind.change_request ?? 0;
    } else {
      for (const item of env.items) if (item.kind === "change_request") fullChangeRequestTotal += 1;
    }

    let itemReviewThreadTotal = 0;
    for (const item of env.items) itemReviewThreadTotal += item.review_threads?.total ?? 0;
    const loadedReviewThreadTotal = Math.max(env.review_threads?.length ?? 0, itemReviewThreadTotal);
    return {
      fullItemTotal,
      fullRepoMetricTotal: env.repo_stats?.length ?? env.repo_metrics?.length ?? 0,
      fullChangeRequestTotal,
      loadedReviewThreadTotal,
      reviewThreadEntityTotal: loadedReviewThreadTotal > 0 ? loadedReviewThreadTotal : fullChangeRequestTotal,
    };
  }, [env]);

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
    () => new Map((env?.sources ?? []).map((s) => [s.source_id, s.kind])),
    [env],
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
    // PR/MR still has open threads. Range projections include review-activity
    // target support rows, so the active projection is enough here.
    return route.unresolved === "1" ? base.filter((a) => reviewActivityIsUnresolved(a, activityItemsById)) : base;
  }, [routeActivities, filters.search, route.unresolved, activityItemsById]);

  // The chip groups the shared Controls renders, built per page — every page now
  // drives its chips STRICTLY from the route. Activity uses its own
  // source/repo/kind/action facets (the repo group is a "pinned" mode showing
  // only the active drill-down repo); items / board / graph / repo-analytics share the
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
    // items / board / graph / repo-analytics share the item lens.
    const groups: ControlGroup[] = [
      { dim: "sources", label: "source", values: facets.sources, active: itemFacetState.sources, displayValue: sourceDisplayName },
      { dim: "states", label: "state", values: facets.states, active: itemFacetState.states },
      { dim: "kinds", label: "kind", values: facets.kinds, active: itemFacetState.kinds, displayValue: itemKindFacetLabel },
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

  const windowItems = useMemo(
    () => (activeRange ? filterItemsByRange(primaryItems, activeRange, tz) : []),
    [primaryItems, activeRange, tz],
  );
  const itemLogItems = useMemo(
    () => (activeRange ? filterItemsByRange(filteredItems, activeRange, tz) : []),
    [filteredItems, activeRange, tz],
  );

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
  const totalCommits = useMemo(
    () => boardCommitTotal(env ? { activities: env.activities, activity_daily: fullActivityDaily ?? env.activity_daily } : null),
    [env, fullActivityDaily],
  );

  const filteredEdges = useMemo(() => {
    if (!visibleEnv) return [];
    return resolveEdges(visibleEnv, itemsById).filter((re) => edgeMatches(re, itemFilters));
  }, [visibleEnv, itemsById, itemFilters]);

  const filteredEdgeDTOs = useMemo(() => filteredEdges.map((re) => re.edge), [filteredEdges]);

  // Graph focus uses the loaded projection's edge set. There is no full-contract
  // overlay under range-as-download; the focused view expands within whatever the
  // current primary env loaded.
  const graphFocusEdges = filteredEdges;
  const canUseContractAggregates =
    hidden.size === 0 &&
    hiddenSources.size === 0 &&
    filters.search.trim() === "" &&
    itemFacetState.sources.size === 0 &&
    itemFacetState.states.size === 0 &&
    itemFacetState.kinds.size === 0 &&
    itemFacetState.reviews.size === 0 &&
    itemFacetState.repos.size === 0;
  const compatibleAggregates = canUseContractAggregates && !customRange && !windowedEnv ? (env?.aggregates ?? []) : [];

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
      // Preserve the Reviews sort toggle across a facet change (page-local view
      // state, like focus for Graph); null off Reviews so it never leaks.
      reviewSort: page === "reviews" ? route.reviewSort : null,
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
    const next = clearFiltersHref(
      {
        ...current,
        from: explicitRange?.from ?? null,
        to: explicitRange?.to ?? null,
        preset: explicitRange ? route.preset : null,
      },
      page,
    );
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

  // Flip one Live event category's visibility (its own layer, like sources). The
  // set stores HIDDEN categories, so present = hidden, absent = visible.
  function toggleEventType(category: string) {
    setHiddenEventTypes((h) => {
      const next = new Set(h);
      if (next.has(category)) next.delete(category);
      else next.add(category);
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
        fileEnvAuthoritativeRef.current = true;
        setEnv(loaded.env);
        setEnvAuthority("file");
        setContractMeta(loaded.meta);
        setFullActivityDaily(null);
        rememberContractTimezone(loaded.env);
        setError(null);
        setLoading(false);
        setRetrying(false);
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

  function liveDetailHash(open: boolean): string | null {
    const current = parseHashRoute(readHash());
    if (current.page !== "live") return null;
    return buildHashRoute({ ...current, page: "live", liveDetail: open ? "1" : null });
  }

  function openLiveDetailRoute() {
    if (typeof window === "undefined") return;
    const next = liveDetailHash(true);
    if (!next || readHash() === next) return;
    window.history.pushState({ ...historyStateObject(), symphonyLiveDetail: true }, "", next);
    setHash(next);
  }

  function replaceLiveDetailRouteClosed() {
    if (typeof window === "undefined") return;
    const next = liveDetailHash(false);
    if (!next || readHash() === next) return;
    const state = historyStateObject();
    delete state.symphonyLiveDetail;
    window.history.replaceState(state, "", next);
    setHash(next);
  }

  function closeLiveDetailRoute() {
    if (typeof window === "undefined") return;
    const current = parseHashRoute(readHash());
    if (current.page !== "live" || current.liveDetail !== "1") return;
    const next = liveDetailHash(false);
    if ((window.history.state as { symphonyLiveDetail?: unknown } | null)?.symphonyLiveDetail === true) {
      window.history.back();
      if (next) setHash(next);
      return;
    }
    replaceLiveDetailRouteClosed();
  }

  // Reviews phone-overlay route, mirroring the Live detail route above: the
  // narrow-screen thread detail is a full-screen overlay whose open/closed state
  // is route-backed (?reviewDetail=1) so Android/browser Back closes the detail
  // before leaving the Reviews tab. Wide screens render the detail inline and
  // ignore this flag (the page clears a stray one).
  function reviewDetailHash(open: boolean): string | null {
    const current = parseHashRoute(readHash());
    if (current.page !== "reviews") return null;
    return buildHashRoute({ ...current, page: "reviews", reviewDetail: open ? "1" : null });
  }

  function openReviewDetailRoute() {
    if (typeof window === "undefined") return;
    const next = reviewDetailHash(true);
    if (!next || readHash() === next) return;
    window.history.pushState({ ...historyStateObject(), symphonyReviewDetail: true }, "", next);
    setHash(next);
  }

  function replaceReviewDetailRouteClosed() {
    if (typeof window === "undefined") return;
    const next = reviewDetailHash(false);
    if (!next || readHash() === next) return;
    const state = historyStateObject();
    delete state.symphonyReviewDetail;
    window.history.replaceState(state, "", next);
    setHash(next);
  }

  function closeReviewDetailRoute() {
    if (typeof window === "undefined") return;
    const current = parseHashRoute(readHash());
    if (current.page !== "reviews" || current.reviewDetail !== "1") return;
    const next = reviewDetailHash(false);
    if ((window.history.state as { symphonyReviewDetail?: unknown } | null)?.symphonyReviewDetail === true) {
      window.history.back();
      if (next) setHash(next);
      return;
    }
    replaceReviewDetailRouteClosed();
  }

  // Reviews list order (?reviewSort=grouped). Route-backed like reviewDetail so a
  // reload / shared link preserves it; recency is the default, so it maps to a
  // null field and keeps the URL clean. Spreads the current route to preserve the
  // page's facets and the shared item lens, mirroring reviewDetailHash.
  function setReviewSort(next: ReviewSort) {
    if (typeof window === "undefined") return;
    const current = parseHashRoute(readHash());
    if (current.page !== "reviews") return;
    const nextHash = buildHashRoute({ ...current, page: "reviews", reviewSort: next === "grouped" ? "grouped" : null });
    if (readHash() !== nextHash) window.location.hash = nextHash;
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
      reviewSort: page === "reviews" ? route.reviewSort : null,
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
      reviewSort: page === "reviews" ? route.reviewSort : null,
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
        <DebugPage serverBaseUrl={serverBaseUrl} env={env} contractMeta={contractMeta} tab={debugTab} onTab={setDebugTab} onRefreshData={reloadData} onClose={toggleDebug} />
      </div>
    );
  }

  // The shared top tab bar, built once and rendered both on the Live route
  // (below, before the contract gates) and in the main shell return — so Live
  // switches like any other tab instead of being a separate full-screen view.
  // Live leads (the realtime headline) and appears only where the receiver
  // answers (liveAvailable). routeHref carries search/range/lens across the hop.
  // Remount when the tab set changes so WebKit does not keep the old sticky flex
  // layout after Board data is turned off and back on.
  const pageTabsKey = `page-tabs-${contractEnabled ? "board" : "live-only"}-${liveTabShown ? "live" : "no-live"}`;
  const pageTabs = (
    <nav key={pageTabsKey} className="page-tabs" data-board-data={contractEnabled ? "on" : "off"}>
      {liveTabShown ? (
        <a className={`tab tab-live${page === "live" ? " tab-on" : ""}`} href={routeHref("live")}>
          <span className="tab-live-dot" aria-hidden="true" />
          Live
        </a>
      ) : null}
      {/* The contract-backed tabs only appear when board data is enabled. With
          board-scope OFF (Live-only) they are hidden — there is no contract to
          view — leaving just Live + Settings. */}
      {contractEnabled ? (
        <>
          <a className={`tab${page === "activity" ? " tab-on" : ""}`} href={routeHref("activity")}>
            Activity
          </a>
          <a className={`tab${page === "items" ? " tab-on" : ""}`} href={routeHref("items")}>
            Items
          </a>
          <a className={`tab${page === "commits" ? " tab-on" : ""}`} href={routeHref("commits")}>
            Commits
          </a>
          <a className={`tab${page === "reviews" ? " tab-on" : ""}`} href={routeHref("reviews")}>
            Reviews
          </a>
          <a className={`tab${page === "board" ? " tab-on" : ""}`} href={routeHref("board")}>
            Board
          </a>
          <a className={`tab${page === "graph" ? " tab-on" : ""}`} href={routeHref("graph")}>
            Graph
          </a>
          <a className={`tab${page === "repo-analytics" ? " tab-on" : ""}`} href={routeHref("repo-analytics")}>
            Analytics
          </a>
        </>
      ) : null}
      <a className={`tab${page === "settings" ? " tab-on" : ""}`} href={routeHref("settings")}>
        Settings
      </a>
    </nav>
  );

  // Settings is built once and rendered BOTH from the early return below (so it is
  // reachable when the contract is off / still loading / failed — exactly when the
  // board-scope control is needed) and, for symmetry, in the loaded shell. Every
  // prop it reads is env-independent except the repo lists, which are empty until a
  // contract loads (env?.sources / allRepos already degrade to []).
  const settingsPageEl = (
    <SettingsPage
      sources={env?.sources ?? []}
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
      disabledRangePresets={disabledRangePresets}
      boardScope={boardScope}
      onBoardScope={setBoardScope}
      wideLayout={wideLayout}
      onWideLayout={setWideLayout}
      colorMode={colorMode}
      onColorMode={setColorMode}
      livePreviewLines={livePreviewLines}
      onLivePreviewLines={setLivePreviewLines}
      liveTabEnabled={liveTabEnabled}
      onLiveTabEnabled={setLiveTabEnabled}
      liveDisabled={livePreferencesDisabled}
      hiddenEventTypes={hiddenEventTypes}
      onToggleEventType={toggleEventType}
      defaultTab={defaultTab}
      onDefaultTab={setDefaultTab}
      serverBaseUrl={serverBaseUrl}
      onServerBaseUrl={applyServerBaseUrl}
      sync={sync}
      config={configState}
      tab={settingsTab}
      onTab={setSettingsTab}
    />
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
        ) : (
          <BrandHeader />
        )}
        {pageTabs}
        <LivePage
          live={live}
          previewLines={livePreviewLines}
          hiddenEventTypes={hiddenEventTypes}
          detailRouteOpen={route.liveDetail === "1"}
          onOpenDetailRoute={openLiveDetailRoute}
          onCloseDetailRoute={closeLiveDetailRoute}
          onClearDetailRoute={closeLiveDetailRoute}
        />
      </div>
    );
  }

  // Settings also renders BEFORE the contract gates so it stays reachable when the
  // contract is off, still loading, or failed — that is exactly when the user needs
  // it (to pick a board-scope window, turn board data off/on, or fix the server
  // URL). Its repo lists are empty until a contract loads; every other control works.
  if (route.page === "settings") {
    return (
      <div className="app app-wide">
        {env ? (
          <Header env={env} sync={sync} hiddenSources={hiddenSources} refreshing={refreshingData} onRefresh={refreshData} />
        ) : (
          <BrandHeader />
        )}
        {pageTabs}
        {settingsPageEl}
      </div>
    );
  }

  // board-scope OFF on a contract-backed route: there is no board data to show, so
  // render a clear "board data is off" panel (with the tab bar) instead of hanging
  // on the "Loading contract…" gate below — which never resolves with no fetch in
  // flight. Live and Settings are handled above; this covers Activity/Board/etc.
  if (contractDisabled) {
    const canEnableLiveHere = !liveTabEffectivelyEnabled && !livePreferencesDisabled;
    return (
      <div className="app app-wide">
        <BrandHeader />
        {pageTabs}
        <div className="state-msg">
          <p>Board data is turned off on this device.</p>
          {canEnableLiveHere ? (
            <p className="state-actions">
              <button
                type="button"
                className="toggle toggle-on"
                onClick={() => {
                  setLiveTabEnabled(true);
                  window.location.hash = routeHref("live");
                }}
              >
                Enable Live
              </button>
            </p>
          ) : null}
          <p className="muted">
            {canEnableLiveHere
              ? "Enable Live to use the realtime feed without loading board data. "
              : liveTabEffectivelyEnabled
                ? "Live is available from the Live tab. "
                : ""}
            To load issues, PRs, and the board, pick a data range in{" "}
            <a href={routeHref("settings")}>Settings → Display</a>.
          </p>
        </div>
      </div>
    );
  }

  // The solid cold-start splash covers this during the initial load; it stays a
  // safe non-blank fallback if the splash is ever dismissed (e.g. the boot
  // timeout, or a later server-URL change re-entering loading) — never a blank
  // null frame, which is what made the Live cold start look broken. Gated on "no
  // content yet" (contractLoadingViewVisible), NOT `loading` alone, so a board the
  // cold-start cache already painted is never hidden behind this overlay while the
  // background revalidation fetch runs — see the helper for the full rationale.
  if (contractLoadingViewVisible(loading, env !== null)) return <div className="state-msg">Loading contract…</div>;

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
        <p className="muted" role="status">
          {retrying ? "Retrying automatically…" : "Automatic retries are paused."}
        </p>
        <p>
          <button type="button" className="toggle" onClick={retryContractLoad}>
            Retry now
          </button>
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
  const rangeLoadError = error;

  // The whole board has no data at all (fresh install / not yet synced) — drives
  // the board-empty treatment instead of a misleading "nothing in this range".
  // 4.0.0 windows `activities` to ~30 days, so isBoardEmpty also consults the
  // full-history `activity_daily.total`: a dormant board can have an empty
  // windowed `activities` array yet real history (items long since aged out).
  const boardEmpty = isBoardEmpty({ ...env, activity_daily: fullActivityDaily ?? env.activity_daily });
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
  const { fullItemTotal, fullRepoMetricTotal, reviewThreadEntityTotal } = fullEntityTotals;

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
              onClearFilters={clearFilters}
              onLoadFile={loadFile}
              onMobilePanel={setMobileControlPanel}
            />
          )}
          <TimeRangeControls
            range={activeRange}
            generatedAt={env.generated_at}
            timezone={tz}
            preferredPresetId={explicitRange ? route.preset : defaultRangePreset}
            // A focused graph item shows its loaded relationships without the
            // overview time filter,
            // so the range is visibly suspended there — selection kept, dimmed,
            // interaction off. Route-backed (?focus=), so reload/back agree. A
            // static deployment (#432) also suspends it: the range is pinned to the
            // full loaded extent, so the control is shown dimmed rather than
            // implying a sub-range filter that cannot run server-side.
            suspended={(page === "graph" && route.focus != null) || staticDeployment}
            suspendedReason={page === "graph" && route.focus != null ? "focus" : "static"}
            // #488: cap the quick-range presets at the DEVICE CEILING (1y desktop /
            // 30d Android) — the widest range this device may request. The manual
            // from/to inputs stay an escape hatch and are clamped at fetch time.
            loadedFrom={ceilingFrom}
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
      {rangeLoadError ? (
        <div className="state-msg state-msg-inline error">
          <p>Could not load selected range: {rangeLoadError}</p>
          <p className="muted">Showing the previous loaded data until a retry succeeds.</p>
        </div>
      ) : null}
      {page === "settings" ? (
        // Settings is handled by the early return above (so it works without a
        // contract); this branch stays only for completeness of the page switch.
        settingsPageEl
      ) : page === "activity" ? (
        <ActivityPage
          activities={filteredActivities}
          allActivities={env.activities ?? []}
          activityDaily={fullActivityDaily ?? env.activity_daily ?? null}
          generatedAt={env.generated_at}
          windowTotal={windowedActivities.length}
          totalActivities={(fullActivityDaily ?? env.activity_daily)?.total ?? env.activities?.length ?? 0}
          range={activeRange}
          timezone={tz}
          sourceKind={sourceKind}
          colorOf={colorOf}
          itemsById={activityItemsById}
          view={activityViewValue}
          onView={setActivityView}
          emptyState={
            <EmptyState noun="activity" total={(fullActivityDaily ?? env.activity_daily)?.total ?? env.activities?.length ?? 0} windowTotal={windowedActivities.length} {...emptyStateShared} dataExtent={activityDataExtent} />
          }
        />
      ) : page === "items" ? (
        <ItemsPage
          items={itemLogItems}
          windowTotal={windowItems.length}
          totalItems={fullItemTotal}
          range={activeRange}
          sourceKind={sourceKind}
          colorOf={colorOf}
          relationCounts={boardRelationCounts}
          lens={itemFacetFields(itemFacetState)}
          emptyState={
            <EmptyState noun="items" total={fullItemTotal} windowTotal={windowItems.length} {...emptyStateShared} dataExtent={staticRange} />
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
      ) : page === "reviews" ? (
        <ReviewsPage
          reviewThreads={visibleEnv.review_threads ?? []}
          windowItems={primaryItems}
          filters={itemFilters}
          itemsById={activityItemsById}
          range={activeRange}
          sourceKind={sourceKind}
          sort={reviewSortFromRoute(route.reviewSort)}
          onSortChange={setReviewSort}
          detailRouteOpen={route.reviewDetail === "1"}
          onOpenDetailRoute={openReviewDetailRoute}
          onCloseDetailRoute={closeReviewDetailRoute}
          onClearDetailRoute={closeReviewDetailRoute}
          emptyState={
            <EmptyState
              noun="review threads"
              total={reviewThreadEntityTotal}
              windowTotal={visibleEnv.review_threads?.length ?? 0}
              {...emptyStateShared}
            />
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
              total={fullRepoMetricTotal}
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
            itemWindow={env.item_window}
            range={activeRange}
            timezone={tz}
            emptyState={
              <EmptyState noun="relationships" total={env.edges.length} windowTotal={env.edges?.length ?? 0} {...emptyStateShared} />
            }
            onClearFilters={clearFilters}
            theme={resolvedTheme}
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
          itemWindow={env.item_window}
          range={activeRange}
          lens={itemFacetFields(itemFacetState)}
        />
      )}
    </div>
  );
}
