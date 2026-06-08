import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import { fetchContract, fetchRangeContract, parseContract, majorOf, SUPPORTED_MAJOR } from "./contract.ts";
import {
  emptyFilters,
  activityMatches,
  defaultTimeRange,
  filterActivitiesByRange,
  indexItems,
  itemMatches,
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
  edgeEndpointIds,
  routeTimeRange,
  sameTimeRange,
  type TimeRange,
  type Filters,
} from "./model.ts";
import {
  loadHidden,
  saveHidden,
  loadHiddenSources,
  saveHiddenSources,
  loadColorOverrides,
  saveColorOverrides,
} from "./viewconfig.ts";
import { Header } from "./components/Header.tsx";
import { Controls } from "./components/Controls.tsx";
import { FullBoard } from "./components/FullBoard.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { ActivityPage } from "./components/ActivityPage.tsx";
import { RepoAnalyticsPage } from "./components/RepoAnalyticsPage.tsx";
import { TimeRangeControls } from "./components/TimeRangeControls.tsx";

// The Graph page pulls in React Flow + layout libs — lazy-load it so the board
// page stays light; the chunk only loads when #/graph is opened.
const GraphPage = lazy(() => import("./components/GraphPage.tsx").then((m) => ({ default: m.GraphPage })));

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

// Four pages via a zero-dep hash route: "" (#/) is the full-width board,
// "graph" (#/graph) the relationship graph, "activity" (#/activity) the event
// feed, "repo-analytics" (#/repo-analytics) the per-repo metrics view, and
// "settings" (#/settings) the persistent repo display filter. The
// route may carry "?q=<search>" so the visible search box is URL-backed; graph
// routes may also carry "?focus=<ref>" from a board card.
const readHash = (): string => (typeof location !== "undefined" ? location.hash : "");

