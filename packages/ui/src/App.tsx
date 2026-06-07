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
  type Filters,
  type GroupBy,
  type View,
} from "./model.ts";
import { Header } from "./components/Header.tsx";
import { StatsBar } from "./components/StatsBar.tsx";
import { Controls } from "./components/Controls.tsx";
import { Relationships } from "./components/Relationships.tsx";
import { Board } from "./components/Board.tsx";
import { StatusBoard } from "./components/StatusBoard.tsx";
import { Spotlight } from "./components/Spotlight.tsx";
import { FullBoard } from "./components/FullBoard.tsx";

// The Graph page pulls in cytoscape (~400KB) — lazy-load it so the board page
// stays light; the chunk only loads when #/graph is opened.
const GraphPage = lazy(() => import("./components/GraphPage.tsx").then((m) => ({ default: m.GraphPage })));

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

// Two pages via a zero-dep hash route: "" (#/) is the primary full-width board,
// "debug" (#/debug) keeps the centered inspection view (list toggle + edges).
const readRoute = (): string => (typeof location !== "undefined" ? location.hash.replace(/^#\/?/, "") : "");

export function App() {
  const [env, setEnv] = useState<ContractEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [groupBy, setGroupBy] = useState<GroupBy>("source");
  const [view, setView] = useState<View>("board");
  const [route, setRoute] = useState<string>(readRoute);
  const isDebug = route === "debug";

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    fetchContract()
      .then((e) => {
        setEnv(e);
        setError(null);
      })
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const facets = useMemo(() => {
    if (!env) return { sources: [], states: [], kinds: [] };
    return {
      sources: uniq(env.items.map((i) => i.source_id)),
      states: uniq(env.items.map((i) => i.state)),
      kinds: uniq(env.items.map((i) => i.kind)),
    };
  }, [env]);

  const filteredItems = useMemo(
    () => (env ? env.items.filter((i) => itemMatches(i, filters)) : []),
    [env, filters],
  );

  const filteredEdges = useMemo(() => {
    if (!env) return [];
    const byId = indexItems(env);
    return resolveEdges(env, byId).filter((re) => edgeMatches(re, filters));
  }, [env, filters]);

  const stats = useMemo(
    () => computeStats(filteredItems, filteredEdges.map((re) => re.edge)),
    [filteredItems, filteredEdges],
  );

  // Status is intrinsic — derived over ALL items/edges, then filtered items are
  // placed into columns (so a closed item's Tracking status is correct even when
  // its related open item is filtered out of view).
  const statuses = useMemo(() => (env ? deriveStatuses(env.items, env.edges) : new Map()), [env]);

  function toggle(dim: "sources" | "states" | "kinds", value: string) {
    setFilters((f) => {
      const next = new Set(f[dim]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...f, [dim]: next };
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

  if (!env) return null;
  const unsupported = majorOf(env.contract_version) !== SUPPORTED_MAJOR;

  const isGraph = route === "graph";
  return (
    <div className={isDebug ? "app" : "app app-wide"}>
      <Header env={env} />
      <nav className="page-tabs">
        <a className={`tab${!isDebug && !isGraph ? " tab-on" : ""}`} href="#/">
          Board
        </a>
        <a className={`tab${isGraph ? " tab-on" : ""}`} href="#/graph">
          Graph
        </a>
        <a className={`tab${isDebug ? " tab-on" : ""}`} href="#/debug">
          Debug
        </a>
      </nav>
      {unsupported && (
        <div className="banner warn">
          This UI targets contract major v{SUPPORTED_MAJOR}, but the loaded contract is {env.contract_version}. Some
          fields may not render correctly.
        </div>
      )}
      <Controls
        filters={filters}
        facets={facets}
        groupBy={groupBy}
        view={view}
        compact={!isDebug}
        onSearch={(q) => setFilters((f) => ({ ...f, search: q }))}
        onToggle={toggle}
        onGroupBy={setGroupBy}
        onView={setView}
        onLoadFile={loadFile}
      />
      <StatsBar stats={stats} />
      {isDebug ? (
        <>
          {view === "board" ? (
            <>
              <StatusBoard items={filteredItems} statuses={statuses} />
              <Spotlight items={filteredItems} />
            </>
          ) : (
            <Board items={filteredItems} groupBy={groupBy} />
          )}
          <Relationships edges={filteredEdges} />
        </>
      ) : isGraph ? (
        <Suspense fallback={<div className="state-msg">Loading graph…</div>}>
          <GraphPage edges={filteredEdges} />
        </Suspense>
      ) : (
        <FullBoard items={filteredItems} statuses={statuses} />
      )}
    </div>
  );
}
