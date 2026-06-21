// Pure derivations behind the Live tab's "pulse" strip and feed. The hook
// (useLive) owns the event buffer; everything the strip shows — the rolling
// rate histogram, the per-window count, category/active tallies, the relative
// age label — is computed here so the render stays a thin transcription and the
// math is unit-tested (live-stats.test.ts) rather than smoke-only.
import type { LiveEvent, LiveEventActor } from "./model.ts";

// Provider-neutral category order for the Live filter strip and the Settings
// "which event types to show" toggles (see LiveEvent.category in model.ts). The
// strip orders known categories by this list and appends any unforeseen one
// (categoryCounts); Settings offers exactly these as toggleable. Shared here so
// the feed, the strip, and the Settings checkboxes agree on the vocabulary.
export const LIVE_CATEGORY_ORDER = [
  "commit",
  "change_request",
  "issue",
  "review",
  "review_comment",
  "review_thread",
  "comment",
  "pipeline",
] as const;

// A category's display label: the snake_case id with underscores as spaces
// ("change_request" -> "change request"). Shared by the feed, the filter chips,
// and the Settings toggles so one category never reads two different ways.
export const humanizeCategory = (c: string): string => c.replace(/_/g, " ");

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

// The wall-clock window a `rateBuckets` index covers, for the same
// `(now, bucketMs, bucketCount)`. The last bucket ends exactly at `now`; each
// earlier bucket is one `bucketMs` older. Used to label a sparkline bar with its
// time range. (Mirrors the index math in `rateBuckets`.)
export function bucketRange(
  now: number,
  bucketMs: number,
  bucketCount: number,
  index: number,
): { start: number; end: number } {
  const end = now - (bucketCount - 1 - index) * bucketMs;
  return { start: end - bucketMs, end };
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

// The Live tab's persistent "which event types to show" filter: the events whose
// category the viewer has NOT hidden (Settings-controlled, see
// viewconfig.loadHiddenEventTypes). Applied tab-wide before the transient
// category/repo/people focus filters, so it scopes the feed AND the chip strip.
// An empty hidden set returns the SAME array (the common case allocates nothing).
export function visibleByCategory(
  events: LiveEvent[],
  hiddenCategories: ReadonlySet<string>,
): LiveEvent[] {
  if (hiddenCategories.size === 0) return events;
  return events.filter((e) => !hiddenCategories.has(e.category));
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

// The stable identity key for an actor in the people filter / count / options:
// the GitHub login when present, else the display name. A pushed commit whose
// author email GitHub could not resolve to an account has a display_name but no
// login — keying on login alone would drop it from the People controls even
// though it shows in the feed. null when neither is present. The same key MUST
// back the options, the count, and eventMatchesFilters so a selected option
// always matches the events it was derived from.
export function actorKey(e: LiveEvent): string | null {
  return e.actor?.login ?? e.actor?.display_name ?? null;
}

export interface LiveActorRank {
  key: string;
  label: string;
  count: number;
  actor: LiveEventActor | null;
}

export interface LiveRepoRank {
  key: string;
  label: string;
  count: number;
}

function actorLabel(actor: LiveEventActor | null | undefined, key: string): string {
  return actor?.display_name ?? actor?.login ?? key;
}

function richerActor(a: LiveEventActor | null, b: LiveEventActor | null | undefined): LiveEventActor | null {
  if (!b) return a;
  if (!a) return b;
  const score = (actor: LiveEventActor) =>
    (actor.avatar_url ? 4 : 0) +
    (actor.profile_url ? 2 : 0) +
    (actor.display_name ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

export function actorActivityRanks(events: LiveEvent[], limit = 5): LiveActorRank[] {
  const ranks = new Map<string, LiveActorRank>();
  for (const e of events) {
    const key = actorKey(e);
    if (!key) continue;
    const prev = ranks.get(key);
    if (!prev) {
      ranks.set(key, { key, label: actorLabel(e.actor, key), count: 1, actor: e.actor ?? null });
      continue;
    }
    const actor = richerActor(prev.actor, e.actor);
    ranks.set(key, {
      ...prev,
      count: prev.count + 1,
      actor,
      label: actorLabel(actor, key),
    });
  }
  return [...ranks.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

export function repoActivityRanks(events: LiveEvent[], limit = 5): LiveRepoRank[] {
  const ranks = new Map<string, LiveRepoRank>();
  for (const e of events) {
    const key = eventRepo(e);
    if (!key) continue;
    const prev = ranks.get(key);
    if (!prev) {
      ranks.set(key, { key, label: key, count: 1 });
      continue;
    }
    ranks.set(key, { ...prev, count: prev.count + 1 });
  }
  return [...ranks.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
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
    const key = actorKey(e);
    if (!key || !sel.people.has(key)) return false;
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
