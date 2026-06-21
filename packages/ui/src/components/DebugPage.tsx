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

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import type { ContractLoadMetadata } from "../contract.ts";
import { contractSectionSizes, contractSourceHealth, contractTopLevelCounts, formatBytes, relativeTime, runDuration } from "../model.ts";
import { useStoreStats, useDaemonLogs, useLiveSnapshotInfo } from "../useDebug.ts";
import { resolveEndpoint } from "../contract.ts";
import { LIVE_EVENT_BUFFER_LIMIT } from "../live-config.ts";
import { Badge } from "./Badge.tsx";

interface Props {
  serverBaseUrl: string | null;
  env: ContractEnvelope | null;
  contractMeta: ContractLoadMetadata | null;
  onRefreshData: () => Promise<boolean>;
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

function SummaryMetric({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="debug-summary-metric">
      <span className="debug-summary-label">{label}</span>
      <b className="debug-summary-value" title={title}>
        {children}
      </b>
    </div>
  );
}

function DetailTable({ title, rows }: { title: string; rows: Array<{ label: string; value: ReactNode; title?: string }> }) {
  return (
    <div className="debug-card">
      <table className="debug-table">
        <thead>
          <tr>
            <th>{title}</th>
            <th>value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="debug-value-cell" title={row.title}>
                {row.value}
              </td>
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

function formatOptionalBytes(n: number | null | undefined): string {
  return typeof n === "number" ? formatBytes(n) : "unknown";
}

function compressionRatio(meta: ContractLoadMetadata | null): string {
  if (!meta || !meta.encodedBytes || meta.encodedBytes <= 0 || meta.bytes <= 0) return "unknown";
  return `${(meta.bytes / meta.encodedBytes).toFixed(1)}x`;
}

function encodingLabel(meta: ContractLoadMetadata | null): string | null {
  if (!meta) return null;
  if (meta.contentEncoding) return meta.contentEncoding;
  return meta.encodedBytes == null ? null : "identity";
}

function sourceLabel(meta: ContractLoadMetadata | null): string {
  if (!meta) return "unknown";
  return meta.source === "file" ? `file: ${meta.url}` : meta.url;
}

function InlineNote({ children }: { children: ReactNode }) {
  return <span className="muted debug-inline-note">  {children}</span>;
}

function sourceSummary(counts: Record<string, number>): ReactNode {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const detail = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n.toLocaleString()} ${status}`)
    .join(" ");
  const okCount = counts.ok ?? 0;
  const state =
    total === 0
      ? { text: "none", kind: "status-unknown" }
      : okCount === total
        ? { text: "ok", kind: "status-ok" }
        : okCount === 0
          ? { text: "down", kind: "status-error" }
          : { text: "degraded", kind: "status-partial" };
  return (
    <span className="debug-summary-health">
      <span>
        {total.toLocaleString()} {total === 1 ? "source" : "sources"}
      </span>
      <Badge text={state.text} kind={state.kind} title={detail || state.text} />
    </span>
  );
}

function transferSummary(meta: ContractLoadMetadata | null): ReactNode {
  const bytes = meta?.transferBytes ?? meta?.encodedBytes;
  return (
    <>
      {formatOptionalBytes(bytes)}
      {encodingLabel(meta) ? <InlineNote>{encodingLabel(meta)}</InlineNote> : null}
    </>
  );
}

function transferTotal(meta: ContractLoadMetadata | null): ReactNode {
  if (meta?.transferBytes != null) return formatBytes(meta.transferBytes);
  if (meta?.encodedBytes != null) {
    return (
      <>
        {formatBytes(meta.encodedBytes)}
        <InlineNote>body</InlineNote>
      </>
    );
  }
  return "unknown";
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

export function DebugPage({ serverBaseUrl, env, contractMeta, onRefreshData, onClose }: Props) {
  const { stats, loading, refresh } = useStoreStats(serverBaseUrl);
  const live = useLiveSnapshotInfo(serverBaseUrl);
  const logs = useDaemonLogs(serverBaseUrl);
  const [follow, setFollow] = useState(true);
  const [refreshingDiagnostics, setRefreshingDiagnostics] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const observedContractLoadRef = useRef(contractMeta?.loadedAt ?? null);
  const dbSize = stats?.db.size_bytes;
  const walSize = stats?.db.wal_size_bytes;
  const contractCounts = env ? contractTopLevelCounts(env) : null;
  const sourceHealth = env ? contractSourceHealth(env) : null;
  const itemWindow = env?.item_window;
  const encodedLabel = encodingLabel(contractMeta);
  const payloadRows = [
    { label: "decoded json", value: contractMeta ? formatBytes(contractMeta.bytes) : "unknown" },
    {
      label: "compressed payload",
      value: (
        <>
          {formatOptionalBytes(contractMeta?.encodedBytes)}
          {encodedLabel ? <InlineNote>{encodedLabel}</InlineNote> : null}
        </>
      ),
    },
    { label: "transfer total", value: transferTotal(contractMeta) },
    { label: "compression", value: compressionRatio(contractMeta) },
    { label: "load time", value: contractMeta ? formatLoadDuration(contractMeta.durationMs) : "unknown" },
    {
      label: "source url",
      value: (
        <span className="debug-value-text" title={contractMeta?.url ?? undefined}>
          {sourceLabel(contractMeta)}
        </span>
      ),
      title: contractMeta?.url,
    },
  ];
  const contractRows = env
    ? [
        { label: "generated", value: relativeTime(env.generated_at), title: env.generated_at },
        { label: "loaded", value: contractMeta ? relativeTime(contractMeta.loadedAt) : "unknown", title: contractMeta?.loadedAt },
        { label: "contract", value: `v${env.contract_version}` },
        {
          label: "generator",
          value: (
            <span className="debug-value-text" title={env.generator}>
              {env.generator}
            </span>
          ),
          title: env.generator,
        },
        { label: "timezone", value: env.timezone ?? "UTC" },
        { label: "windowed", value: itemWindow ? (itemWindow.truncated ? "truncated" : "complete") : "unknown" },
      ]
    : [];

  // Tail behavior: keep the newest line in view while "follow" is on; turning
  // it off freezes the scroll position for reading while lines keep arriving.
  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.entries, follow]);

  // The log tail polls independently, but the payload/store surfaces are tied
  // to contract loads. When a manual refresh or sync reloads the contract while
  // Diagnostics is open, refresh the store stats once. No periodic polling.
  useEffect(() => {
    const loadedAt = contractMeta?.loadedAt ?? null;
    if (!loadedAt || observedContractLoadRef.current === loadedAt) return;
    observedContractLoadRef.current = loadedAt;
    refresh();
  }, [contractMeta?.loadedAt, refresh]);

  const refreshDiagnostics = async () => {
    if (refreshingDiagnostics) return;
    setRefreshingDiagnostics(true);
    let loadedContract = false;
    try {
      loadedContract = await onRefreshData();
    } finally {
      if (!loadedContract) refresh();
      setRefreshingDiagnostics(false);
    }
  };

  return (
    <main className="debug-page">
      <div className="debug-head">
        <h2>Diagnostics</h2>
        <span className="muted">hidden page — toggle with ⌘/ (Ctrl+/)</span>
        <button type="button" className="toggle" onClick={refreshDiagnostics} disabled={refreshingDiagnostics}>
          {refreshingDiagnostics ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" className="toggle debug-close" onClick={onClose}>
          Close
        </button>
      </div>

      {env ? (
        <section className="debug-summary-strip" aria-label="Diagnostics summary">
          <SummaryMetric label="Source health">{sourceHealth ? sourceSummary(sourceHealth.statusCounts) : "unknown"}</SummaryMetric>
          <SummaryMetric label="Decoded JSON">{contractMeta ? formatBytes(contractMeta.bytes) : "unknown"}</SummaryMetric>
          <SummaryMetric label="Transfer">{transferSummary(contractMeta)}</SummaryMetric>
          <SummaryMetric label="Compression">{compressionRatio(contractMeta)}</SummaryMetric>
          <SummaryMetric label="Loaded">{contractMeta ? relativeTime(contractMeta.loadedAt) : "unknown"}</SummaryMetric>
          <SummaryMetric label="Store">{stats ? (stats.db.driver ?? "sqlite").toUpperCase() : loading ? "loading" : "unavailable"}</SummaryMetric>
        </section>
      ) : null}

      <section className="debug-section">
        <h3>Contract payload</h3>
        {!env ? (
          <p className="empty">No contract loaded.</p>
        ) : (
          <>
            <div className="debug-detail-grid debug-detail-grid-primary">
              <DetailTable title="payload transfer" rows={payloadRows} />
              <DetailTable title="contract metadata" rows={contractRows} />
              <div className="debug-card debug-card-wide">
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
            </div>
            <div className="debug-subsection">
              <h4>Contract shape</h4>
              <div className="debug-grid">
                {contractCounts ? <CountsTable title="top-level rows" counts={contractCounts} /> : null}
                <SectionSizesTable env={env} />
                <ItemWindowTable env={env} />
              </div>
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
            <section className="debug-summary-strip debug-section-summary" aria-label="Store summary">
              <SummaryMetric label="Store">
                {(stats.db.driver ?? "sqlite").toUpperCase()}
                {stats.db.driver === "postgres" && stats.db.schema ? <InlineNote>{stats.db.schema}</InlineNote> : null}
              </SummaryMetric>
              <SummaryMetric label="DB size">
                {typeof dbSize === "number" ? formatBytes(dbSize) : "n/a"}
                {typeof walSize === "number" && walSize > 0 ? <span className="muted"> +{formatBytes(walSize)} WAL</span> : null}
              </SummaryMetric>
              <SummaryMetric label="Live items">{stats.items.live.toLocaleString()}</SummaryMetric>
              <SummaryMetric label="Live edges">{stats.edges.live.toLocaleString()}</SummaryMetric>
              <SummaryMetric label="Activities">{stats.activities.total.toLocaleString()}</SummaryMetric>
              <SummaryMetric label="Tombstoned">
                {stats.items.tombstoned.toLocaleString()} <span className="muted">/ {stats.edges.tombstoned.toLocaleString()} edges</span>
              </SummaryMetric>
              <SummaryMetric label="Schema">v{stats.db.schema_version}</SummaryMetric>
            </section>
            <div className="debug-subsection">
              <h4>Store breakdown</h4>
              <div className="debug-grid">
                <CountsTable title="table rows" counts={stats.tables} />
                <CountsTable title="items by kind" counts={stats.items.by_kind} />
                <CountsTable title="items by state" counts={stats.items.by_state} />
                <CountsTable title="items by source" counts={stats.items.by_source} />
                <CountsTable title="edges by type" counts={stats.edges.by_type} />
                <CountsTable title="edges by lifecycle" counts={stats.edges.by_lifecycle} />
                <CountsTable title="activities by kind" counts={stats.activities.by_kind} />
              </div>
            </div>
            <p className="muted debug-foot">
              <button type="button" className="toggle" onClick={refresh}>
                Refresh
              </button>{" "}
              generated {relativeTime(stats.generated_at)}
              {stats.activities.earliest
                ? ` activity ${stats.activities.earliest.slice(0, 10)} → ${(stats.activities.latest ?? "").slice(0, 10)}`
                : ""}
            </p>
          </>
        )}
      </section>

      <section className="debug-section">
        <h3>
          Live receiver{" "}
          {live.info.available === true ? (
            <span className="count">— reachable</span>
          ) : live.info.available === false ? (
            <span className="count">— offline</span>
          ) : null}
        </h3>
        {live.loading ? (
          <p className="muted">Probing the live receiver…</p>
        ) : live.info.available === false ? (
          <p className="empty">
            Live receiver unreachable: no <code>/api/live-snapshot</code> on this deployment (e.g. the
            standalone app, which has no receiver).
          </p>
        ) : (
          <>
            <section className="debug-summary-strip debug-section-summary" aria-label="Live receiver summary">
              <SummaryMetric label="Buffer">
                {live.info.events.toLocaleString()} <span className="muted">/ {LIVE_EVENT_BUFFER_LIMIT}</span>
              </SummaryMetric>
              <SummaryMetric label="Cursor (max seq)">{live.info.maxSeq?.toLocaleString() ?? "n/a"}</SummaryMetric>
              <SummaryMetric label="Active repos">{live.info.repos.toLocaleString()}</SummaryMetric>
              <SummaryMetric label="Active people">{live.info.people.toLocaleString()}</SummaryMetric>
              <SummaryMetric label="Newest event">{live.info.newestAt ? relativeTime(live.info.newestAt) : "—"}</SummaryMetric>
            </section>
            <div className="debug-subsection">
              <h4>Live breakdown</h4>
              <div className="debug-grid">
                <CountsTable
                  title="events by category"
                  counts={Object.fromEntries(live.info.categories.map((c) => [c.category, c.count]))}
                />
              </div>
            </div>
            <p className="muted debug-foot">
              <button type="button" className="toggle" onClick={live.refresh}>
                Refresh
              </button>{" "}
              snapshot {live.info.generatedAt ? relativeTime(live.info.generatedAt) : "—"} ·{" "}
              <code>{resolveEndpoint("./api/live-snapshot", serverBaseUrl)}</code>
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
              <span className="muted">in-memory tail of the writer daemon (since its last restart) polled every 2s</span>
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
