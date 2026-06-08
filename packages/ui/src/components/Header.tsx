import type { ContractEnvelope } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { relativeTime, isSyncRunActive, syncRunSummary } from "../model.ts";
import type { SyncState } from "../useSync.ts";

// The compact Header sync affordance: the default manual action (an incremental
// sync of every source) plus a one-line status. Advanced options (full sweep,
// dry-run, source scope) live on the Settings page. The control renders only when
// the daemon's control surface is available; when it is present but manual runs
// are disabled by config, the button shows disabled rather than vanishing.
function SyncControl({ sync }: { sync: SyncState }) {
  if (!sync.available) return null;
  const running = isSyncRunActive(sync.current);
  const summary = sync.error ?? syncRunSummary(running ? sync.current : sync.last);
  const title = sync.enabled
    ? "Run an incremental sync of every source, then reload the contract"
    : "Manual sync is not enabled on this deployment";
  return (
    <div className={`sync-control${running ? " sync-running" : ""}${sync.error ? " sync-error" : ""}`}>
      <button
        type="button"
        className="toggle sync-button"
        disabled={!sync.enabled || running || sync.busy}
        title={title}
        onClick={() => sync.start({ mode: "incremental", dry_run: false, source_id: null })}
      >
        {running ? "Syncing…" : "Sync"}
      </button>
      {summary ? (
        <span className="sync-status muted" role="status">
          {summary}
        </span>
      ) : null}
    </div>
  );
}

// Title + contract provenance + per-source health, so a viewer can immediately
// see whether the data is fresh and whether any source last synced partial/error.
// When the writer-owned control surface is available it also exposes the manual
// Sync action beside the source health.
export function Header({ env, sync }: { env: ContractEnvelope; sync?: SyncState }) {
  return (
    <header className="app-header">
      <div className="brand">
        <h1>symphony-board</h1>
        <span className="muted">
          contract {env.contract_version} · {env.generator} · emitted {relativeTime(env.generated_at)}
        </span>
      </div>
      <div className="sources">
        {env.sources.map((s) => (
          <span key={s.source_id} className="source-chip" title={`${s.kind} @ ${s.host}`}>
            <Badge text={s.last_status ?? "unknown"} kind={`status-${s.last_status ?? "unknown"}`} />
            <span className="source-name">{s.display_name ?? s.source_id}</span>
            <span className="muted">ok {relativeTime(s.last_success_at)}</span>
          </span>
        ))}
      </div>
      {sync ? <SyncControl sync={sync} /> : null}
    </header>
  );
}
