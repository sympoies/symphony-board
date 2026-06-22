// Persisting the Settings page's choices in localStorage — the view state the UI
// keeps across reloads (the transient facet filters stay in-memory only):
//   • hidden repos   — set of HIDDEN repoKeys (see model.repoKey)
//   • hidden sources — set of HIDDEN source_ids (an independent layer)
//   • color overrides — repoKey -> hex, this viewer's per-repo highlight override
//   • default range preset — one of the shared quick preset ids
//   • theme — device-local palette choice (Night Owl by default, Paper for e-ink)
//   • collapsed columns — board column kinds the viewer manually collapsed
//   • live tab enabled — opt-in Live tab (OFF by default: hidden tab, no stream)
//   • hidden event types — set of HIDDEN Live categories (an independent layer)
// We store what is HIDDEN (not what is visible) so a repo/source that first
// appears in a later sync defaults to visible — "everything visible" stays the
// default as the data grows.

import { DEFAULT_TIME_RANGE_PRESET_ID, isHexColor, isTimeRangePresetId, presetBeyondLoadedWindow, TIME_RANGE_PRESETS, timeRangeForDays, timeRangeForPreset, type TimeRange, type TimeRangePresetId } from "./model.ts";
import { isTauriRuntime } from "./runtime.ts";
import type { Page } from "./nav.ts";

const KEY = "symphony-board:hidden-repos";
// Hidden SOURCES live under their own key on purpose: a source is an independent
// visibility layer, so toggling one never touches the remembered per-repo set.
const SOURCES_KEY = "symphony-board:hidden-sources";
// Per-repo color OVERRIDE: repoKey -> hex. Stored as an object (repoKey is a
// JSON-string tuple, a valid object key); a repo absent here inherits from config.
const COLORS_KEY = "symphony-board:repo-colors";
const DEFAULT_RANGE_PRESET_KEY = "symphony-board:default-range-preset";
const THEME_KEY = "symphony-board:theme";
// How many lines of an event body the Live feed shows before clamping (the full
// body is one click away in the detail pane). Device-local, like the theme.
const LIVE_PREVIEW_LINES_KEY = "symphony-board:live-preview-lines";
// Whether the Live page's mobile "metrics" disclosure (the four pulse cards) is
// expanded. Device-local, like the theme: a phone user who collapses it to bring
// the feed up keeps it collapsed across reopens. Open by default.
const LIVE_PULSE_OPEN_KEY = "symphony-board:live-pulse-open";
// Which tab the app lands on when the URL has no page (a fresh open / share link
// without a hash). Device-local, like the theme.
const DEFAULT_TAB_KEY = "symphony-board:default-tab";
const SERVER_BASE_URL_KEY = "symphony-board:server-base-url";
// Whether THIS device forces the wide (desktop) layout. A large e-reader can host
// the desktop multi-column layout the CSS breakpoints gate on, but reports a small
// device-width and so falls into the phone layout; turning this on sets a fixed
// desktop-width viewport (Android WebView only — see runtime.applyWideViewport).
// Device-local, like the theme. Off by default.
const WIDE_LAYOUT_KEY = "symphony-board:wide-layout";
// How much of the board contract this device loads. The full ~90-day contract can
// be tens of MB decoded and OOM a weak WebView (an e-ink Android tablet), so a
// device may load only a recent time window via /api/range, or skip the contract
// entirely (Live-only). Device-local, like the theme. See BoardScope below.
const BOARD_SCOPE_KEY = "symphony-board:board-scope";
// Board columns the viewer has manually COLLAPSED to a slim rail. Empty columns
// auto-collapse without being persisted (they re-open when an item lands), so
// this set holds only explicit collapses of non-empty columns.
const COLLAPSED_COLUMNS_KEY = "symphony-board:collapsed-columns";
// Whether the realtime Live tab is shown at all. OFF by default: when off the
// tab is hidden AND the app opens no live connection (no snapshot probe, no
// SSE/poll), so a deployment that does not care about the feed pays nothing.
const LIVE_TAB_ENABLED_KEY = "symphony-board:live-tab-enabled";
// HIDDEN Live event categories (an independent layer, like hidden sources): a
// category in this set is dropped from the Live feed and its filter chip. Stored
// as the hidden set so a new provider category defaults visible.
const HIDDEN_EVENT_TYPES_KEY = "symphony-board:hidden-event-types";
export const DESKTOP_DEFAULT_SERVER_BASE_URL = "http://localhost:8080/";
export const ANDROID_CLIENT_KIND = "android";
export const VIEW_THEMES = [
  { id: "night-owl", label: "Night Owl" },
  { id: "paper", label: "Paper" },
] as const;
export type ViewTheme = (typeof VIEW_THEMES)[number]["id"];
export const DEFAULT_VIEW_THEME: ViewTheme = "night-owl";

