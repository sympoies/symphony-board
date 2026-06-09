import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import { fetchContract, fetchRangeContract, parseContract, majorOf, resolveEndpoint, SUPPORTED_MAJOR } from "./contract.ts";
import {
  emptyFilters,
  activityRouteMatches,
  activityMatches,
  filterCommits,
  commitRepoOptions,
  commitBranchOptions,
  preferredDefaultTimeRange,
  staticContractTimeRange,
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
  type TimeRangePresetId,
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
  loadDefaultRangePreset,
  saveDefaultRangePreset,
  loadServerBaseUrl,
  saveServerBaseUrl,
  normalizeServerBaseUrl,
} from "./viewconfig.ts";
import { useSync } from "./useSync.ts";
import { Header } from "./components/Header.tsx";
import { Controls } from "./components/Controls.tsx";
import { FullBoard } from "./components/FullBoard.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { ActivityPage } from "./components/ActivityPage.tsx";
import { CommitsPage } from "./components/CommitsPage.tsx";
import { RepoAnalyticsPage } from "./components/RepoAnalyticsPage.tsx";
import { TimeRangeControls } from "./components/TimeRangeControls.tsx";
import { ServerConnectionForm } from "./components/ServerConnectionForm.tsx";

// The Graph page pulls in React Flow + layout libs — lazy-load it so the board
// page stays light; the chunk only loads when #/graph is opened.
const GraphPage = lazy(() => import("./components/GraphPage.tsx").then((m) => ({ default: m.GraphPage })));

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

