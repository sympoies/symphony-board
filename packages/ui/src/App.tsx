import { useEffect, useMemo, useState } from "react";
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

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

export function App() {
  const [env, setEnv] = useState<ContractEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [groupBy, setGroupBy] = useState<GroupBy>("source");
  const [view, setView] = useState<View>("board");

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

  return (
    <div className="app">
      <Header env={env} />
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
        onSearch={(q) => setFilters((f) => ({ ...f, search: q }))}
        onToggle={toggle}
        onGroupBy={setGroupBy}
        onView={setView}
        onLoadFile={loadFile}
      />
      <StatsBar stats={stats} />
      {view === "board" ? (
        <>
          <StatusBoard items={filteredItems} statuses={statuses} />
          <Spotlight items={filteredItems} />
        </>
      ) : (
        <Board items={filteredItems} groupBy={groupBy} />
      )}
      <Relationships edges={filteredEdges} />
    </div>
  );
}
