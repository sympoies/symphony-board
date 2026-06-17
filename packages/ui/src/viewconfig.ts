// Persisting the Settings page's choices in localStorage — the view state the UI
// keeps across reloads (the transient facet filters stay in-memory only):
//   • hidden repos   — set of HIDDEN repoKeys (see model.repoKey)
//   • hidden sources — set of HIDDEN source_ids (an independent layer)
//   • color overrides — repoKey -> hex, this viewer's per-repo highlight override
//   • default range preset — one of the shared quick preset ids
//   • theme — device-local palette choice (Night Owl by default, Paper for e-ink)
//   • collapsed columns — board column kinds the viewer manually collapsed
// We store what is HIDDEN (not what is visible) so a repo/source that first
// appears in a later sync defaults to visible — "everything visible" stays the
// default as the data grows.

import { DEFAULT_TIME_RANGE_PRESET_ID, isHexColor, isTimeRangePresetId, type TimeRangePresetId } from "./model.ts";
import { isTauriRuntime } from "./runtime.ts";

const KEY = "symphony-board:hidden-repos";
// Hidden SOURCES live under their own key on purpose: a source is an independent
// visibility layer, so toggling one never touches the remembered per-repo set.
const SOURCES_KEY = "symphony-board:hidden-sources";
// Per-repo color OVERRIDE: repoKey -> hex. Stored as an object (repoKey is a
// JSON-string tuple, a valid object key); a repo absent here inherits from config.
const COLORS_KEY = "symphony-board:repo-colors";
const DEFAULT_RANGE_PRESET_KEY = "symphony-board:default-range-preset";
const THEME_KEY = "symphony-board:theme";
const SERVER_BASE_URL_KEY = "symphony-board:server-base-url";
// Board columns the viewer has manually COLLAPSED to a slim rail. Empty columns
// auto-collapse without being persisted (they re-open when an item lands), so
// this set holds only explicit collapses of non-empty columns.
const COLLAPSED_COLUMNS_KEY = "symphony-board:collapsed-columns";
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
