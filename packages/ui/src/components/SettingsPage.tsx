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
import {
  VIEW_COLOR_MODES,
  isViewColorMode,
  clampLivePreviewLines,
  MIN_LIVE_PREVIEW_LINES,
  MAX_LIVE_PREVIEW_LINES,
  DEFAULT_TAB_OPTIONS,
  isDefaultTab,
  CONTENT_TAB_OPTIONS,
  currentClientKind,
  ANDROID_CLIENT_KIND,
  type BoardScope,
  type ContentTab,
  type ViewColorMode,
} from "../viewconfig.ts";
import { LIVE_CATEGORY_ORDER, humanizeCategory } from "../live-stats.ts";
import { resolveDefaultTab, type Page } from "../nav.ts";
import { liveCapabilitiesStatusRows } from "../live-capabilities.ts";
import { useCapabilities, type CapabilitiesState } from "../useCapabilities.ts";

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
  disabledRangePresets: ReadonlySet<TimeRangePresetId>; // presets unavailable on this device/deployment
  boardScope: BoardScope; // whether this device loads contract-backed board data
  onBoardScope: (scope: BoardScope) => void;
  wideLayout: boolean; // force the wide (desktop) layout on this device (Android app only)
  onWideLayout: (wide: boolean) => void;
  colorMode: ViewColorMode;
  onColorMode: (mode: ViewColorMode) => void;
  livePreviewLines: number; // lines of an event body the Live feed shows before clamping
  onLivePreviewLines: (lines: number) => void;
  liveTabEnabled: boolean; // whether the realtime Live tab is shown + streams (off by default)
  onLiveTabEnabled: (enabled: boolean) => void;
  liveDisabled: boolean; // Live can't run on this deployment (the static Pages demo has no live server), so the Live tab + its sub-settings render disabled, like the suspended date range
  hiddenEventTypes: ReadonlySet<string>; // HIDDEN Live categories (an independent layer)
  onToggleEventType: (category: string) => void; // flip one category's Live visibility
  defaultTab: Page; // the tab the app opens on a hashless load
  onDefaultTab: (tab: Page) => void;
  contentTabOrder: readonly ContentTab[]; // order for the contract-backed top-nav tabs between Live and Settings
  onMoveContentTab: (tab: ContentTab, direction: -1 | 1) => void;
  serverBaseUrl: string | null;
  onServerBaseUrl: (serverBaseUrl: string | null) => void;
  sync?: SyncState; // writer-owned manual sync, when the control surface is available
  config?: ConfigState; // writer-owned producer config, when the capability is enabled
  tab?: SettingsTab; // URL-backed sub-tab; only meaningful when config is available
  onTab?: (tab: SettingsTab) => void;
  standalone?: boolean;
  setupLocked?: boolean;
}

// "display" is the shared, browser-local view-preferences page every
// deployment gets; "sources" is the writer-owned producer-config editor and
// exists only where the config capability answers. The tab bar itself renders
// only in that case, so deployments without the capability see the classic
// single-page Settings unchanged.
export type SettingsTab = "display" | "sources";

