import type { SourceDTO } from "@symphony-board/contract";
import { relativeTime, type RepoOption } from "../model.ts";
import { Badge } from "./Badge.tsx";

interface Props {
  sources: SourceDTO[]; // per-source health, read-only (from the contract)
  repos: RepoOption[]; // every repo in the contract (full set, so hidden ones still show)
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSetVisible: (keys: string[], visible: boolean) => void; // bulk show/hide
}

// The Settings page: a persistent, client-side DISPLAY filter. You choose which
// repos the Board / Graph / stats show; the choice lives in localStorage and is
// applied as a global pre-filter (see App's visibleEnv / model.applyVisibility).
// It is view-only — the daemon keeps syncing every source (read-only consumer
// architecture; no backend, no contract change). Repos are grouped by source so
// each source's sync health (last status / last success) sits next to its repos.
export function SettingsPage({ sources, repos, hidden, onToggle, onSetVisible }: Props) {
  const allKeys = repos.map((r) => r.key);
  const shownTotal = allKeys.filter((k) => !hidden.has(k)).length;
  const sourceMeta = new Map(sources.map((s) => [s.source_id, s]));

  // Group repos by source, preserving deriveRepos' (source, path) ordering.
  const bySource = new Map<string, RepoOption[]>();
  for (const r of repos) {
    const list = bySource.get(r.source_id);
    if (list) list.push(r);
    else bySource.set(r.source_id, [r]);
  }

  return (
    <section className="settings-page">
      <div className="settings-head">
        <div>
          <h2>Display filter</h2>
          <p className="muted">
            Choose which repos appear on the Board and Graph. This is a view-only preference saved in your browser —
            unchecking a repo hides its items and their edges everywhere. The daemon keeps syncing every source.
          </p>
        </div>
        <div className="settings-bulk">
          <span className="muted">
            {shownTotal}/{allKeys.length} repos shown
          </span>
          <button type="button" className="toggle" onClick={() => onSetVisible(allKeys, true)}>
            Show all
          </button>
          <button type="button" className="toggle" onClick={() => onSetVisible(allKeys, false)}>
            Hide all
          </button>
        </div>
      </div>

      {[...bySource.entries()].map(([sourceId, list]) => {
        const meta = sourceMeta.get(sourceId);
        const keys = list.map((r) => r.key);
        const shown = keys.filter((k) => !hidden.has(k)).length;
        const status = meta?.last_status ?? "unknown";
        return (
          <div className="settings-source" key={sourceId}>
            <div className="settings-source-head">
              <Badge text={status} kind={`status-${status}`} />
              <span className="source-name">{meta?.display_name ?? sourceId}</span>
              <span className="muted">
                {meta?.kind ?? "?"} @ {meta?.host ?? "?"} · ok {relativeTime(meta?.last_success_at ?? null)}
              </span>
              <span className="settings-source-actions">
                <span className="count">
                  {shown}/{keys.length}
                </span>
                <button type="button" className="link-btn" onClick={() => onSetVisible(keys, true)}>
                  all
                </button>
                <button type="button" className="link-btn" onClick={() => onSetVisible(keys, false)}>
                  none
                </button>
              </span>
            </div>
            <ul className="settings-repos">
              {list.map((r) => (
                <li key={r.key}>
                  <label className="settings-repo">
                    <input type="checkbox" checked={!hidden.has(r.key)} onChange={() => onToggle(r.key)} />
                    <span className="settings-repo-name">{r.project_path ?? "(no project)"}</span>
                    <span className="count">{r.count}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {repos.length === 0 && <p className="empty">No repos in the contract yet.</p>}
    </section>
  );
}
