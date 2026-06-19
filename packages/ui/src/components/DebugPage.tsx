// The hidden Diagnostics page (#/debug, toggled with Cmd+/ / Ctrl+/). Not in
// the page-tabs nav on purpose: it is an operator surface, not a product page.
// Sections degrade independently where their backing data is unavailable:
//   • Contract payload — loaded contract size, shape, windowing, source health
//   • Store — sizes, row counts, and breakdowns from GET /api/stats
//   • Sync runs — the recent sync_run history (status / totals / error)
//   • Daemon log — the writer's in-memory recent-log tail from GET /api/logs
// Unlike every other page it does its own fetching (useDebug.ts): no other
// page shares this data, and it must render with no contract loaded — that is
// exactly when it is needed.

import { useEffect, useRef, useState } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import type { ContractLoadMetadata } from "../contract.ts";
import { contractSectionSizes, contractSourceHealth, contractTopLevelCounts, formatBytes, relativeTime, runDuration } from "../model.ts";
import { useStoreStats, useDaemonLogs } from "../useDebug.ts";
import { Badge } from "./Badge.tsx";
import { StatTile } from "./StatTile.tsx";

interface Props {
  serverBaseUrl: string | null;
  env: ContractEnvelope | null;
  contractMeta: ContractLoadMetadata | null;
  onClose: () => void;
}

