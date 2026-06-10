import type { SourceDTO } from "@symphony-board/contract";
import {
  relativeTime,
  isHexColor,
  isTimeRangePresetId,
  TIME_RANGE_PRESETS,
  type RepoOption,
  type ColorOf,
  type TimeRangePresetId,
} from "../model.ts";
import { Badge } from "./Badge.tsx";
import { SyncControls } from "./SyncControls.tsx";
import { SourcesEditor } from "./SourcesEditor.tsx";
import { ServerConnectionForm } from "./ServerConnectionForm.tsx";
import type { SyncState } from "../useSync.ts";
import type { ConfigState } from "../useConfig.ts";

interface Props {
  sources: SourceDTO[]; // per-source health + configured color, read-only (from the contract)
  repos: RepoOption[]; // every repo in the contract (full set, so hidden ones still show)
  hidden: ReadonlySet<string>; // hidden repoKeys
  onToggle: (key: string) => void;
  onSetVisible: (keys: string[], visible: boolean) => void; // bulk show/hide repos
  hiddenSources: ReadonlySet<string>; // hidden source_ids (independent layer)
  onToggleSource: (source_id: string) => void;
  colorOf: ColorOf; // effective highlight color (override -> repo -> source -> none)
  colorOverrides: ReadonlyMap<string, string>; // repoKey -> override (presence drives the reset affordance)
  onSetColor: (key: string, color: string) => void;
  onClearColor: (key: string) => void;
  defaultRangePreset: TimeRangePresetId;
  onDefaultRangePreset: (preset: TimeRangePresetId) => void;
  serverBaseUrl: string | null;
  onServerBaseUrl: (serverBaseUrl: string | null) => void;
  sync?: SyncState; // writer-owned manual sync, when the control surface is available
  config?: ConfigState; // writer-owned producer config, when the capability is enabled
}

// <input type="color"> only accepts #rrggbb. Expand a #rgb shorthand and seed
// the picker with a neutral grey when there's nothing to inherit from.
function toInputHex(color: string | null): string {
  if (!color) return "#888888";
  const m = /^#([0-9a-fA-F]{3})$/.exec(color);
  if (m) {
    const [r, g, b] = m[1]!.split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return color;
}

// The Settings page: persistent, client-side display preferences kept in
// localStorage and applied as a global pre-filter (App's visibleEnv /
// model.applyVisibility) + a render-time highlight (model.colorOf). Three
// controls, all view-only — the daemon keeps syncing every source (read-only
// consumer architecture):
//   • hide individual repos, or a whole source (independent layers — hiding a
//     source leaves its per-repo choices remembered);
//   • give a repo a highlight color, overriding the config repo/source color.
//   • choose the default shared date range when the URL has no explicit from/to.
// Repos are grouped by source so each source's sync health sits next to its repos.
export function SettingsPage({
  sources,
  repos,
  hidden,
  onToggle,
  onSetVisible,
  hiddenSources,
  onToggleSource,
  colorOf,
  colorOverrides,
  onSetColor,
  onClearColor,
  defaultRangePreset,
  onDefaultRangePreset,
  serverBaseUrl,
  onServerBaseUrl,
  sync,
  config,
}: Props) {
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
          <h2>Display</h2>
          <p className="muted">
            Choose which repos and sources appear, set the default shared date range, and give a repo a highlight color.
            These are view-only preferences saved in your browser. The daemon keeps syncing every source.
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

      <div className="settings-pref">
        <div>
          <h3>Default range</h3>
          <p className="muted">Used when the URL does not include from/to dates.</p>
        </div>
        <select
          className="settings-select"
          value={defaultRangePreset}
          onChange={(e) => {
            if (isTimeRangePresetId(e.target.value)) onDefaultRangePreset(e.target.value);
          }}
        >
          {TIME_RANGE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-pref settings-server">
        <div>
          <h3>Server</h3>
          <p className="muted">Used by the desktop app and optional remote deployments.</p>
        </div>
        <ServerConnectionForm serverBaseUrl={serverBaseUrl} onServerBaseUrl={onServerBaseUrl} />
      </div>

      {sync?.available ? <SyncControls sync={sync} /> : null}

      {config?.available ? <SourcesEditor config={config} sync={sync} /> : null}

      {[...bySource.entries()].map(([sourceId, list]) => {
        const meta = sourceMeta.get(sourceId);
        const keys = list.map((r) => r.key);
        const shown = keys.filter((k) => !hidden.has(k)).length;
        const status = meta?.last_status ?? "unknown";
        const sourceHidden = hiddenSources.has(sourceId);
        return (
          <div className={`settings-source${sourceHidden ? " settings-source-off" : ""}`} key={sourceId}>
            <div className="settings-source-head">
              <label className="settings-source-show" title="show this source on the Board and Graph">
                <input type="checkbox" checked={!sourceHidden} onChange={() => onToggleSource(sourceId)} />
              </label>
              <Badge text={status} kind={`status-${status}`} />
              <span className="source-name">{meta?.display_name ?? sourceId}</span>
              {meta?.color && isHexColor(meta.color) ? (
                <span className="color-swatch" style={{ background: meta.color }} title={`source color ${meta.color} (set in config)`} />
              ) : null}
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
              {list.map((r) => {
                const effective = colorOf(r.source_id, r.project_path);
                const overridden = colorOverrides.has(r.key);
                return (
                  <li key={r.key}>
                    <label className="settings-repo">
                      <input type="checkbox" checked={!hidden.has(r.key)} onChange={() => onToggle(r.key)} />
                      <span className="settings-repo-name">{r.project_path ?? "(no project)"}</span>
                      <span className="count">{r.count}</span>
                    </label>
                    <span className="settings-repo-color">
                      <input
                        type="color"
                        className="color-input"
                        value={toInputHex(effective)}
                        onChange={(e) => onSetColor(r.key, e.target.value)}
                        title={
                          overridden
                            ? `override ${effective}`
                            : effective
                              ? `inherited ${effective} — pick to override`
                              : "set a highlight color"
                        }
                      />
                      {overridden ? (
                        <button type="button" className="link-btn" onClick={() => onClearColor(r.key)} title="reset to the inherited color">
                          reset
                        </button>
                      ) : (
                        <span className="link-btn-placeholder" aria-hidden="true" />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      {repos.length === 0 && <p className="empty">No repos in the contract yet.</p>}
    </section>
  );
}