// Shown on the Live preferences when they are disabled on a static, server-less
// deployment (the Pages demo). Mirrors the date range's static-suspension tooltip
// (TimeRangeControls) so the two read-only-here controls explain themselves the
// same way.
const LIVE_DISABLED_TITLE =
  "This is a static demo with no server, so Live can't connect — the realtime tab is unavailable here.";

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
//   • choose the local color mode for this browser / Android WebView.
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
  disabledRangePresets,
  boardScope,
  onBoardScope,
  wideLayout,
  onWideLayout,
  colorMode,
  onColorMode,
  livePreviewLines,
  onLivePreviewLines,
  liveTabEnabled,
  onLiveTabEnabled,
  liveDisabled,
  hiddenEventTypes,
  onToggleEventType,
  defaultTab,
  onDefaultTab,
  contentTabOrder,
  onMoveContentTab,
  serverBaseUrl,
  onServerBaseUrl,
  sync,
  config,
  tab = "display",
  onTab,
  standalone = false,
  setupLocked = false,
}: Props) {
  const allKeys = repos.map((r) => r.key);
  const shownTotal = allKeys.filter((k) => !hidden.has(k)).length;
  const sourceMeta = new Map(sources.map((s) => [s.source_id, s]));
  // The wide-layout toggle only does anything in the Android WebView (the browser
  // and desktop shell are freely resizable), so it is shown only there.
  const isAndroid = currentClientKind() === ANDROID_CLIENT_KIND;

  // Group repos by source, preserving deriveRepos' (source, path) ordering.
  const bySource = new Map<string, RepoOption[]>();
  for (const r of repos) {
    const list = bySource.get(r.source_id);
    if (list) list.push(r);
    else bySource.set(r.source_id, [r]);
  }

  // The Live tab can't be a default-landing choice while Live is off (the landing
  // would resolve to a hidden tab); drop it from the picker in that case. On a
  // static deployment Live is forced off (liveDisabled), so it is dropped there
  // too — the picker tracks the same EFFECTIVE opt-in App routes on, not the raw
  // stored flag. The select VALUE is resolved the same way the landing is
  // (resolveDefaultTab), so a stored "live" default shows as Activity here while
  // Live is off — matching an offered option without rewriting the stored
  // preference, which re-applies once Live is available and turned back on.
  const liveTabEffectivelyEnabled = !standalone && liveTabEnabled && !liveDisabled;
  const tabOptions = liveTabEffectivelyEnabled
    ? DEFAULT_TAB_OPTIONS
    : DEFAULT_TAB_OPTIONS.filter((t) => t.id !== "live");
  const contentTabLabels = new Map(CONTENT_TAB_OPTIONS.map((t) => [t.id, t.label]));

  const showTabs = config?.available === true;
  const activeTab: SettingsTab = setupLocked || (showTabs && tab === "sources") ? "sources" : "display";
  const capabilities = useCapabilities(serverBaseUrl, !standalone && activeTab === "display");

  if (showTabs && activeTab === "sources" && config) {
    return (
      <section className="settings-page">
        <SettingsTabs active={activeTab} onTab={onTab} lockedToSources={setupLocked} />
        {setupLocked ? (
          <div className="banner warn standalone-setup-banner">
            GitHub PAT required before sync. Navigation unlocks after the token validates and saves.
          </div>
        ) : null}
        <SourcesEditor config={config} sync={sync} variant={standalone ? "standalone" : "default"} />
      </section>
    );
  }

  return (
    <section className="settings-page">
      {showTabs ? <SettingsTabs active={activeTab} onTab={onTab} lockedToSources={setupLocked} /> : null}
      <div className="settings-head">
        <div>
          <h2>Display</h2>
          <p className="muted">
            View-only preferences saved in your browser — display basics, board data and defaults,
            connection, and which repos and sources appear. The daemon keeps syncing every source
            regardless.
          </p>
        </div>
      </div>

      <div className="settings-pref">
        <div>
          <h3>Color mode</h3>
          <p className="muted">Follows this device by default. Light mode is tuned for e-ink readability.</p>
        </div>
        <select
          className="settings-select"
          value={colorMode}
          onChange={(e) => {
            if (isViewColorMode(e.target.value)) onColorMode(e.target.value);
          }}
        >
          {VIEW_COLOR_MODES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {isAndroid ? (
        <div className="settings-pref">
          <div>
            <h3>Wide layout</h3>
            <p className="muted">
              Render the full desktop layout instead of the phone layout — for a large screen such as
              an e-reader. Leave off on a phone. Saved on this device only.
            </p>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={wideLayout}
              onChange={(e) => onWideLayout(e.target.checked)}
              aria-label="Use the wide desktop layout"
            />
          </label>
        </div>
      ) : null}

      <SettingsSectionTitle title="Board" />
      <div className="settings-pref">
        <div>
          <h3>Board data</h3>
          <p className="muted">
            {standalone
              ? "Turn contract-backed board data on or off for this device."
              : "Turn contract-backed board data on or off. When off, only the Live feed is shown — open the Live tab below."}
          </p>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={boardScope !== "off"}
            onChange={(e) => onBoardScope(e.target.checked ? "full" : "off")}
            aria-label="Load board data"
          />
        </label>
      </div>

      <div className="settings-pref">
        <div>
          <h3>Default range</h3>
          <p className="muted">Used when the URL does not include from/to dates.</p>
          {disabledRangePresets.size > 0 ? (
            <p className="muted">Longer ranges are unavailable on this device.</p>
          ) : null}
        </div>
        <select
          className="settings-select"
          value={defaultRangePreset}
          onChange={(e) => {
            if (isTimeRangePresetId(e.target.value)) onDefaultRangePreset(e.target.value);
          }}
        >
          {TIME_RANGE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id} disabled={disabledRangePresets.has(preset.id)}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-pref">
        <div>
          <h3>Default tab</h3>
          <p className="muted">
            The tab to open when the URL has no specific page (a fresh open). Saved on this device only.
          </p>
        </div>
        <select
          className="settings-select"
          value={resolveDefaultTab(defaultTab, liveTabEffectivelyEnabled)}
          onChange={(e) => {
            if (isDefaultTab(e.target.value)) onDefaultTab(e.target.value);
          }}
        >
          {tabOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-pref settings-tab-order-pref">
        <div>
          <h3>Tab order</h3>
          <p className="muted">
            Order of the content tabs before Settings. Saved on this device only.
          </p>
        </div>
        <ol className="settings-tab-order-list" aria-label="Content tab order">
          {contentTabOrder.map((tab, index) => {
            const label = contentTabLabels.get(tab) ?? tab;
            return (
              <li key={tab}>
                <span>{label}</span>
                <span className="settings-tab-order-actions">
                  <button
                    type="button"
                    className="settings-order-button"
                    disabled={index === 0}
                    onClick={() => onMoveContentTab(tab, -1)}
                    aria-label={`Move ${label} earlier`}
                    title={`Move ${label} earlier`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="settings-order-button"
                    disabled={index === contentTabOrder.length - 1}
                    onClick={() => onMoveContentTab(tab, 1)}
                    aria-label={`Move ${label} later`}
                    title={`Move ${label} later`}
                  >
                    ↓
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {!standalone ? (
        <>
          <SettingsSectionTitle title="Live" />
          <div className={`settings-pref${liveDisabled ? " settings-pref-disabled" : ""}`} title={liveDisabled ? LIVE_DISABLED_TITLE : undefined}>
            <div>
              <h3>Live tab</h3>
              <p className="muted">
                Show the realtime Live tab and stream activity as it lands. Off by default — while off
                the tab is hidden and the app opens no live connection, so it costs nothing. Saved on
                this device only.
              </p>
              {liveDisabled ? <p className="muted">Live needs a running server — unavailable in this static demo.</p> : null}
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={liveTabEnabled}
                disabled={liveDisabled}
                onChange={(e) => onLiveTabEnabled(e.target.checked)}
                aria-label="Enable the Live tab"
              />
            </label>
          </div>

          <LiveCapabilitiesStatus state={capabilities} />

          {liveTabEffectivelyEnabled ? (
            <>
              <div className={`settings-pref${liveDisabled ? " settings-pref-disabled" : ""}`} title={liveDisabled ? LIVE_DISABLED_TITLE : undefined}>
                <div>
                  <h3>Live feed preview</h3>
                  <p className="muted">
                    Lines of an event body shown in the Live feed before it clamps; the full body opens in
                    the detail pane. Saved on this device only.
                  </p>
                </div>
                <input
                  className="settings-number"
                  type="number"
                  min={MIN_LIVE_PREVIEW_LINES}
                  max={MAX_LIVE_PREVIEW_LINES}
                  step={1}
                  value={livePreviewLines}
                  disabled={liveDisabled}
                  onChange={(e) => onLivePreviewLines(clampLivePreviewLines(Number(e.target.value)))}
                />
              </div>

              <div className={`settings-pref${liveDisabled ? " settings-pref-disabled" : ""}`} title={liveDisabled ? LIVE_DISABLED_TITLE : undefined}>
                <div>
                  <h3>Live event types</h3>
                  <p className="muted">
                    Which event categories appear in the Live feed and its filter strip. Unticking one
                    hides it everywhere on the Live tab. Saved on this device only.
                  </p>
                </div>
                <div className="settings-types">
                  {LIVE_CATEGORY_ORDER.map((category) => (
                    <label key={category} className="settings-type">
                      <input
                        type="checkbox"
                        checked={!hiddenEventTypes.has(category)}
                        disabled={liveDisabled}
                        onChange={() => onToggleEventType(category)}
                      />
                      <span>{humanizeCategory(category)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <SettingsSectionTitle title="Connection" />
      <div className="settings-pref settings-server">
        <div>
          <h3>Server</h3>
          <p className="muted">Used by the desktop app and optional remote deployments.</p>
        </div>
        <ServerConnectionForm serverBaseUrl={serverBaseUrl} onServerBaseUrl={onServerBaseUrl} />
      </div>

      {sync?.available ? <SyncControls sync={sync} /> : null}

      {repos.length > 0 ? (
        <div className="settings-repos-head">
          <div>
            <h3>Sources &amp; repos</h3>
            <p className="muted">
              Choose which repos and sources appear on the Board and Graph, and give a repo a
              highlight color. Hiding here is view-only — the daemon keeps syncing every source.
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
      ) : null}

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
                      <span
                        className="count"
                        title={`${r.count} ${r.count === 1 ? "item" : "items"}${
                          r.last_activity_at
                            ? ` · last active ${new Date(r.last_activity_at).toLocaleString("en-US", { hour12: false })}`
                            : " · no activity recorded"
                        }`}
                      >
                        {r.last_activity_at ? relativeTime(r.last_activity_at) : "—"}
                      </span>
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

function SettingsSectionTitle({ title }: { title: string }) {
  return <div className="settings-section-title">{title}</div>;
}

function LiveCapabilitiesStatus({ state }: { state: CapabilitiesState }) {
  const rows = liveCapabilitiesStatusRows(state.info);
  return (
    <div className="settings-pref settings-live-diagnostics">
      <div>
        <h3>Live server status</h3>
        <p className="muted">
          Server URL covers board, range, and Live reads. Webhook ingress is configured separately by
          the operator.
        </p>
        {state.loading ? (
          <p className="muted">Checking Live capabilities…</p>
        ) : (
          <ul className="settings-live-status-list">
            {rows.map((row) => (
              <li key={row.text} className={`settings-live-status-${row.kind}`}>
                {row.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="toggle" onClick={state.refresh} disabled={state.loading}>
        {state.loading ? "Checking…" : "Refresh"}
      </button>
    </div>
  );
}

function SettingsTabs({ active, onTab, lockedToSources = false }: { active: SettingsTab; onTab?: (tab: SettingsTab) => void; lockedToSources?: boolean }) {
  if (lockedToSources) {
    return (
      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" aria-selected="true" className="settings-tab settings-tab-active" disabled>
          Sources
        </button>
      </nav>
    );
  }
  return (
    <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
      <button type="button" role="tab" aria-selected={active === "display"} className={`settings-tab${active === "display" ? " settings-tab-active" : ""}`} onClick={() => onTab?.("display")}>
        Display
      </button>
      <button type="button" role="tab" aria-selected={active === "sources"} className={`settings-tab${active === "sources" ? " settings-tab-active" : ""}`} onClick={() => onTab?.("sources")}>
        Sources
      </button>
    </nav>
  );
}
