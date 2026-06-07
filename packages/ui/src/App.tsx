import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import { fetchContract, parseContract, majorOf, SUPPORTED_MAJOR } from "./contract.ts";
import {
  emptyFilters,
  indexItems,
  itemMatches,
  resolveEdges,
  edgeMatches,
  computeStats,
  deriveStatuses,
  deriveRepos,
  applyVisibility,
  parseHashRoute,
  applyRouteSearch,
  edgeEndpointIds,
  type Filters,
} from "./model.ts";
import { loadHidden, saveHidden } from "./viewconfig.ts";
import { Header } from "./components/Header.tsx";
import { StatsBar } from "./components/StatsBar.tsx";
import { Controls } from "./components/Controls.tsx";
import { FullBoard } from "./components/FullBoard.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";

// The Graph page pulls in React Flow + layout libs — lazy-load it so the board
// page stays light; the chunk only loads when #/graph is opened.
const GraphPage = lazy(() => import("./components/GraphPage.tsx").then((m) => ({ default: m.GraphPage })));

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

// Three pages via a zero-dep hash route: "" (#/) is the full-width board,
// "graph" (#/graph) the relationship graph, "settings" (#/settings) the
// persistent repo display filter. The graph route may carry a "?focus=<ref>"
// deep-link from a board card (parseHashRoute pulls it out).
const readHash = (): string => (typeof location !== "undefined" ? location.hash : "");

export function App() {
  const [env, setEnv] = useState<ContractEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Seed the search from the hash's "?q=" token if present (a board → graph
  // deep-link), so the graph narrows on the FIRST render — no full-graph flash.
  const [filters, setFilters] = useState<Filters>(() => applyRouteSearch(emptyFilters(), parseHashRoute(readHash())));
  const [hash, setHash] = useState<string>(readHash);
  // Persistent, repo-level display filter (the Settings page). Set of HIDDEN
  // repo keys; loaded once from localStorage and saved back on every change.
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);

  useEffect(() => {
    const onHash = () => {
      const h = readHash();
      setHash(h);
      // A deep-link carrying "?q=" applies its search token in the SAME update as
      // the route change (batched), so the graph mounts already narrowed; absent a
      // q, applyRouteSearch leaves the search alone (never clobbers user input).
      setFilters((prev) => applyRouteSearch(prev, parseHashRoute(h)));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const route = useMemo(() => parseHashRoute(hash), [hash]);

  useEffect(() => {
    saveHidden(hidden);
  }, [hidden]);

  useEffect(() => {
    fetchContract()
      .then((e) => {
        setEnv(e);
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  // The repo-visibility pre-filter is applied FIRST: visibleEnv is the contract
  // narrowed to the repos the Settings page leaves visible (items + their
  // edges). Everything below — facets, filters, stats, statuses — works over
  // visibleEnv, so a hidden repo disappears from every page. allRepos is derived
  // over the FULL contract so the Settings page can still list (and re-enable)
  // hidden repos.
  const visibleEnv = useMemo(() => (env ? applyVisibility(env, hidden) : null), [env, hidden]);
  const allRepos = useMemo(() => (env ? deriveRepos(env.items) : []), [env]);

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

  const stats = useMemo(
    () => computeStats(filteredItems, filteredEdges.map((re) => re.edge)),
    [filteredItems, filteredEdges],
  );

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

  function loadFile(file: File) {
    file
      .text()
      .then((t) => {
        setEnv(parseContract(t));
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message));
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

  const page = route.page === "graph" ? "graph" : route.page === "settings" ? "settings" : "board";
  return (
    <div className="app app-wide">
      <Header env={env} />
      <nav className="page-tabs">
        <a className={`tab${page === "board" ? " tab-on" : ""}`} href="#/">
          Board
        </a>
        <a className={`tab${page === "graph" ? " tab-on" : ""}`} href="#/graph">
          Graph
        </a>
        <a className={`tab${page === "settings" ? " tab-on" : ""}`} href="#/settings">
          Settings
        </a>
      </nav>
      {unsupported && (
        <div className="banner warn">
          This UI targets contract major v{SUPPORTED_MAJOR}, but the loaded contract is {env.contract_version}. Some
          fields may not render correctly.
        </div>
      )}
      {/* The facet Controls + StatsBar drive the data views; the Settings page is
          a config surface and has neither. */}
      {page !== "settings" && (
        <>
          <Controls
            filters={filters}
            facets={facets}
            onSearch={(q) => setFilters((f) => ({ ...f, search: q }))}
            onToggle={toggle}
            onLoadFile={loadFile}
          />
          <StatsBar stats={stats} />
        </>
      )}
      {page === "settings" ? (
        <SettingsPage
          sources={env.sources}
          repos={allRepos}
          hidden={hidden}
          onToggle={toggleRepo}
          onSetVisible={setReposVisible}
        />
      ) : page === "graph" ? (
        <Suspense fallback={<div className="state-msg">Loading graph…</div>}>
          {/* Keyed on the focus target so each distinct deep-link entry remounts
              the graph with a fresh window + focus seed (the seed is mount-time);
              a new "?focus=" — or clearing it — never leaves a stale focus. */}
          <GraphPage key={route.focus ?? "graph"} edges={filteredEdges} sourceKind={sourceKind} focusRef={route.focus} />
        </Suspense>
      ) : (
        <FullBoard items={filteredItems} statuses={statuses} sourceKind={sourceKind} linkedIds={linkedIds} />
      )}
    </div>
  );
}