export function App() {
  const [env, setEnv] = useState<ContractEnvelope | null>(null);
  const [rangeEnv, setRangeEnv] = useState<ContractEnvelope | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Seed the search from the hash's "?q=" token if present; the URL is the source
  // of truth, so reloading/share links and Board ↔ Graph tab hops agree.
  const [filters, setFilters] = useState<Filters>(() => applyRouteSearch(emptyFilters(), parseHashRoute(readHash())));
  const [hash, setHash] = useState<string>(readHash);
  // Persistent display preferences (the Settings page), loaded once from
  // localStorage and saved back on every change:
  //   • hidden        — HIDDEN repoKeys
  //   • hiddenSources — HIDDEN source_ids (an independent layer; see applyVisibility)
  //   • colorOverrides — repoKey -> hex, this viewer's per-repo highlight override
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(loadHiddenSources);
  const [colorOverrides, setColorOverrides] = useState<Map<string, string>>(loadColorOverrides);

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
    route.page === "graph"
      ? "graph"
      : route.page === "activity"
        ? "activity"
        : route.page === "repo-analytics" || route.page === "repos"
          ? "repo-analytics"
          : route.page === "settings"
            ? "settings"
            : "board";
  const defaultRange = useMemo(() => (env ? defaultTimeRange(env) : null), [env]);
  const explicitRange = useMemo(() => routeTimeRange(route), [route]);
  const activeRange = explicitRange ?? defaultRange;
  const customRange = !!activeRange && !!defaultRange && !sameTimeRange(activeRange, defaultRange);

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
    fetchContract()
      .then((e) => {
        setEnv(e);
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!activeRange || !defaultRange) return;
    if (!customRange) {
      setRangeEnv(null);
      setRangeError(null);
      setRangeLoading(false);
      return;
    }
    let cancelled = false;
    setRangeLoading(true);
    setRangeError(null);
    fetchRangeContract(activeRange)
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
  }, [activeRange, customRange, defaultRange]);

  const activeEnv = customRange ? rangeEnv : env;

  // The visibility pre-filter is applied FIRST: visibleEnv is the contract
  // narrowed to the repos + sources the Settings page leaves visible (items +
  // their edges). Everything below — facets, filters, stats, statuses — works
  // over visibleEnv, so a hidden repo/source disappears from every page. allRepos
  // is derived over the FULL contract so the Settings page can still list (and
  // re-enable) hidden repos.
  const visibleEnv = useMemo(() => (activeEnv ? applyVisibility(activeEnv, hidden, hiddenSources) : null), [activeEnv, hidden, hiddenSources]);
  const primaryItems = useMemo(() => (visibleEnv ? visibleEnv.items.filter(itemIsPrimaryWindow) : []), [visibleEnv]);
  const allRepos = useMemo(() => (env ? deriveRepoOptions(env) : []), [env]);
  const windowedActivities = useMemo(
    () => (visibleEnv && activeRange ? filterActivitiesByRange(visibleEnv.activities ?? [], activeRange) : []),
    [visibleEnv, activeRange],
  );
  const repoMetrics = useMemo(
    () => sortRepoMetrics((visibleEnv?.repo_metrics ?? []).filter((metric) => repoMetricMatches(metric, filters))),
    [visibleEnv, filters],
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
    if (!visibleEnv) return { sources: [], states: [], kinds: [] };
    if (page === "activity") {
      return {
        sources: uniq(windowedActivities.map((a) => a.source_id)),
        states: [],
        kinds: uniq(windowedActivities.map((a) => a.kind)),
      };
    }
    if (page === "repo-analytics") {
      const metrics = visibleEnv.repo_metrics ?? [];
      return {
        sources: uniq(metrics.map((m) => m.source_id)),
        states: uniq(metrics.flatMap((m) => Object.keys(m.totals.by_item_state))),
        kinds: uniq(metrics.flatMap((m) => Object.keys(m.totals.by_item_kind))),
      };
    }
    const facetItems = page === "graph" ? visibleEnv.items : primaryItems;
    return {
      sources: uniq(facetItems.map((i) => i.source_id)),
      states: uniq(facetItems.map((i) => i.state)),
      kinds: uniq(facetItems.map((i) => i.kind)),
    };
  }, [visibleEnv, page, windowedActivities, primaryItems]);

  // source_id -> provider kind (github / gitlab), so a card can show its source
  // mark. Provider kind lives on SourceDTO, not the item — look it up here once.
  const sourceKind = useMemo(
    () => new Map((activeEnv?.sources ?? []).map((s) => [s.source_id, s.kind])),
    [activeEnv],
  );

  const filteredItems = useMemo(
    () => primaryItems.filter((i) => itemMatches(i, filters)),
    [primaryItems, filters],
  );

  const filteredActivities = useMemo(
    () => windowedActivities.filter((a) => activityMatches(a, filters)),
    [windowedActivities, filters],
  );

  const filteredEdges = useMemo(() => {
    if (!visibleEnv) return [];
    const byId = indexItems(visibleEnv);
    return resolveEdges(visibleEnv, byId).filter((re) => edgeMatches(re, filters));
  }, [visibleEnv, filters]);

  const filteredEdgeDTOs = useMemo(() => filteredEdges.map((re) => re.edge), [filteredEdges]);
  const canUseContractAggregates =
    hidden.size === 0 &&
    hiddenSources.size === 0 &&
    filters.search.trim() === "" &&
    filters.sources.size === 0 &&
    filters.states.size === 0 &&
    filters.kinds.size === 0;
  const compatibleAggregates = canUseContractAggregates && !customRange ? (env?.aggregates ?? []) : [];

  // Status is intrinsic — derived over ALL visible items/edges, then filtered
  // items are placed into columns (so a closed item's Trailing status is correct
  // even when its related open item is removed by a transient facet filter).
  const statuses = useMemo(
    () => (visibleEnv ? deriveStatuses(primaryItems, visibleEnv.edges) : new Map()),
    [visibleEnv, primaryItems],
  );

  // Ids of items that take part in at least one relationship (an edge endpoint),
  // over the FULL visible edge set — NOT the time-windowed / facet-filtered graph.
  // The board card's "focus in graph" link shows ONLY for these: an item with no
  // relationships has no graph node to focus, so the affordance would dead-end.
  const linkedIds = useMemo(() => edgeEndpointIds(visibleEnv?.edges ?? []), [visibleEnv]);

  function toggle(dim: "sources" | "states" | "kinds", value: string) {
    setFilters((f) => {
      const next = new Set(f[dim]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...f, [dim]: next };
    });
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
    file
      .text()
      .then((t) => {
        setEnv(parseContract(t));
        setRangeEnv(null);
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message));
  }

  function routeHref(nextPage: "board" | "graph" | "activity" | "repo-analytics" | "settings"): string {
    return buildHashRoute({ page: nextPage === "board" ? "" : nextPage, q: filters.search, from: activeRange?.from, to: activeRange?.to });
  }

  function setRouteSearch(q: string) {
    setFilters((f) => ({ ...f, search: q }));
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page: page === "board" ? "" : page,
      focus: page === "graph" ? route.focus : null,
      q,
      from: activeRange?.from,
      to: activeRange?.to,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  function setRouteRange(range: TimeRange) {
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page: page === "board" ? "" : page,
      focus: page === "graph" ? route.focus : null,
      q: filters.search,
      from: range.from,
      to: range.to,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  if (loading) return <div className="state-msg">Loading contract…</div>;

  if (error && !env) {
    return (
      <div className="state-msg error">
        <p>
          Could not load <code>./contract.json</code>: {error}
        </p>
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

  if (!env || !activeRange || (customRange && rangeLoading && !rangeEnv)) return <div className="state-msg">Loading range…</div>;
  if (customRange && rangeError && !rangeEnv) {
    return (
      <div className="state-msg error">
        <p>Could not load selected range: {rangeError}</p>
      </div>
    );
  }
  if (!activeEnv || !visibleEnv) return null;
  const unsupported = majorOf(env.contract_version) !== SUPPORTED_MAJOR;

  return (
    <div className="app app-wide">
      <Header env={env} />
      <nav className="page-tabs">
        <a className={`tab${page === "board" ? " tab-on" : ""}`} href={routeHref("board")}>
          Board
        </a>
        <a className={`tab${page === "graph" ? " tab-on" : ""}`} href={routeHref("graph")}>
          Graph
        </a>
        <a className={`tab${page === "activity" ? " tab-on" : ""}`} href={routeHref("activity")}>
          Activity
        </a>
        <a className={`tab${page === "repo-analytics" ? " tab-on" : ""}`} href={routeHref("repo-analytics")}>
          Repo Analytics
        </a>
        <a className={`tab${page === "settings" ? " tab-on" : ""}`} href={routeHref("settings")}>
          Settings
        </a>
      </nav>
      {unsupported && (
        <div className="banner warn">
          This UI targets contract major v{SUPPORTED_MAJOR}, but the loaded contract is {env.contract_version}. Some
          fields may not render correctly.
        </div>
      )}
      {/* The facet Controls drive the data views; page-local StatsBars live beside
          the Board/Graph windows they describe. Activity has no item/edge stats,
          and Settings is a config surface. */}
      {page !== "settings" && (
        <>
          <Controls
            filters={filters}
            facets={facets}
            onSearch={setRouteSearch}
            onToggle={toggle}
            onLoadFile={loadFile}
          />
          <TimeRangeControls
            range={activeRange}
            generatedAt={env.generated_at}
            loading={rangeLoading}
            error={rangeError}
            onRange={setRouteRange}
          />
        </>
      )}
      {page === "settings" ? (
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
        />
      ) : page === "activity" ? (
        <ActivityPage
          activities={filteredActivities}
          windowTotal={windowedActivities.length}
          totalActivities={env.activities?.length ?? activeEnv.activities?.length ?? 0}
          range={activeRange}
          sourceKind={sourceKind}
          colorOf={colorOf}
        />
      ) : page === "repo-analytics" ? (
        <RepoAnalyticsPage
          metrics={repoMetrics}
          windowTotal={visibleEnv.repo_metrics?.length ?? 0}
          range={activeRange}
          sourceKind={sourceKind}
          colorOf={colorOf}
        />
      ) : page === "graph" ? (
        <Suspense fallback={<div className="state-msg">Loading graph…</div>}>
          {/* Keyed on the focus target so each distinct deep-link entry remounts
              the graph with a fresh window + focus seed (the seed is mount-time);
              a new "?focus=" — or clearing it — never leaves a stale focus. */}
          <GraphPage
            key={route.focus ?? "graph"}
            edges={filteredEdges}
            sourceKind={sourceKind}
            colorOf={colorOf}
            focusRef={route.focus}
            narrowed={filters.search.trim() !== ""}
            aggregates={compatibleAggregates}
            itemWindow={activeEnv.item_window}
            range={activeRange}
          />
        </Suspense>
      ) : (
        <FullBoard
          items={filteredItems}
          edges={filteredEdgeDTOs}
          statuses={statuses}
          sourceKind={sourceKind}
          colorOf={colorOf}
          linkedIds={linkedIds}
          aggregates={compatibleAggregates}
          itemWindow={activeEnv.item_window}
          range={activeRange}
        />
      )}
    </div>
  );
}