function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set(); // unavailable / malformed storage — start with everything visible
  }
}

function saveStringSet(key: string, set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

export const loadHidden = (): Set<string> => loadStringSet(KEY);
export const saveHidden = (hidden: ReadonlySet<string>): void => saveStringSet(KEY, hidden);

export const loadHiddenSources = (): Set<string> => loadStringSet(SOURCES_KEY);
export const saveHiddenSources = (hidden: ReadonlySet<string>): void => saveStringSet(SOURCES_KEY, hidden);

export const loadCollapsedColumns = (): Set<string> => loadStringSet(COLLAPSED_COLUMNS_KEY);
export const saveCollapsedColumns = (collapsed: ReadonlySet<string>): void => saveStringSet(COLLAPSED_COLUMNS_KEY, collapsed);

export function loadColorOverrides(): Map<string, string> {
  try {
    const raw = localStorage.getItem(COLORS_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const out = new Map<string, string>();
    // Only accept valid hex: localStorage is hand-editable, and the override
    // value reaches a CSS sink. A bad entry is dropped (repo falls back to its
    // inherited color) rather than trusted.
    for (const [k, v] of Object.entries(parsed)) if (isHexColor(v)) out.set(k, v);
    return out;
  } catch {
    return new Map(); // unavailable / malformed storage — no overrides
  }
}

export function saveColorOverrides(overrides: ReadonlyMap<string, string>): void {
  try {
    localStorage.setItem(COLORS_KEY, JSON.stringify(Object.fromEntries(overrides)));
  } catch {
    /* storage unavailable / over quota — the override just won't persist */
  }
}

export function loadDefaultRangePreset(): TimeRangePresetId {
  try {
    const raw = localStorage.getItem(DEFAULT_RANGE_PRESET_KEY);
    return isTimeRangePresetId(raw) ? raw : DEFAULT_TIME_RANGE_PRESET_ID;
  } catch {
    return DEFAULT_TIME_RANGE_PRESET_ID;
  }
}

export function saveDefaultRangePreset(preset: TimeRangePresetId): void {
  try {
    localStorage.setItem(DEFAULT_RANGE_PRESET_KEY, preset);
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

export function isViewTheme(value: unknown): value is ViewTheme {
  return typeof value === "string" && VIEW_THEMES.some((theme) => theme.id === value);
}

export function loadTheme(): ViewTheme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isViewTheme(raw) ? raw : DEFAULT_VIEW_THEME;
  } catch {
    return DEFAULT_VIEW_THEME;
  }
}

export function saveTheme(theme: ViewTheme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

// Live feed preview height, in body lines. Kept short by default so the feed
// shows more events at a glance (the full body is one click away in the detail
// pane); Settings can raise it. Clamped to a sane range so a stored / hand-edited
// value can't break the layout.
export const DEFAULT_LIVE_PREVIEW_LINES = 2;
export const MIN_LIVE_PREVIEW_LINES = 1;
export const MAX_LIVE_PREVIEW_LINES = 30;

export function clampLivePreviewLines(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LIVE_PREVIEW_LINES;
  return Math.min(MAX_LIVE_PREVIEW_LINES, Math.max(MIN_LIVE_PREVIEW_LINES, Math.round(n)));
}

export function loadLivePreviewLines(): number {
  try {
    const raw = localStorage.getItem(LIVE_PREVIEW_LINES_KEY);
    if (raw === null) return DEFAULT_LIVE_PREVIEW_LINES;
    const n = Number(raw);
    return Number.isFinite(n) ? clampLivePreviewLines(n) : DEFAULT_LIVE_PREVIEW_LINES;
  } catch {
    return DEFAULT_LIVE_PREVIEW_LINES;
  }
}

export function saveLivePreviewLines(lines: number): void {
  try {
    localStorage.setItem(LIVE_PREVIEW_LINES_KEY, String(clampLivePreviewLines(lines)));
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

// The Live tab is opt-in: OFF unless explicitly turned on. Only the exact string
// "true" enables it, so a missing / hand-edited / stale value reads as off — the
// safe default (no hidden tab stranded behind a dead stream, no idle SSE).
export const DEFAULT_LIVE_TAB_ENABLED = false;

export function loadLiveTabEnabled(): boolean {
  try {
    return localStorage.getItem(LIVE_TAB_ENABLED_KEY) === "true";
  } catch {
    return DEFAULT_LIVE_TAB_ENABLED;
  }
}

export function saveLiveTabEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LIVE_TAB_ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

// The Live mobile "metrics" disclosure remembers its open/closed state across
// reopens (device-local). Open by default — a MISSING value reads as open, so a
// fresh install shows the metric cards; only an explicit "false" collapses them.
export const DEFAULT_LIVE_PULSE_OPEN = true;

export function loadLivePulseOpen(): boolean {
  try {
    const raw = localStorage.getItem(LIVE_PULSE_OPEN_KEY);
    return raw === null ? DEFAULT_LIVE_PULSE_OPEN : raw === "true";
  } catch {
    return DEFAULT_LIVE_PULSE_OPEN;
  }
}

export function saveLivePulseOpen(open: boolean): void {
  try {
    localStorage.setItem(LIVE_PULSE_OPEN_KEY, open ? "true" : "false");
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

// How much of the board contract to load on THIS device:
//   • "off"  — load no contract at all (Live-only); the contract tabs are hidden
//   • "1d" / "3d" / "7d" — load only that recent window via /api/range (small,
//     so a weak WebView does not OOM on the full payload)
//   • "full" — the full contract (./contract.json), the historical behavior
// Device-local, like the theme. Android defaults to a 7-day window (weak e-ink
// hardware); desktop/web default to "full" (they have the memory).
export type BoardScope = "off" | "1d" | "3d" | "7d" | "1mo" | "3mo" | "6mo" | "1y" | "full";
export const BOARD_SCOPE_VALUES: readonly BoardScope[] = ["off", "1d", "3d", "7d", "1mo", "3mo", "6mo", "1y", "full"];

export function isBoardScope(value: unknown): value is BoardScope {
  return typeof value === "string" && (BOARD_SCOPE_VALUES as readonly string[]).includes(value);
}

// Day-count for a WINDOWED scope (a /api/range fetch of this many trailing days),
// or null for "off" / "full" — neither of which is a time window.
export function boardScopeDays(scope: BoardScope): number | null {
  switch (scope) {
    case "1d":
      return 1;
    case "3d":
      return 3;
    case "7d":
      return 7;
    case "1mo":
      return 30;
    case "3mo":
      return 90;
    case "6mo":
      return 180;
    case "1y":
      return 365;
    default:
      return null;
  }
}

// Whether a Default range preset reaches further back than a Board data scope's
// loaded window — i.e. it is "larger than Board data" and so must not be selectable
// (the device never loaded data that old). A non-windowed scope (full / off) has no
// ceiling, so nothing exceeds it. `now` (the contract's generated-at) and `tz`
// resolve the calendar presets to concrete days for the comparison.
export function presetExceedsBoardScope(preset: TimeRangePresetId, scope: BoardScope, now: number, tz?: string): boolean {
  const days = boardScopeDays(scope);
  if (days == null) return false;
  return presetBeyondLoadedWindow(timeRangeForPreset(preset, now, tz), timeRangeForDays(days, now, tz).from);
}

// The Default range preset shrunk to fit a Board data scope: kept as-is when it
// already fits, otherwise the largest preset still inside the loaded window (the one
// starting earliest, then ending latest). Lowering Board data below the current
// Default range pulls the default down with it; a default already within the window
// is untouched, and raising Board data never grows it back. Falls back to the
// unchanged preset if somehow nothing fits.
export function clampDefaultRangeToBoardScope(preset: TimeRangePresetId, scope: BoardScope, now: number, tz?: string): TimeRangePresetId {
  if (!presetExceedsBoardScope(preset, scope, now, tz)) return preset;
  const windowFrom = timeRangeForDays(boardScopeDays(scope)!, now, tz).from;
  const fitting = TIME_RANGE_PRESETS.map((p) => ({ id: p.id, range: timeRangeForPreset(p.id, now, tz) }))
    .filter(({ range }) => range.from >= windowFrom)
    .sort((a, b) => a.range.from.localeCompare(b.range.from) || b.range.to.localeCompare(a.range.to));
  return fitting[0]?.id ?? preset;
}

// The loaded board window as the UI should DISPLAY and compare it: exactly
// boardScopeDays(scope) days ending at `now` — the contract's generated-at, the
// SAME instant every quick preset, the active-preset highlight, and the synthetic
// window button resolve against. Returns null for the unwindowed scopes (off /
// full), which have no fixed window.
//
// Why not derive it from the loaded env's item_window? A windowed scope FETCHES
// /api/range with the live Date.now() (there is no env yet on first load), so
// item_window carries the fetch clock. staticContractTimeRange then builds a range
// whose `from` is the fetch clock but whose `to` is generated_at — two clocks in
// one range. When a load crosses local midnight, or the contract is stale / a
// fixture with an older generated_at, that range drifts off its same-named preset:
// windowQuickPreset stops recognising it and injects a duplicate quick button
// (e.g. a second "1mo"), and presetBeyondLoadedWindow mis-hides longer presets.
// Resolving the window on `now` keeps it byte-identical to its preset
// (1d == today, 7d == 1w, 1mo/3mo/6mo/1y == the rolling presets; only 3d has no
// built-in equivalent), so no duplicate appears and the highlight stays in sync.
export function boardWindowRange(scope: BoardScope, now: number, tz?: string): TimeRange | null {
  const days = boardScopeDays(scope);
  return days == null ? null : timeRangeForDays(days, now, tz);
}

// The default scope for a client kind when nothing is stored: Android renders on
// (often) weak e-ink hardware where the full contract can OOM the WebView, so it
// starts on a small 7-day window; every other client keeps the full board.
export function defaultBoardScope(clientKind: string | null = currentClientKind()): BoardScope {
  return clientKind === ANDROID_CLIENT_KIND ? "7d" : "full";
}

export function loadBoardScope(): BoardScope {
  try {
    const raw = localStorage.getItem(BOARD_SCOPE_KEY);
    return isBoardScope(raw) ? raw : defaultBoardScope();
  } catch {
    return defaultBoardScope();
  }
}

export function saveBoardScope(scope: BoardScope): void {
  try {
    localStorage.setItem(BOARD_SCOPE_KEY, scope);
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

// Force the wide (desktop) layout on this device. Off by default — only an exact
// stored "true" turns it on, so a missing / hand-edited value reads as off (the
// normal responsive layout). Device-local, like the theme.
export const DEFAULT_WIDE_LAYOUT = false;

export function loadWideLayout(): boolean {
  try {
    return localStorage.getItem(WIDE_LAYOUT_KEY) === "true";
  } catch {
    return DEFAULT_WIDE_LAYOUT;
  }
}

export function saveWideLayout(wide: boolean): void {
  try {
    localStorage.setItem(WIDE_LAYOUT_KEY, wide ? "true" : "false");
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

// HIDDEN Live event categories — the persistent "which event types to show"
// filter, stored as the hidden set (its own key, like hidden sources) so a new
// provider category defaults visible. Empty = everything visible.
export const loadHiddenEventTypes = (): Set<string> => loadStringSet(HIDDEN_EVENT_TYPES_KEY);
export const saveHiddenEventTypes = (hidden: ReadonlySet<string>): void => saveStringSet(HIDDEN_EVENT_TYPES_KEY, hidden);

// The tabs offered as a default-landing choice (the content views; Settings is
// excluded — it is not a landing surface). Live leads.
export const DEFAULT_TAB_OPTIONS: { id: Page; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "activity", label: "Activity" },
  { id: "commits", label: "Commits" },
  { id: "reviews", label: "Reviews" },
  { id: "board", label: "Board" },
  { id: "graph", label: "Graph" },
  { id: "repo-analytics", label: "Analytics" },
];
export const DEFAULT_TAB: Page = "live";

export function isDefaultTab(value: unknown): value is Page {
  return typeof value === "string" && DEFAULT_TAB_OPTIONS.some((t) => t.id === value);
}

export function loadDefaultTab(): Page {
  try {
    const raw = localStorage.getItem(DEFAULT_TAB_KEY);
    return isDefaultTab(raw) ? raw : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

export function saveDefaultTab(tab: Page): void {
  try {
    localStorage.setItem(DEFAULT_TAB_KEY, tab);
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

export function normalizeServerBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return null;
  }
}

function configuredServerBaseUrl(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return normalizeServerBaseUrl(env?.VITE_SYMPHONY_BOARD_SERVER_URL);
}

export function currentClientKind(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_SYMPHONY_BOARD_CLIENT?.trim().toLowerCase() || null;
}

export function requiresConfiguredServerBaseUrl(clientKind: string | null): boolean {
  return clientKind === ANDROID_CLIENT_KIND;
}

export function defaultServerBaseUrlForRuntime(clientKind: string | null, tauriRuntime: boolean): string | null {
  if (!tauriRuntime) return null;
  return requiresConfiguredServerBaseUrl(clientKind) ? null : DESKTOP_DEFAULT_SERVER_BASE_URL;
}

export function loadServerBaseUrl(): string | null {
  try {
    const stored = normalizeServerBaseUrl(localStorage.getItem(SERVER_BASE_URL_KEY));
    if (stored) return stored;
  } catch {
    /* storage unavailable — fall through to configured/default host */
  }
  return configuredServerBaseUrl() ?? defaultServerBaseUrlForRuntime(currentClientKind(), isTauriRuntime());
}

export function saveServerBaseUrl(baseUrl: string | null): void {
  const normalized = normalizeServerBaseUrl(baseUrl);
  try {
    if (normalized) localStorage.setItem(SERVER_BASE_URL_KEY, normalized);
    else localStorage.removeItem(SERVER_BASE_URL_KEY);
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}
