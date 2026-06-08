import { useState } from "react";
import { isSyncRunActive, syncRunSummary, type SyncMode } from "../model.ts";
import type { SyncState } from "../useSync.ts";

// The advanced manual-sync controls on the Settings page: pick the mode (default
// incremental), optionally a single source, and dry-run, then run. The Header
// owns the common one-click incremental path; this is the explicit, less-noisy
// surface for full sweeps, connectivity dry-runs, and source-scoped runs. Status
// copy distinguishes running / dry-run / reloaded / error so a dry-run never
// reads as if it refreshed the board data.
export function SyncControls({ sync }: { sync: SyncState }) {
  const [mode, setMode] = useState<SyncMode>("incremental");
  const [dryRun, setDryRun] = useState(false);
  const [sourceId, setSourceId] = useState<string>("");

  const running = isSyncRunActive(sync.current);
  const disabled = !sync.enabled || running || sync.busy;
  const summary = sync.error ?? syncRunSummary(running ? sync.current : sync.last);

  return (
    <div className="settings-pref settings-sync">
      <div>
        <h3>Manual sync</h3>
        <p className="muted">
          Trigger a real provider sync from the UI instead of waiting for the background loop. A successful run reloads
          the contract in place. A dry-run exercises providers without writing the store.
          {sync.enabled ? null : " Manual sync is disabled on this deployment."}
        </p>
      </div>
      <div className="sync-advanced">
        <label className="sync-field">
          <span className="muted">Mode</span>
          <select className="settings-select sync-mode" value={mode} disabled={disabled} onChange={(e) => setMode(e.target.value === "full" ? "full" : "incremental")}>
            <option value="incremental">incremental</option>
            <option value="full">full sweep</option>
          </select>
        </label>
        <label className="sync-field">
          <span className="muted">Source</span>
          <select className="settings-select sync-source" value={sourceId} disabled={disabled} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">all sources</option>
            {sync.sources.map((s) => (
              <option key={s.source_id} value={s.source_id}>
                {s.display_name ?? s.source_id}
              </option>
            ))}
          </select>
        </label>
        <label className="sync-field sync-dry-run">
          <input type="checkbox" checked={dryRun} disabled={disabled} onChange={(e) => setDryRun(e.target.checked)} />
          <span>Dry-run</span>
        </label>
        <button
          type="button"
          className="toggle sync-run-button"
          disabled={disabled}
          onClick={() => sync.start({ mode, dry_run: dryRun, source_id: sourceId === "" ? null : sourceId })}
        >
          {running ? "Syncing…" : "Run sync"}
        </button>
      </div>
      {summary ? (
        <p className={`sync-status muted${sync.error ? " sync-error" : ""}`} role="status">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
