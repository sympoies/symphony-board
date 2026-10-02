import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ContractEnvelope } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { relativeTime, headerSyncState, isSyncRunActive, liveSourceStatus, syncRunSummary, visibleHeaderSources } from "../model.ts";
import { NARROW_VIEWPORT_QUERY } from "../layout-tier.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import type { SyncState } from "../useSync.ts";
import { standaloneBrandClass } from "../viewconfig.ts";

const NO_HIDDEN_SOURCES: ReadonlySet<string> = new Set();

function AppMarkIcon() {
  return (
    <svg className="brand-refresh-app-icon" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <rect className="app-mark-bg" x="0" y="0" width="1024" height="1024" rx="240" ry="240" />
      <g className="app-mark-bars">
        <rect x="134" y="414" width="92" height="196" rx="46" />
        <rect x="280" y="299" width="116" height="426" rx="58" />
        <rect x="450" y="212" width="124" height="600" rx="62" />
        <rect x="628" y="299" width="116" height="426" rx="58" />
        <rect x="798" y="414" width="92" height="196" rx="46" />
      </g>
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="brand-refresh-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 11a8 8 0 0 0-14.7-4.4L3 9" />
      <path d="M3 4v5h5" />
      <path d="M4 13a8 8 0 0 0 14.7 4.4L21 15" />
      <path d="M16 15h5v5" />
    </svg>
  );
}

export function BrandHeader() {
  return (
    <header className={`app-header app-header-brand-only${standaloneBrandClass()}`}>
      <div className="brand">
        <div className="brand-main">
          <span className="brand-refresh brand-mark-static" aria-hidden="true">
            <AppMarkIcon />
          </span>
          <h1>Symphony Board</h1>
        </div>
      </div>
    </header>
  );
}

// Title + contract provenance + per-source health, so a viewer can immediately
// see whether the data is fresh and whether any source last synced partial/error.
// When the writer-owned control surface is available, the manual Sync action sits
// beside the source health on the same row (a fixed gap, independent of the
// status text width), and the run status drops onto its own row below.
export function Header({
  env,
  sync,
  hiddenSources = NO_HIDDEN_SOURCES,
  refreshing = false,
  onRefresh,
}: {
  env: ContractEnvelope;
  sync?: SyncState;
  hiddenSources?: ReadonlySet<string>;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const showSync = sync?.available ?? false;
  const running = showSync && isSyncRunActive(sync!.current);
  const summary = showSync ? (sync!.error ?? syncRunSummary(running ? sync!.current : sync!.last)) : "";
  const sources = visibleHeaderSources(env.sources, hiddenSources);
  // While a run is in flight the chip badge shows that run's live state for this
  // source (syncing / fresh outcome); otherwise the contract's last status. The
  // reloaded contract takes over after the run, so the overlay never outlives the
  // run it narrates.
  const statusOf = (sourceId: string, last: string | null) => (showSync ? liveSourceStatus(sync!.current, sourceId) : null) ?? last ?? "unknown";
  const chips = (
    <div className="sources">
      {sources.map((s) => {
        const status = statusOf(s.source_id, s.last_status);
        return (
          <span key={s.source_id} className="source-chip" title={`${s.kind} @ ${s.host}`}>
            <Badge text={status} kind={`status-${status}`} />
            <span className="source-name">{s.display_name ?? s.source_id}</span>
            <span className="muted" title="last successful sync">{relativeTime(s.last_success_at)}</span>
          </span>
        );
      })}
    </div>
  );
  const syncButton = showSync ? (
    <button
      type="button"
      className={`toggle sync-button${running ? " sync-running" : ""}`}
      disabled={!sync!.enabled || running || sync!.busy}
      title={
        sync!.enabled
          ? "Run an incremental sync of every source, then reload the contract"
          : "Manual sync is not enabled on this deployment"
      }
      onClick={() => sync!.start({ mode: "incremental", dry_run: false, source_id: null })}
    >
      {running ? "Syncing" : "Sync"}
    </button>
  ) : null;
  const statusLine =
    showSync && summary ? (
      <span className={`sync-status muted${sync!.error ? " sync-error" : ""}`} role="status">
        {summary}
      </span>
    ) : null;
  const refreshButton = (
    <button
      type="button"
      className={`brand-refresh${refreshing ? " refreshing" : ""}`}
      disabled={refreshing}
      aria-label="Refresh data"
      aria-busy={refreshing}
      title="Refresh data"
      onClick={onRefresh}
    >
      {refreshing ? <RefreshIcon /> : <AppMarkIcon />}
    </button>
  );
  if (narrow) {
    return (
      <header className={`app-header app-header-narrow${standaloneBrandClass()}`}>
        <div className="brand">
          <div className="brand-main">
            {refreshButton}
            <h1>Symphony Board</h1>
          </div>
        </div>
        <SyncPopover state={headerSyncState(sources.map((s) => statusOf(s.source_id, s.last_status)), running, showSync && (sync!.error != null || (!running && sync!.last?.status === "error")))}>
          {chips}
          {syncButton}
          {statusLine}
        </SyncPopover>
      </header>
    );
  }
  return (
    <header className={`app-header${standaloneBrandClass()}`}>
      <div className="brand">
        <div className="brand-main">
          {refreshButton}
          <h1>Symphony Board</h1>
        </div>
        <span className="muted">
          contract {env.contract_version} · {env.generator} · emitted {relativeTime(env.generated_at)}
        </span>
      </div>
      <div className="header-aside">
        <div className="header-aside-row">
          {chips}
          {syncButton}
        </div>
        {statusLine}
      </div>
    </header>
  );
}

// Narrow tier: one status button (state dot + label) in the header row; the
// per-source chips, the Sync action, and the run line open from it. Closes on an
// outside press and on Escape, so it never lingers over the page below.
function SyncPopover({ state, children }: { state: { label: string; tone: string }; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onPress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="sync-popover-root" ref={rootRef}>
      <button
        type="button"
        className={`toggle sync-popover-toggle sync-popover-${state.tone}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sync-popover-dot" aria-hidden="true" />
        {state.label}
      </button>
      {open ? (
        <div id={panelId} className="sync-popover" role="group" aria-label="Sync status">
          {children}
        </div>
      ) : null}
    </div>
  );
}
