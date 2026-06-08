import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import { fetchContract, parseContract, majorOf, SUPPORTED_MAJOR } from "./contract.ts";
import {
  emptyFilters,
  indexItems,
  itemMatches,
  resolveEdges,
  edgeMatches,
  deriveStatuses,
  deriveRepos,
  applyVisibility,
  buildColorIndex,
  resolveRepoColor,
  parseHashRoute,
  buildHashRoute,
  applyRouteSearch,
  edgeEndpointIds,
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

// The Graph page pulls in React Flow + layout libs — lazy-load it so the board
// page stays light; the chunk only loads when #/graph is opened.
const GraphPage = lazy(() => import("./components/GraphPage.tsx").then((m) => ({ default: m.GraphPage })));

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

// Three pages via a zero-dep hash route: "" (#/) is the full-width board,
// "graph" (#/graph) the relationship graph, "settings" (#/settings) the
// persistent repo display filter. The route may carry "?q=<search>" so the
// visible search box is URL-backed; graph routes may also carry "?focus=<ref>"
// from a board card.
const readHash = (): string => (typeof location !== "undefined" ? location.hash : "");

export function App() {
  const [env, setEnv] = useState<ContractEnvelope | null>(null);
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
  const page = route.page === "graph" ? "graph" : route.page === "settings" ? "settings" : "board";

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

  // The visibility pre-filter is applied FIRST: visibleEnv is the contract
  // narrowed to the repos + sources the Settings page leaves visible (items +
  // their edges). Everything below — facets, filters, stats, statuses — works
  // over visibleEnv, so a hidden repo/source disappears from every page. allRepos
  // is derived over the FULL contract so the Settings page can still list (and
  // re-enable) hidden repos.
  const visibleEnv = useMemo(() => (env ? applyVisibility(env, hidden, hiddenSources) : null), [env, hidden, hiddenSources]);
  const allRepos = useMemo(() => (env ? deriveRepos(env.items) : []), [env]);

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
    return {
      sources: uniq(visibleEnv.items.map((i) => i.source_id)),
      states: uniq(visibleEnv.items.map((i) => i.state)),
      kinds: uniq(visibleEnv.items.map((i) => i.kind)),
    };
  }, [visibleEnv]);

  // source_id -> provider kind (github / gitlab), so a card can show its source
  // mark. Provider kind lives on SourceDTO, not the item — look it up here once.
  const sourceKind = useMemo(
    () => new Map((env?.sources ?? []).map((s) => [s.source_id, s.kind])),
    [env],
  );

  const filteredItems = useMemo(
    () => (visibleEnv ? visibleEnv.items.filter((i) => itemMatches(i, filters)) : []),
    [visibleEnv, filters],
  );

  const filteredEdges = useMemo(() => {
    if (!visibleEnv) return [];
    const byId = indexItems(visibleEnv);
    return resolveEdges(visibleEnv, byId).filter((re) => edgeMatches(re, filters));
  }, [visibleEnv, filters]);

  const filteredEdgeDTOs = useMemo(() => filteredEdges.map((re) => re.edge), [filteredEdges]);


  // Status is intrinsic — derived over ALL visible items/edges, then filtered
  // items are placed into columns (so a closed item's Trailing status is correct
  // even when its related open item is removed by a transient facet filter).
  const statuses = useMemo(
    () => (visibleEnv ? deriveStatuses(visibleEnv.items, visibleEnv.edges) : new Map()),
    [visibleEnv],
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
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message));
  }

  function routeHref(nextPage: "board" | "graph" | "settings"): string {
    return buildHashRoute({ page: nextPage === "board" ? "" : nextPage, q: filters.search });
  }

  function setRouteSearch(q: string) {
    setFilters((f) => ({ ...f, search: q }));
    if (typeof window === "undefined") return;
    const next = buildHashRoute({
      page: page === "board" ? "" : page,
      focus: page === "graph" ? route.focus : null,
      q,
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
          Emit one with <code>pnpm run emit -- --out packages/ui/public/contract.json</code>, or load a file:
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

  if (!env || !visibleEnv) return null;
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
          the Board/Graph windows they describe. The Settings page is a config
          surface and has neither. */}
      {page !== "settings" && (
        <Controls
          filters={filters}
          facets={facets}
          onSearch={setRouteSearch}
          onToggle={toggle}
          onLoadFile={loadFile}
        />
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
      ) : page === "graph" ? (
        <Suspense fallback={<div className="state-msg">Loading graph…</div>}>
          {/* Keyed on the focus target so each distinct deep-link entry remounts
              the graph with a fresh window + focus seed (the seed is mount-time);
              a new "?focus=" — or clearing it — never leaves a stale focus. */}
          <GraphPage key={route.focus ?? "graph"} edges={filteredEdges} sourceKind={sourceKind} colorOf={colorOf} focusRef={route.focus} narrowed={filters.search.trim() !== ""} />
        </Suspense>
      ) : (
        <FullBoard items={filteredItems} edges={filteredEdgeDTOs} statuses={statuses} sourceKind={sourceKind} colorOf={colorOf} linkedIds={linkedIds} />
      )}
    </div>
  );
}
