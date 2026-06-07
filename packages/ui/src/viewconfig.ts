// Persisting the Settings page's choices in localStorage — the view state the UI
// keeps across reloads (the transient facet filters stay in-memory only):
//   • hidden repos   — set of HIDDEN repoKeys (see model.repoKey)
//   • hidden sources — set of HIDDEN source_ids (an independent layer)
//   • color overrides — repoKey -> hex, this viewer's per-repo highlight override
// We store what is HIDDEN (not what is visible) so a repo/source that first
// appears in a later sync defaults to visible — "everything visible" stays the
// default as the data grows.

const KEY = "symphony-board:hidden-repos";
// Hidden SOURCES live under their own key on purpose: a source is an independent
// visibility layer, so toggling one never touches the remembered per-repo set.
const SOURCES_KEY = "symphony-board:hidden-sources";
// Per-repo color OVERRIDE: repoKey -> hex. Stored as an object (repoKey is a
// JSON-string tuple, a valid object key); a repo absent here inherits from config.
const COLORS_KEY = "symphony-board:repo-colors";

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

export function loadColorOverrides(): Map<string, string> {
  try {
    const raw = localStorage.getItem(COLORS_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out.set(k, v);
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
