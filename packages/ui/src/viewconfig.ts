// Persisting the Settings page's choices in localStorage — the view state the UI
// keeps across reloads (the transient facet filters stay in-memory only):
//   • hidden repos   — set of HIDDEN repoKeys (see model.repoKey)
//   • hidden sources — set of HIDDEN source_ids (an independent layer)
//   • color overrides — repoKey -> hex, this viewer's per-repo highlight override
//   • default range preset — one of the shared quick preset ids
//   • color mode — device-local display mode (System by default)
//   • collapsed columns — board column kinds the viewer manually collapsed
//   • live tab enabled — opt-in Live tab (OFF by default: hidden tab, no stream)
//   • hidden event types — set of HIDDEN Live categories (an independent layer)
//   • content tab order — the contract-backed top-nav tabs between Live/Settings
// We store what is HIDDEN (not what is visible) so a repo/source that first
// appears in a later sync defaults to visible — "everything visible" stays the
// default as the data grows.

import { cutoffIso, DEFAULT_TIME_RANGE_DAYS, DEFAULT_TIME_RANGE_PRESET_ID, isHexColor, isTimeRangePresetId, timeRangeForDays, type TimeRange, type TimeRangePresetId } from "./model.ts";
import { isTauriRuntime } from "./runtime.ts";
import type { Page } from "./nav.ts";
import type { ContractEnvelope } from "@symphony-board/contract";
import { isValidTimezone, zonedDateOnly } from "./tz.ts";

const KEY = "symphony-board:hidden-repos";
// Hidden SOURCES live under their own key on purpose: a source is an independent
// visibility layer, so toggling one never touches the remembered per-repo set.
const SOURCES_KEY = "symphony-board:hidden-sources";
// Per-repo color OVERRIDE: repoKey -> hex. Stored as an object (repoKey is a
// JSON-string tuple, a valid object key); a repo absent here inherits from config.
const COLORS_KEY = "symphony-board:repo-colors";
const DEFAULT_RANGE_PRESET_KEY = "symphony-board:default-range-preset";
// Kept on the original key so existing browser / Android WebView installs carry
// their display preference forward. Legacy values are normalized on read.
const COLOR_MODE_KEY = "symphony-board:theme";
// How many lines of an event body the Live feed shows before clamping (the full
// body is one click away in the detail pane). Device-local, like color mode.
const LIVE_PREVIEW_LINES_KEY = "symphony-board:live-preview-lines";
// Whether the Live page's mobile "metrics" disclosure (the four pulse cards) is
// expanded. Device-local, like color mode: a phone user who collapses it to
// bring the feed up keeps it collapsed across reopens. Open by default.
const LIVE_PULSE_OPEN_KEY = "symphony-board:live-pulse-open";
// Which tab the app lands on when the URL has no page (a fresh open / share link
// without a hash). Device-local, like color mode.
const DEFAULT_TAB_KEY = "symphony-board:default-tab";
const CONTENT_TAB_ORDER_KEY = "symphony-board:content-tab-order";
const SERVER_BASE_URL_KEY = "symphony-board:server-base-url";
// Whether THIS device forces the wide (desktop) layout. A large e-reader can host
// the desktop multi-column layout the CSS breakpoints gate on, but reports a small
// device-width and so falls into the phone layout; turning this on sets a fixed
// desktop-width viewport (Android WebView only — see runtime.applyWideViewport).
// Device-local, like color mode. Off by default.
const WIDE_LAYOUT_KEY = "symphony-board:wide-layout";
// Whether this device loads contract-backed board data at all. The selected date
// range now controls download size, so this is intentionally binary: on/full or
// off/Live-only. Device-local, like color mode. See BoardScope below.
const BOARD_SCOPE_KEY = "symphony-board:board-scope";
const LAST_CONTRACT_TIMEZONE_KEY = "symphony-board:last-contract-timezone";
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
export const VIEW_COLOR_MODES = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const;
export type ViewColorMode = (typeof VIEW_COLOR_MODES)[number]["id"];
export type ResolvedViewTheme = "night-owl" | "paper";
export const DEFAULT_VIEW_COLOR_MODE: ViewColorMode = "system";
export const SYSTEM_DARK_MODE_QUERY = "(prefers-color-scheme: dark)";
export const THEME_META_COLORS: Record<ResolvedViewTheme, string> = {
  "night-owl": "#030b22",
  paper: "#f4f3ed",
};

