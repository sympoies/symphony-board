// Pure derivations behind the Live tab's "pulse" strip and feed. The hook
// (useLive) owns the event buffer; everything the strip shows — the rolling
// rate histogram, the per-window count, category/active tallies, the relative
// age label — is computed here so the render stays a thin transcription and the
// math is unit-tested (live-stats.test.ts) rather than smoke-only.
import type { LiveEvent } from "./model.ts";

// The instant an event happened, in epoch ms: provider event time when present
// (it is the truer "when"), else the receipt time. null when neither parses.
export function eventInstant(e: LiveEvent): number | null {
  for (const iso of [e.occurred_at, e.received_at]) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// The repo bucket an event belongs to: its target's project_path, else the
// source id (a repo-less event), else null.
export function eventRepo(e: LiveEvent): string | null {
  const t = e.target;
  if (!t) return null;
  return t.project_path ?? t.source_id ?? null;
}

// Events whose instant falls within the trailing `windowMs` ending at `now`
// (boundary inclusive). Events with no parseable instant are ignored.
export function countInWindow(events: LiveEvent[], now: number, windowMs: number): number {
  const floor = now - windowMs;
  let n = 0;
  for (const e of events) {
    const t = eventInstant(e);
    if (t != null && t >= floor && t <= now) n += 1;
  }
  return n;
}

// Equal-width time buckets ending at `now`, oldest-first. The window is
// `bucketMs * bucketCount` wide ending at `now`; bucket 0 is the oldest, the
// last bucket is the current `(now-bucketMs, now]`. Events at or before the
// window start, in the future, or without an instant are dropped.
export function rateBuckets(
  events: LiveEvent[],
  now: number,
  bucketMs: number,
  bucketCount: number,
): number[] {
  const start = now - bucketMs * bucketCount;
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const e of events) {
    const t = eventInstant(e);
    if (t == null || t <= start || t > now) continue;
    let idx = Math.floor((t - start) / bucketMs);
    if (idx >= bucketCount) idx = bucketCount - 1; // t === now lands in the last bucket
    if (idx < 0) continue;
    buckets[idx] = (buckets[idx] ?? 0) + 1;
  }
  return buckets;
}

// Category → count. Categories named in `order` come first in that order (only
// those actually present); any extra category not in `order` is appended,
// sorted by count desc then name, so an unforeseen provider category still
// surfaces deterministically.
export function categoryCounts(
  events: LiveEvent[],
  order: readonly string[],
): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const out: Array<{ category: string; count: number }> = [];
  const seen = new Set<string>();
  for (const cat of order) {
    const count = counts.get(cat);
    if (count) {
      out.push({ category: cat, count });
      seen.add(cat);
    }
  }
  const extras = [...counts.entries()]
    .filter(([cat]) => !seen.has(cat))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [category, count] of extras) out.push({ category, count });
  return out;
}

// Distinct non-empty keys produced by `key`, sorted. The option lists for the
// repo / people filter dropdowns are built from these.
export function distinctValues(
  events: LiveEvent[],
  key: (e: LiveEvent) => string | null | undefined,
): string[] {
  const set = new Set<string>();
  for (const e of events) {
    const k = key(e);
    if (k) set.add(k);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Distinct non-empty keys produced by `key` across the events.
export function distinctCount(
  events: LiveEvent[],
  key: (e: LiveEvent) => string | null | undefined,
): number {
  return distinctValues(events, key).length;
}

// The feed's filter selection: category is single-select (null = any); repos and
// people are multi-select sets (empty = any).
export interface LiveFilters {
  category: string | null;
  repos: ReadonlySet<string>;
  people: ReadonlySet<string>;
}

// Does an event pass the filters? Every supplied dimension must match (AND).
export function eventMatchesFilters(e: LiveEvent, sel: LiveFilters): boolean {
  if (sel.category && e.category !== sel.category) return false;
  if (sel.repos.size) {
    const repo = eventRepo(e);
    if (!repo || !sel.repos.has(repo)) return false;
  }
  if (sel.people.size) {
    const login = e.actor?.login;
    if (!login || !sel.people.has(login)) return false;
  }
  return true;
}

// Compact relative age ("now" / "5s" / "3m" / "2h" / "4d") for a feed row or the
// "last event" readout. Clamps a future timestamp (clock skew) to "now" so it
// never renders a negative age.
export function relativeAge(fromMs: number, now: number): string {
  const diff = Math.max(0, now - fromMs);
  const secs = Math.floor(diff / 1000);
  if (secs < 1) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
