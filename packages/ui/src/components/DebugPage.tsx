// The hidden Diagnostics page (#/debug, toggled with Cmd+/ / Ctrl+/). Not in
// the page-tabs nav on purpose: it is an operator surface, not a product page.
// Three sections, each degrading independently to "unavailable":
//   • Store — sizes, row counts, and breakdowns from GET /api/stats
//   • Sync runs — the recent sync_run history (status / totals / error)
//   • Daemon log — the writer's in-memory recent-log tail from GET /api/logs
// Unlike every other page it does its own fetching (useDebug.ts): no other
// page shares this data, and it must render with no contract loaded — that is
// exactly when it is needed.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import { formatBytes, relativeTime, runDuration } from "../model.ts";
import { useStoreStats, useDaemonLogs } from "../useDebug.ts";
import { Badge } from "./Badge.tsx";

interface Props {
  serverBaseUrl: string | null;
  env: ContractEnvelope | null;
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

function StatTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="debug-stat-tile">
      <span className="stat-label">{label}</span>
      <b>{children}</b>
    </div>
  );
}

export function DebugPage({ serverBaseUrl, env, onClose }: Props) {
  const { stats, loading, refresh } = useStoreStats(serverBaseUrl);
  const logs = useDaemonLogs(serverBaseUrl);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement | null>(null);

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

      <p className="muted">
        {env
          ? `Contract ${env.contract_version} · generated ${relativeTime(env.generated_at)} · ` +
            `${env.items.length.toLocaleString()} items · ${env.edges.length.toLocaleString()} edges · ` +
            `${(env.activities?.length ?? 0).toLocaleString()} activities`
          : "No contract loaded."}
      </p>

      <section className="debug-section">
        <h3>
          Store {stats ? <span className="count">— {stats.db.path}</span> : null}
        </h3>
        {loading ? (
          <p className="muted">Loading store stats…</p>
        ) : !stats ? (
          <p className="empty">Store stats unavailable: no /api/stats endpoint on this deployment, or no store yet (run a sync first).</p>
        ) : (
          <>
            <div className="debug-stat-grid">
              <StatTile label="DB size">
                {formatBytes(stats.db.size_bytes)}
                {stats.db.wal_size_bytes > 0 ? <span className="muted"> +{formatBytes(stats.db.wal_size_bytes)} WAL</span> : null}
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