type SystemColorSchemeTarget = {
  matchMedia?: Window["matchMedia"];
};

export function systemPrefersDark(target: SystemColorSchemeTarget | undefined = typeof window === "undefined" ? undefined : window): boolean {
  try {
    return typeof target?.matchMedia === "function" ? target.matchMedia(SYSTEM_DARK_MODE_QUERY).matches : true;
  } catch {
    return true;
  }
}

export function subscribeSystemColorScheme(
  onChange: (prefersDark: boolean) => void,
  target: SystemColorSchemeTarget | undefined = typeof window === "undefined" ? undefined : window,
): (() => void) | undefined {
  if (typeof target?.matchMedia !== "function") return undefined;
  let media: MediaQueryList;
  try {
    media = target.matchMedia(SYSTEM_DARK_MODE_QUERY);
  } catch {
    return undefined;
  }
  const emit = () => onChange(media.matches);
  emit();
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", emit);
    return () => media.removeEventListener("change", emit);
  }
  if (typeof media.addListener === "function") {
    media.addListener(emit);
    return () => media.removeListener(emit);
  }
  return undefined;
}

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

// The default landing range preset for a client kind when nothing is stored.
// Under the range-as-download model (#488) the displayed range IS what the client
// fetches, so the landing preset is also the device's default download size: the
// Android thin client (weak e-ink hardware) lands on a small 7-day window ("1w"),
// every other client on "this week". Pure so the routing is unit-testable.
export function defaultRangePresetForClient(clientKind: string | null = currentClientKind()): TimeRangePresetId {
  return clientKind === ANDROID_CLIENT_KIND ? "1w" : DEFAULT_TIME_RANGE_PRESET_ID;
}

export function loadDefaultRangePreset(): TimeRangePresetId {
  try {
    const raw = localStorage.getItem(DEFAULT_RANGE_PRESET_KEY);
    return isTimeRangePresetId(raw) ? raw : defaultRangePresetForClient();
  } catch {
    return defaultRangePresetForClient();
  }
}

