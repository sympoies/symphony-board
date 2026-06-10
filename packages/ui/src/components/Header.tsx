import type { ContractEnvelope } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { relativeTime, isSyncRunActive, liveSourceStatus, syncRunSummary } from "../model.ts";
import type { SyncState } from "../useSync.ts";

// Title + contract provenance + per-source health, so a viewer can immediately
// see whether the data is fresh and whether any source last synced partial/error.
// When the writer-owned control surface is available, the manual Sync action sits
// beside the source health on the same row (a fixed gap, independent of the
// status text width), and the run status drops onto its own row below.
export function Header({ env, sync }: { env: ContractEnvelope; sync?: SyncState }) {
  const showSync = sync?.available ?? false;
  const running = showSync && isSyncRunActive(sync!.current);
  const summary = showSync ? (sync!.error ?? syncRunSummary(running ? sync!.current : sync!.last)) : "";
  return (
    <header className="app-header">
      <div className="brand">
        <h1>symphony-board</h1>
        <span className="muted">
          contract {env.contract_version} · {env.generator} · emitted {relativeTime(env.generated_at)}
        </span>
      </div>
      <div className="header-aside">
        <div className="header-aside-row">
          <div className="sources">
            {env.sources.map((s) => {
              // While a run is in flight the chip badge shows that run's live
              // state for this source (syncing… / fresh outcome); otherwise the
              // contract's last status. The reloaded contract takes over after
              // the run, so the overlay never outlives the run it narrates.
              const live = showSync ? liveSourceStatus(sync!.current, s.source_id) : null;
              const status = live ?? s.last_status ?? "unknown";
              return (
                <span key={s.source_id} className="source-chip" title={`${s.kind} @ ${s.host}`}>
                  <Badge text={status === "syncing" ? "syncing…" : status} kind={`status-${status}`} />
                  <span className="source-name">{s.display_name ?? s.source_id}</span>
                  <span className="muted" title="last successful sync">{relativeTime(s.last_success_at)}</span>
                </span>
              );
            })}
          </div>
          {showSync ? (
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
              {running ? "Syncing…" : "Sync"}
            </button>
          ) : null}
        </div>
        {showSync && summary ? (
          <span className={`sync-status muted${sync!.error ? " sync-error" : ""}`} role="status">
            {summary}
          </span>
        ) : null}
      </div>
    </header>
  );
}
