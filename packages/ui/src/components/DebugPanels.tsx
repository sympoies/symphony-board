// The Diagnostics page (DebugPage.tsx) splits into one panel per sub-tab. Each
// panel is a self-contained presentational component fed the data it needs by
// DebugPage, which owns the fetching hooks (useDebug.ts) and the active-tab
// switch. Keeping the panels here leaves DebugPage as a lean orchestrator —
// hooks, the summary strip, the tab bar, and the one-line panel switch — instead
// of one 600-line component with six parallel inline sections.
//
// Panels degrade independently where their backing data is unavailable, and the
// shared presentational primitives (tables, summary metrics) live at the top so
// every panel renders the same shapes.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import type { ContractLoadMetadata } from "../contract.ts";
import { resolveEndpoint } from "../contract.ts";
import {
  contractSectionSizes,
  contractSourceHealth,
  contractTopLevelCounts,
  formatBytes,
  relativeTime,
  resetsIn,
  runDuration,
} from "../model.ts";
import type { TokenRateLimit } from "../model.ts";
import type { DaemonLogsState, LiveSnapshotState, StoreStatsState, TokenRateLimitsState } from "../useDebug.ts";
import { LIVE_EVENT_BUFFER_LIMIT } from "../live-config.ts";
import { DEBUG_TAB_IDS, type DebugTab } from "../nav.ts";
import { Badge } from "./Badge.tsx";

// --- shared presentational primitives --------------------------------------

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

function InlineNote({ children }: { children: ReactNode }) {
  return <span className="muted debug-inline-note">  {children}</span>;
}

// Shared empty-state for the Store and Sync tabs, which both read the single
// /api/stats probe: a null `stats` means the endpoint is absent or the store
// is unseeded, distinct from a present-but-empty result.
function StatsUnavailable({ lead }: { lead: string }) {
  return <p className="empty">{lead}: no /api/stats endpoint on this deployment, or no store yet (run a sync first).</p>;
}

// --- contract metadata formatting (shared by the summary strip + Contract) --

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

function transferSummary(meta: ContractLoadMetadata | null): ReactNode {
  const bytes = meta?.transferBytes ?? meta?.encodedBytes;
  return (
    <>
      {formatOptionalBytes(bytes)}
      {encodingLabel(meta) ? <InlineNote>{encodingLabel(meta)}</InlineNote> : null}
    </>
  );
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

// --- tab bar ---------------------------------------------------------------

// The tab labels live with the rendering; the ids and their display ORDER (Live
// first, which is also the default landing tab) plus the route parsing are the
// pure navigation contract in nav.ts (tested in nav.test.ts).
const DEBUG_TAB_LABELS: Record<DebugTab, string> = {
  live: "Live",
  contract: "Contract",
  store: "Store",
  sync: "Sync runs",
  ratelimit: "Rate limit",
  log: "Daemon log",
};

export function DebugTabs({ active, onTab }: { active: DebugTab; onTab: (tab: DebugTab) => void }) {
  return (
    <nav className="debug-tabs" role="tablist" aria-label="Diagnostics sections">
      {DEBUG_TAB_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          className={`debug-tab${active === id ? " debug-tab-active" : ""}`}
          onClick={() => onTab(id)}
        >
          {DEBUG_TAB_LABELS[id]}
        </button>
      ))}
    </nav>
  );
}

// --- summary strip ---------------------------------------------------------

// The at-a-glance header pinned above the tabs. It only renders with a contract
// loaded (its metrics are contract-derived); the Store metric reflects the same
// /api/stats probe the Store/Sync tabs read.
export function SummaryStrip({
  env,
  contractMeta,
  stats,
  loading,
}: {
  env: ContractEnvelope | null;
  contractMeta: ContractLoadMetadata | null;
  stats: StoreStatsState["stats"];
  loading: boolean;
}) {
  if (!env) return null;
  const sourceHealth = contractSourceHealth(env);
  return (
    <section className="debug-summary-strip" aria-label="Diagnostics summary">
      <SummaryMetric label="Source health">{sourceHealth ? sourceSummary(sourceHealth.statusCounts) : "unknown"}</SummaryMetric>
      <SummaryMetric label="Decoded JSON">{contractMeta ? formatBytes(contractMeta.bytes) : "unknown"}</SummaryMetric>
      <SummaryMetric label="Transfer">{transferSummary(contractMeta)}</SummaryMetric>
      <SummaryMetric label="Compression">{compressionRatio(contractMeta)}</SummaryMetric>
      <SummaryMetric label="Loaded">{contractMeta ? relativeTime(contractMeta.loadedAt) : "unknown"}</SummaryMetric>
      <SummaryMetric label="Store">{stats ? (stats.db.driver ?? "sqlite").toUpperCase() : loading ? "loading" : "unavailable"}</SummaryMetric>
    </section>
  );
}

// --- Contract tab ----------------------------------------------------------

function formatLoadDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`;
}

function sourceLabel(meta: ContractLoadMetadata | null): string {
  if (!meta) return "unknown";
  return meta.source === "file" ? `file: ${meta.url}` : meta.url;
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
    ["activity targets", (itemWindow.activity_target_items ?? 0).toLocaleString()],
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

function ContractDetail({ env, contractMeta }: { env: ContractEnvelope; contractMeta: ContractLoadMetadata | null }) {
  const contractCounts = contractTopLevelCounts(env);
  const itemWindow = env.item_window;
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
  const contractRows = [
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
  ];
  return (
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
  );
}

export function ContractPanel({ env, contractMeta }: { env: ContractEnvelope | null; contractMeta: ContractLoadMetadata | null }) {
  return (
    <section className="debug-section">
      <h3>Contract payload</h3>
      {!env ? <p className="empty">No contract loaded.</p> : <ContractDetail env={env} contractMeta={contractMeta} />}
    </section>
  );
}

// --- Store tab -------------------------------------------------------------

function storeLabel(db: { driver?: string; path?: string; database?: string; schema?: string }): string {
  if (db.driver === "postgres") return db.schema ? `${db.database ?? "postgres"} / ${db.schema}` : (db.database ?? "postgres");
  return db.path ?? db.driver ?? "store";
}

export function StorePanel({ stats, loading }: Pick<StoreStatsState, "stats" | "loading">) {
  const dbSize = stats?.db.size_bytes;
  const walSize = stats?.db.wal_size_bytes;
  return (
    <section className="debug-section">
      <h3>
        Store {stats ? <span className="count">— {storeLabel(stats.db)}</span> : null}
      </h3>
      {loading ? (
        <p className="muted">Loading store stats…</p>
      ) : !stats ? (
        <StatsUnavailable lead="Store stats unavailable" />
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
            generated {relativeTime(stats.generated_at)}
            {stats.activities.earliest
              ? ` activity ${stats.activities.earliest.slice(0, 10)} → ${(stats.activities.latest ?? "").slice(0, 10)}`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}

// --- Live tab --------------------------------------------------------------

export function LivePanel({ live, serverBaseUrl }: { live: LiveSnapshotState; serverBaseUrl: string | null }) {
  return (
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
            snapshot {live.info.generatedAt ? relativeTime(live.info.generatedAt) : "—"} ·{" "}
            <code>{resolveEndpoint("./api/live-snapshot", serverBaseUrl)}</code>
          </p>
        </>
      )}
    </section>
  );
}

// --- Sync runs tab ---------------------------------------------------------

export function SyncPanel({ stats, loading }: Pick<StoreStatsState, "stats" | "loading">) {
  return (
    <section className="debug-section debug-section-fill">
      <h3>
        Sync runs {stats && stats.sync_runs.length > 0 ? <span className="count">— last {stats.sync_runs.length}</span> : null}
      </h3>
      {loading ? (
        <p className="muted">Loading sync runs…</p>
      ) : !stats ? (
        <StatsUnavailable lead="Sync history unavailable" />
      ) : stats.sync_runs.length === 0 ? (
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
  );
}

// --- Rate limit tab --------------------------------------------------------

export function RateLimitPanel({ tokenRates }: { tokenRates: TokenRateLimitsState }) {
  return (
    <section className="debug-section">
      <h3>
        Rate limit
        {tokenRates.info && tokenRates.info.tokens.length > 0 ? (
          <span className="count">
            {" "}
            — {tokenRates.info.tokens.length} token{tokenRates.info.tokens.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </h3>
      {tokenRates.loading ? (
        <p className="muted">Probing each GitHub token's GraphQL budget…</p>
      ) : !tokenRates.info ? (
        <p className="empty">
          Token rate limits unavailable: no <code>/api/token-rate-limits</code> on this deployment (a static read-only
          board, or a build without the probe).
        </p>
      ) : tokenRates.info.error ? (
        <p className="empty">Config error: {tokenRates.info.error}</p>
      ) : tokenRates.info.tokens.length === 0 ? (
        <p className="empty">No GitHub tokens configured to probe.</p>
      ) : (
        <>
          <div className="debug-runs-wrap">
            <table className="debug-table">
              <thead>
                <tr>
                  <th>source</th>
                  <th>type</th>
                  <th>name</th>
                  <th>strategy</th>
                  <th>token (env)</th>
                  <th className="num">remaining</th>
                  <th className="num">used</th>
                  <th>resets</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {tokenRates.info.tokens.map((t: TokenRateLimit) => (
                  <tr key={`${t.source_id}|${t.env}`}>
                    <td>{t.source_display}</td>
                    <td>{t.kind === "github_app" ? "bot" : "PAT"}</td>
                    <td>{t.name ?? (t.kind === "github_app" ? "GitHub App" : "—")}</td>
                    <td>{t.strategy === "budget_aware" || t.strategy === "round_robin" ? "budget aware" : "failover"}</td>
                    <td>
                      <code>{t.env}</code>
                    </td>
                    <td className="num">
                      {t.ok && t.remaining != null ? `${t.remaining.toLocaleString()} / ${(t.limit ?? 0).toLocaleString()}` : "—"}
                    </td>
                    <td className="num">{t.ok && t.used != null ? t.used.toLocaleString() : "—"}</td>
                    <td title={t.reset_at}>{t.ok ? resetsIn(t.reset_at) : "—"}</td>
                    <td className="debug-run-error">
                      {t.ok ? (
                        <Badge text="ok" kind="status-ok" />
                      ) : (
                        <>
                          <Badge text="error" kind="status-error" /> <span title={t.error}>{t.error}</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted debug-foot">
            probed {tokenRates.info.generated_at ? relativeTime(tokenRates.info.generated_at) : "—"} · one lightweight GraphQL
            probe per token (does not meaningfully spend the budget it reports)
          </p>
        </>
      )}
    </section>
  );
}

// --- Daemon log tab --------------------------------------------------------

// The log view owns its own scroll state: the "follow" toggle and the tail
// element ref are entirely local to this panel, so they live here rather than in
// DebugPage. Tail behavior: keep the newest line in view while "follow" is on;
// turning it off freezes the scroll position for reading while lines keep
// arriving (the daemon-log hook keeps polling at the page level).
export function LogPanel({ logs }: { logs: DaemonLogsState }) {
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.entries, follow]);

  return (
    <section className="debug-section debug-section-fill">
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
  );
}