// Pages via a zero-dep hash route: "" (#/) is the full-width board, "graph"
// (#/graph) the relationship graph, "activity" (#/activity) the event feed,
// "commits" (#/commits) the cross-repo commit log, "repo-analytics"
// (#/repo-analytics) the per-repo metrics view, and "settings" (#/settings) the
// persistent repo display filter. The route may carry "?q=<search>" so the
// visible search box is URL-backed; graph routes may also carry "?focus=<ref>"
// from a board card, and commits routes carry "?repo=<project_path>" and
// "?branch=<branch>" for the page-local SCM filters.
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
  //   • defaultRangePreset — which quick preset is used when the route has no from/to
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(loadHiddenSources);
  const [colorOverrides, setColorOverrides] = useState<Map<string, string>>(loadColorOverrides);
  const [defaultRangePreset, setDefaultRangePreset] = useState<TimeRangePresetId>(loadDefaultRangePreset);
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(loadServerBaseUrl);

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
        : route.page === "commits"
          ? "commits"
          : route.page === "repo-analytics" || route.page === "repos"
            ? "repo-analytics"
            : route.page === "settings"
              ? "settings"
              : "board";
  // The zone the contract buckets calendar days in (default UTC). Threaded into
  // every preset / range-filter / day-bucketing call so the UI's calendar days
  // match the configured timezone.
  const tz = env?.timezone ?? "UTC";
  const staticRange = useMemo(() => (env ? staticContractTimeRange(env) : null), [env]);
  const defaultRange = useMemo(() => (env ? preferredDefaultTimeRange(env, defaultRangePreset) : null), [env, defaultRangePreset]);
  const explicitRange = useMemo(() => routeTimeRange(route), [route]);
  const activeRange = explicitRange ?? defaultRange;
  const customRange = !!activeRange && !!staticRange && !sameTimeRange(activeRange, staticRange);
  const needsRangeEnv = customRange && page !== "settings";

  // Reload the active data in place after a successful manual sync. It only
  // re-fetches the contract (and the range response for a custom range); the
  // route, search, filters, time range, and display preferences are URL/state
  // backed and untouched, so they survive the reload.
  const reloadData = useCallback(() => {
    fetchContract(undefined, serverBaseUrl)
      .then((e) => {
        setEnv(e);
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message));
    if (needsRangeEnv && activeRange) {
      fetchRangeContract(activeRange, serverBaseUrl)
        .then((next) => setRangeEnv(next))
        .catch((err: unknown) => setRangeError((err as Error).message));
    }
  }, [needsRangeEnv, activeRange, serverBaseUrl]);
  const sync = useSync(reloadData, serverBaseUrl);

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

  const applyServerBaseUrl = useCallback((nextRaw: string | null) => {
    saveServerBaseUrl(normalizeServerBaseUrl(nextRaw));
    setServerBaseUrl(loadServerBaseUrl());
    setEnv(null);
    setRangeEnv(null);
    setError(null);
    setRangeError(null);
    setLoading(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchContract(undefined, serverBaseUrl)
      .then((e) => {
        if (cancelled) return;
        setEnv(e);
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
  const allRepos = useMemo(() => (env ? deriveRepoOptions(env) : []), [env]);
  const windowedActivities = useMemo(
    () => (visibleEnv && activeRange ? filterActivitiesByRange(visibleEnv.activities ?? [], activeRange, tz) : []),
    [visibleEnv, activeRange, tz],
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

  const routeActivities = useMemo(
    () => windowedActivities.filter((a) => activityRouteMatches(a, route)),
    [windowedActivities, route.source, route.repo, route.kind, route.action],
  );

  const filteredActivities = useMemo(
    () => routeActivities.filter((a) => activityMatches(a, filters)),
    [routeActivities, filters],
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
  const totalCommits = useMemo(
    () => (env?.activities ?? activeEnv?.activities ?? []).filter((a) => a.kind === "commit").length,
    [env, activeEnv],
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

  function routeHref(nextPage: "board" | "graph" | "activity" | "commits" | "repo-analytics" | "settings"): string {
    return buildHashRoute({
      page: nextPage === "board" ? "" : nextPage,
      q: filters.search,
      from: explicitRange?.from,
      to: explicitRange?.to,
      preset: explicitRange ? route.preset : null,
    });
  }

  function setRouteSearch(q: string) {
    setFilters((f) => ({ ...f, search: q }));
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page: page === "board" ? "" : page,
      focus: page === "graph" ? route.focus : null,
      source: page === "activity" || page === "commits" ? route.source : null,
      repo: page === "activity" || page === "commits" ? route.repo : null,
      branch: page === "commits" ? route.branch : null,
      kind: page === "activity" ? route.kind : null,
      action: page === "activity" ? route.action : null,
      q,
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
      page: page === "board" ? "" : page,
      focus: page === "graph" ? route.focus : null,
      source: page === "activity" || page === "commits" ? route.source : null,
      repo: page === "activity" || page === "commits" ? route.repo : null,
      branch: page === "commits" ? route.branch : null,
      kind: page === "activity" ? route.kind : null,
      action: page === "activity" ? route.action : null,
      q: filters.search,
      from: range.from,
      to: range.to,
      preset: presetId,
    });
    if (readHash() !== next) window.location.hash = next;
  }

  if (loading) return <div className="state-msg">Loading contract…</div>;

  if (error && !env) {
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

  return (
    <div className="app app-wide">
      <Header env={env} sync={sync} />
      <nav className="page-tabs">
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
        <>
          {page !== "commits" && (
            <Controls
              filters={filters}
              facets={facets}
              onSearch={setRouteSearch}
              onToggle={toggle}
              onLoadFile={loadFile}
            />
          )}
          <TimeRangeControls
            range={activeRange}
            generatedAt={env.generated_at}
            timezone={tz}
            preferredPresetId={explicitRange ? route.preset : defaultRangePreset}
            loading={rangeLoading}
            error={rangeError}
            onRange={setRouteRange}
          />
        </>
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
          serverBaseUrl={serverBaseUrl}
          onServerBaseUrl={applyServerBaseUrl}
          sync={sync}
        />
      ) : page === "activity" ? (
        <ActivityPage
          activities={filteredActivities}
          allActivities={env.activities ?? activeEnv.activities ?? []}
          windowTotal={routeActivities.length}
          totalActivities={env.activities?.length ?? activeEnv.activities?.length ?? 0}
          range={activeRange}
          timezone={tz}
          sourceKind={sourceKind}
          colorOf={colorOf}
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
            itemWindow={contentEnv.item_window}
            range={activeRange}
            timezone={tz}
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
          itemWindow={contentEnv.item_window}
          range={activeRange}
        />
      )}
    </div>
  );
}
