// Persisting the Settings page's repo-visibility choice in localStorage — the
// one bit of view state the UI keeps across reloads. Everything else (the
// transient facet filters) is in-memory only. We store the set of HIDDEN repo
// keys (see model.repoKey), not the visible set, so a repo that first appears in
// a later sync defaults to visible — "everything visible" stays the default.

const KEY = "symphony-board:hidden-repos";

export function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set(); // unavailable / malformed storage — start with everything visible
  }
}

export function saveHidden(hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
  } catch {
    /* storage unavailable / over quota — the choice just won't persist */
  }
}
