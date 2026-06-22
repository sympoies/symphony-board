// The hidden Diagnostics page (#/debug, toggled with Cmd+/ / Ctrl+/). Not in
// the page-tabs nav on purpose: it is an operator surface, not a product page.
// The page holds several distinct diagnostics surfaces, so they are split into
// sub-tabs (URL-backed through the shared `tab` route field, like Settings)
// instead of one long scroll. Each tab is its own panel component in
// DebugPanels.tsx; this module is the orchestrator that owns the fetching hooks
// and renders the active panel:
//   • Live — the live receiver snapshot (buffer / cursor / category mix)
//   • Contract — loaded contract size, shape, windowing, source health
//   • Store — sizes, row counts, and breakdowns from GET /api/stats
//   • Sync runs — the recent sync_run history (status / totals / error)
//   • Rate limit — each GitHub token's GraphQL budget (on-demand probe)
//   • Daemon log — the writer's in-memory recent-log tail from GET /api/logs
// The summary strip stays pinned above the tabs as an at-a-glance header. Unlike
// every other page it does its own fetching (useDebug.ts): no other page shares
// this data, and it must render with no contract loaded — that is exactly when it
// is needed, so the tab bar stays reachable even then.

import { useEffect, useRef, useState } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import type { ContractLoadMetadata } from "../contract.ts";
import { useStoreStats, useDaemonLogs, useLiveSnapshotInfo, useTokenRateLimits } from "../useDebug.ts";
import { type DebugTab } from "../nav.ts";
import {
  ContractPanel,
  DebugTabs,
  LivePanel,
  LogPanel,
  RateLimitPanel,
  StorePanel,
  SummaryStrip,
  SyncPanel,
} from "./DebugPanels.tsx";

interface Props {
  serverBaseUrl: string | null;
  env: ContractEnvelope | null;
  contractMeta: ContractLoadMetadata | null;
  tab: DebugTab;
  onTab: (tab: DebugTab) => void;
  onRefreshData: () => Promise<boolean>;
  onClose: () => void;
}

export function DebugPage({ serverBaseUrl, env, contractMeta, tab, onTab, onRefreshData, onClose }: Props) {
  const { stats, loading, refresh } = useStoreStats(serverBaseUrl);
  const live = useLiveSnapshotInfo(serverBaseUrl);
  const logs = useDaemonLogs(serverBaseUrl);
  // On-demand: probes the provider only while its tab is active (see useDebug).
  const tokenRates = useTokenRateLimits(serverBaseUrl, tab === "ratelimit");
  const [refreshingDiagnostics, setRefreshingDiagnostics] = useState(false);
  const observedContractLoadRef = useRef(contractMeta?.loadedAt ?? null);

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

      <SummaryStrip env={env} contractMeta={contractMeta} stats={stats} loading={loading} />

      <DebugTabs active={tab} onTab={onTab} />

      {tab === "contract" ? <ContractPanel env={env} contractMeta={contractMeta} /> : null}
      {tab === "store" ? <StorePanel stats={stats} loading={loading} refresh={refresh} /> : null}
      {tab === "live" ? <LivePanel live={live} serverBaseUrl={serverBaseUrl} /> : null}
      {tab === "sync" ? <SyncPanel stats={stats} loading={loading} /> : null}
      {tab === "ratelimit" ? <RateLimitPanel tokenRates={tokenRates} /> : null}
      {tab === "log" ? <LogPanel logs={logs} /> : null}
    </main>
  );
}