function CountsTable({ title, counts }: { title: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts);
  if (rows.length === 0) return null;
  return (
    <div className="debug-card">
      <table className="debug-table">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, n]) => (
            <tr key={key}>
              <td>{key}</td>
              <td className="num">{n.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function storeLabel(db: { driver?: string; path?: string; database?: string; schema?: string }): string {
  if (db.driver === "postgres") return db.schema ? `${db.database ?? "postgres"} / ${db.schema}` : (db.database ?? "postgres");
  return db.path ?? db.driver ?? "store";
}

function formatLoadDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`;
}

function sourceLabel(meta: ContractLoadMetadata | null): string {
  if (!meta) return "unknown";
  return meta.source === "file" ? `file: ${meta.url}` : meta.url;
}

function statusSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([status, n]) => `${status} ${n}`);
  return parts.length > 0 ? parts.join(" · ") : "none";
}

function SectionSizesTable({ env }: { env: ContractEnvelope }) {
  const sections = contractSectionSizes(env);
  return (
    <div className="debug-card">
      <table className="debug-table">
        <thead>
          <tr>
            <th>section bytes</th>
            <th className="num">rows</th>
            <th className="num">size</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <tr key={section.key}>
              <td>{section.label}</td>
              <td className="num">{section.rows == null ? "—" : section.rows.toLocaleString()}</td>
              <td className="num">{formatBytes(section.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemWindowTable({ env }: { env: ContractEnvelope }) {
  const itemWindow = env.item_window;
  if (!itemWindow) return null;
  const rows = [
    ["scope", itemWindow.scope],
    ["window", itemWindow.window.kind],
    ["basis", itemWindow.window.basis],
    ["since", itemWindow.window.since ?? "—"],
    ["days", itemWindow.window.days == null ? "—" : itemWindow.window.days.toLocaleString()],
    ["edge filter", itemWindow.window.edge_filter ?? "—"],
    ["primary items", itemWindow.primary_items.toLocaleString()],
    ["edge endpoints", itemWindow.edge_endpoint_items.toLocaleString()],
    ["total items", itemWindow.total_items.toLocaleString()],
    ["truncated", itemWindow.truncated ? "yes" : "no"],
  ];
  return (
    <div className="debug-card">
      <table className="debug-table">
        <thead>
          <tr>
            <th>item window</th>
            <th>value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td>{key}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceHealthTable({ env }: { env: ContractEnvelope }) {
  if (env.sources.length === 0) return null;
  return (
    <div className="debug-card">
      <table className="debug-table">
        <thead>
          <tr>
            <th>source health</th>
            <th>status</th>
            <th>last success</th>
          </tr>
        </thead>
        <tbody>
          {env.sources.map((source) => {
            const status = source.last_status ?? "unknown";
            return (
              <tr key={source.source_id}>
                <td>{source.display_name ?? source.source_id}</td>
                <td>
                  <Badge text={status} kind={status === "unknown" ? undefined : `status-${status}`} />
                </td>
                <td title={source.last_success_at ?? undefined}>{relativeTime(source.last_success_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DebugPage({ serverBaseUrl, env, contractMeta, onClose }: Props) {
  const { stats, loading, refresh } = useStoreStats(serverBaseUrl);
  const logs = useDaemonLogs(serverBaseUrl);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement | null>(null);
  const dbSize = stats?.db.size_bytes;
  const walSize = stats?.db.wal_size_bytes;
  const contractCounts = env ? contractTopLevelCounts(env) : null;
  const sourceHealth = env ? contractSourceHealth(env) : null;
  const itemWindow = env?.item_window;

  // Tail behavior: keep the newest line in view while "follow" is on; turning
  // it off freezes the scroll position for reading while lines keep arriving.
  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.entries, follow]);

  return (
    <main className="debug-page">
      <div className="debug-head">
        <h2>Diagnostics</h2>
        <span className="muted">hidden page — toggle with ⌘/ (Ctrl+/)</span>
        <button type="button" className="toggle debug-close" onClick={onClose}>
          Close
        </button>
      </div>

      <section className="debug-section">
        <h3>Contract payload</h3>
        {!env ? (
          <p className="empty">No contract loaded.</p>
        ) : (
          <>
            <div className="debug-stat-grid">
              <StatTile label="Payload size">{contractMeta ? formatBytes(contractMeta.bytes) : "unknown"}</StatTile>
              <StatTile label="Loaded from">
                <span className="debug-value-text" title={contractMeta?.url ?? undefined}>
                  {sourceLabel(contractMeta)}
                </span>
              </StatTile>
              <StatTile label="Generated">{relativeTime(env.generated_at)}</StatTile>
              <StatTile label="Loaded">{contractMeta ? relativeTime(contractMeta.loadedAt) : "unknown"}</StatTile>
              <StatTile label="Load time">{contractMeta ? formatLoadDuration(contractMeta.durationMs) : "unknown"}</StatTile>
              <StatTile label="Contract">v{env.contract_version}</StatTile>
              <StatTile label="Generator">
                <span className="debug-value-text" title={env.generator}>
                  {env.generator}
                </span>
              </StatTile>
              <StatTile label="Timezone">{env.timezone ?? "UTC"}</StatTile>
              <StatTile label="Windowed">{itemWindow ? (itemWindow.truncated ? "truncated" : "complete") : "unknown"}</StatTile>
              <StatTile label="Source status">{sourceHealth ? statusSummary(sourceHealth.statusCounts) : "unknown"}</StatTile>
              <StatTile label="Oldest success">{sourceHealth ? relativeTime(sourceHealth.oldestSuccessAt) : "unknown"}</StatTile>
              <StatTile label="Latest success">{sourceHealth ? relativeTime(sourceHealth.latestSuccessAt) : "unknown"}</StatTile>
            </div>
            <div className="debug-grid">
              {contractCounts ? <CountsTable title="top-level rows" counts={contractCounts} /> : null}
              <SectionSizesTable env={env} />
              <ItemWindowTable env={env} />
              <CountsTable title="source status" counts={sourceHealth?.statusCounts ?? {}} />
              <SourceHealthTable env={env} />
            </div>
          </>
        )}
      </section>

      <section className="debug-section">
        <h3>
          Store {stats ? <span className="count">— {storeLabel(stats.db)}</span> : null}
        </h3>
        {loading ? (
          <p className="muted">Loading store stats…</p>
        ) : !stats ? (
          <p className="empty">Store stats unavailable: no /api/stats endpoint on this deployment, or no store yet (run a sync first).</p>
        ) : (
          <>
            <div className="debug-stat-grid">
              <StatTile label="Store">
                {(stats.db.driver ?? "sqlite").toUpperCase()}
                {stats.db.driver === "postgres" && stats.db.schema ? <span className="muted"> · {stats.db.schema}</span> : null}
              </StatTile>
              <StatTile label="DB size">
                {typeof dbSize === "number" ? formatBytes(dbSize) : "n/a"}
                {typeof walSize === "number" && walSize > 0 ? <span className="muted"> +{formatBytes(walSize)} WAL</span> : null}
              </StatTile>
              <StatTile label="Live items">{stats.items.live.toLocaleString()}</StatTile>
              <StatTile label="Live edges">{stats.edges.live.toLocaleString()}</StatTile>
              <StatTile label="Activities">{stats.activities.total.toLocaleString()}</StatTile>
              <StatTile label="Tombstoned">
                {stats.items.tombstoned.toLocaleString()} <span className="muted">/ {stats.edges.tombstoned.toLocaleString()} edges</span>
              </StatTile>
              <StatTile label="Schema">v{stats.db.schema_version}</StatTile>
            </div>
            <div className="debug-grid">
              <CountsTable title="table rows" counts={stats.tables} />
              <CountsTable title="items by kind" counts={stats.items.by_kind} />
              <CountsTable title="items by state" counts={stats.items.by_state} />
              <CountsTable title="items by source" counts={stats.items.by_source} />
              <CountsTable title="edges by type" counts={stats.edges.by_type} />
              <CountsTable title="edges by lifecycle" counts={stats.edges.by_lifecycle} />
              <CountsTable title="activities by kind" counts={stats.activities.by_kind} />
            </div>
            <p className="muted debug-foot">
              <button type="button" className="toggle" onClick={refresh}>
                Refresh
              </button>{" "}
              generated {relativeTime(stats.generated_at)}
              {stats.activities.earliest
                ? ` · activity ${stats.activities.earliest.slice(0, 10)} → ${(stats.activities.latest ?? "").slice(0, 10)}`
                : ""}
            </p>
          </>
        )}
      </section>

      <section className="debug-section">
        <h3>
          Sync runs {stats && stats.sync_runs.length > 0 ? <span className="count">— last {stats.sync_runs.length}</span> : null}
        </h3>
        {!stats || stats.sync_runs.length === 0 ? (
          <p className="empty">No sync runs recorded.</p>
        ) : (
          <div className="debug-runs-wrap">
            <table className="debug-table">
              <thead>
                <tr>
                  <th>started</th>
                  <th>source</th>
                  <th>mode</th>
                  <th>status</th>
                  <th className="num">items</th>
                  <th className="num">edges</th>
                  <th className="num">activities</th>
                  <th>took</th>
                  <th>error</th>
                </tr>
              </thead>
              <tbody>
                {stats.sync_runs.map((run) => (
                  <tr key={run.run_id}>
                    <td title={run.started_at}>{relativeTime(run.started_at)}</td>
                    <td>{run.source_id}</td>
                    <td>{run.mode}</td>
                    <td>
                      <Badge text={run.status} kind={`status-${run.status}`} />
                    </td>
                    <td className="num">{run.items_seen.toLocaleString()}</td>
                    <td className="num">{run.edges_seen.toLocaleString()}</td>
                    <td className="num">{run.activities_seen.toLocaleString()}</td>
                    <td>{runDuration(run.started_at, run.finished_at)}</td>
                    <td className="debug-run-error">{run.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="debug-section">
        <h3>Daemon log</h3>
        {logs.enabled === null ? (
          <p className="muted">Probing the log endpoint…</p>
        ) : !logs.enabled ? (
          <p className="empty">
            Log tail unavailable on this deployment (writer unreachable, or LOG_CONTROL_ENABLED is off). Container logs:{" "}
            <code>docker compose logs -f board</code>.
          </p>
        ) : (
          <>
            <div className="debug-log-controls">
              <label>
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
              </label>
              <button type="button" className="toggle" onClick={logs.clear}>
                Clear
              </button>
              <span className="muted">in-memory tail of the writer daemon (since its last restart) · polled every 2s</span>
            </div>
            <pre className="debug-log" ref={logRef}>
              {logs.entries.length === 0 ? (
                <span className="muted">No log lines yet.</span>
              ) : (
                logs.entries.map((e) => (
                  <span key={e.seq} className={e.level === "error" ? "log-error" : e.level === "warn" ? "log-warn" : undefined}>
                    {e.ts} {e.level === "info" ? "" : `${e.level.toUpperCase()} `}
                    {e.message}
                    {"\n"}
                  </span>
                ))
              )}
            </pre>
          </>
        )}
      </section>
    </main>
  );
}