export function saveDefaultRangePreset(preset: TimeRangePresetId): void {
  try {
    localStorage.setItem(DEFAULT_RANGE_PRESET_KEY, preset);
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

export function isViewColorMode(value: unknown): value is ViewColorMode {
  return typeof value === "string" && VIEW_COLOR_MODES.some((mode) => mode.id === value);
}

function normalizeColorMode(value: unknown): ViewColorMode {
  if (isViewColorMode(value)) return value;
  if (value === "night-owl") return "dark";
  if (value === "paper") return "light";
  return DEFAULT_VIEW_COLOR_MODE;
}

export function loadColorMode(): ViewColorMode {
  try {
    return normalizeColorMode(localStorage.getItem(COLOR_MODE_KEY));
  } catch {
    return DEFAULT_VIEW_COLOR_MODE;
  }
}

export function saveColorMode(mode: ViewColorMode): void {
  try {
    localStorage.setItem(COLOR_MODE_KEY, mode);
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}

export function resolveViewTheme(mode: ViewColorMode, systemPrefersDark: boolean): ResolvedViewTheme {
  if (mode === "light") return "paper";
  if (mode === "dark") return "night-owl";
  return systemPrefersDark ? "night-owl" : "paper";
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

// Whether contract-backed board data is loaded on THIS device:
//   • "off"  — load no contract at all (Live-only); the contract tabs are hidden
//   • "full" — load the selected date range as the primary contract
// The old 9-value model stored fixed window sizes here; those legacy values now
// normalize to "full" because the shared date range owns the download size.
export type BoardScope = "off" | "full";

// Whether this build is served as a fully STATIC artifact with NO API backend —
// the GitHub Pages demo (built with VITE_SYMPHONY_BOARD_STATIC). Such a host
// serves ./contract.json but 404s ./api/range, so it should land on the
// contract's full extent. A normal deployment (Docker web sidecar, standalone
// app, Android client) leaves the flag
// unset, so import.meta.env is absent / falsy and this is false — the historical
// behaviour is untouched.
export function isStaticDeployment(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_SYMPHONY_BOARD_STATIC?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// Whether the Live view-preferences (the Live-tab switch and its dependent
// sub-settings — feed-preview lines, event-type visibility) should render
// DISABLED rather than interactive. Live needs a running receiver (the
// SSE/snapshot server); a static, server-less deployment (the GitHub Pages demo)
// has none, so the Live tab can never appear there and toggling it is a no-op
// trap. Disable the controls there, the same way the date range suspends on a
// static host (App passes isStaticDeployment()). A normal deployment leaves them
// interactive. Pure so the gate is unit-tested.
export function liveControlsDisabled(staticDeployment: boolean): boolean {
  return staticDeployment;
}

// The EFFECTIVE Live opt-in the app routes on, given the stored Settings flag and
// the deployment. On a static, server-less deployment (the Pages demo) Live can't
// run — its controls are disabled (liveControlsDisabled) — so a stale stored
// `live-tab-enabled=true` is coerced off here: otherwise the static build would
// still probe ./api/live-snapshot (404), show the Live tab, and bounce off a dead
// #/live with no Settings control left to clear the opt-in. The STORED flag is
// untouched (Settings still shows it), so the preference re-applies on a real,
// server-backed deployment. App feeds this to useLive + liveTabVisible and to the
// startup-route resolution; pure so the gate is unit-tested.
export function effectiveLiveTabEnabled(storedEnabled: boolean, staticDeployment: boolean): boolean {
  return storedEnabled && !liveControlsDisabled(staticDeployment);
}

// --- range-as-download model (#488) -----------------------------------------
// The selected date range is what the client downloads. These pure helpers
// decide, for a requested range, how much to fetch and via which path.

// The widest range a device may request, in days. The Android thin client runs
// on weak (e-ink) hardware that cannot gunzip + IPC-marshal + JSON.parse a
// multi-MB payload without OOM (the same reason CONTRACT_REQUEST_TIMEOUT_MS_ANDROID
// exists), so its picker is hard-capped at 30 days; every other client may reach
// the 1-year maximum.
export function deviceCeilingDays(clientKind: string | null = currentClientKind()): number {
  return clientKind === ANDROID_CLIENT_KIND ? 30 : 365;
}

// Clamp a requested range so it never reaches further back than the device
// ceiling allows; the `to` end and a range already inside the ceiling are left
// untouched. `null` ceiling means no cap. Pure + unit-tested.
export function clampRangeToCeiling(range: TimeRange, ceilingDays: number | null, now: number, tz?: string): TimeRange {
  if (ceilingDays == null) return range;
  const floor = timeRangeForDays(ceilingDays, now, tz).from;
  return range.from < floor ? { from: floor, to: range.to < floor ? floor : range.to } : range;
}

// Whether a requested range equals the emitted default window — the trailing
// DEFAULT_TIME_RANGE_DAYS (90) calendar days ending at ~now. That window is the
// one the static, pre-gzipped, mtime-cached ./contract.json already holds, so a
// request for exactly it takes the cheap static fast-path instead of recomputing
// /api/range. Date-only strings compare exactly. Pure + unit-tested.
export function isDefaultWindowRange(range: TimeRange, now: number, tz?: string): boolean {
  const cutoffMs = Date.parse(cutoffIso(DEFAULT_TIME_RANGE_DAYS, now));
  const zone = tz ?? "UTC";
  const def = { from: zonedDateOnly(cutoffMs, zone), to: zonedDateOnly(now, zone) };
  return range.from === def.from && range.to === def.to;
}

// Whether the primary load for a requested range should take the static
// ./contract.json fast-path (true) or fetch a dynamic /api/range projection
// (false). The static file is used for the exact default 90-day window and on a
// static/demo deploy that has no /api/range at all. Pure + unit-tested.
export function usesStaticContractFastPath(range: TimeRange, staticDeployment: boolean, now: number, tz?: string): boolean {
  return staticDeployment || isDefaultWindowRange(range, now, tz);
}

// The default board-data toggle for a client kind when nothing is stored. Range
// size is controlled by the shared date picker, so every client defaults to on.
export function defaultBoardScope(clientKind: string | null = currentClientKind()): BoardScope {
  void clientKind;
  return "full";
}

function normalizeBoardScope(raw: unknown): BoardScope {
  return raw === "off" ? "off" : "full";
}

export function loadBoardScope(): BoardScope {
  try {
    const raw = localStorage.getItem(BOARD_SCOPE_KEY);
    return raw == null ? defaultBoardScope() : normalizeBoardScope(raw);
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

function serverScopedKey(serverBaseUrl: string | null): string {
  return serverBaseUrl ?? "__same-origin__";
}

export function loadLastContractTimezone(serverBaseUrl: string | null): string | null {
  try {
    const raw = localStorage.getItem(LAST_CONTRACT_TIMEZONE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[serverScopedKey(serverBaseUrl)];
    return isValidTimezone(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLastContractTimezone(serverBaseUrl: string | null, timezone: string | null | undefined): void {
  try {
    const raw = localStorage.getItem(LAST_CONTRACT_TIMEZONE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const next: Record<string, string> =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => isValidTimezone(value)))
        : {};
    const key = serverScopedKey(serverBaseUrl);
    if (isValidTimezone(timezone)) next[key] = timezone;
    else delete next[key];
    localStorage.setItem(LAST_CONTRACT_TIMEZONE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable / over quota — the cache hint just won't persist */
  }
}

// Force the wide (desktop) layout on this device. Off by default — only an exact
// stored "true" turns it on, so a missing / hand-edited value reads as off (the
// normal responsive layout). Device-local, like color mode.
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

// Contract-backed top-nav tabs whose order is viewer-configurable. Live remains
// the special realtime entry before these; Settings remains the recovery/config
// surface after them.
export const CONTENT_TAB_OPTIONS = [
  { id: "activity", label: "Activity" },
  { id: "items", label: "Items" },
  { id: "commits", label: "Commits" },
  { id: "reviews", label: "Reviews" },
  { id: "board", label: "Board" },
  { id: "graph", label: "Graph" },
  { id: "repo-analytics", label: "Analytics" },
] as const satisfies readonly { id: Page; label: string }[];
export type ContentTab = (typeof CONTENT_TAB_OPTIONS)[number]["id"];

// The tabs offered as a default-landing choice (the content views; Settings is
// excluded — it is not a landing surface). Live leads.
export const DEFAULT_TAB_OPTIONS: { id: Page; label: string }[] = [
  { id: "live", label: "Live" },
  ...CONTENT_TAB_OPTIONS,
];
export const DEFAULT_TAB: Page = "live";

export function isDefaultTab(value: unknown): value is Page {
  return typeof value === "string" && DEFAULT_TAB_OPTIONS.some((t) => t.id === value);
}

export function isContentTab(value: unknown): value is ContentTab {
  return typeof value === "string" && CONTENT_TAB_OPTIONS.some((t) => t.id === value);
}

const DEFAULT_CONTENT_TAB_ORDER: ContentTab[] = CONTENT_TAB_OPTIONS.map((t) => t.id);

export function normalizeContentTabOrder(order: readonly unknown[] | null | undefined): ContentTab[] {
  const out: ContentTab[] = [];
  for (const value of order ?? []) {
    if (isContentTab(value) && !out.includes(value)) out.push(value);
  }
  for (const value of DEFAULT_CONTENT_TAB_ORDER) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
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

export function loadContentTabOrder(): ContentTab[] {
  try {
    const raw = localStorage.getItem(CONTENT_TAB_ORDER_KEY);
    if (!raw) return [...DEFAULT_CONTENT_TAB_ORDER];
    const parsed = JSON.parse(raw) as unknown;
    return normalizeContentTabOrder(Array.isArray(parsed) ? parsed : null);
  } catch {
    return [...DEFAULT_CONTENT_TAB_ORDER];
  }
}

export function saveContentTabOrder(order: readonly unknown[]): void {
  try {
    localStorage.setItem(CONTENT_TAB_ORDER_KEY, JSON.stringify(normalizeContentTabOrder(order)));
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
