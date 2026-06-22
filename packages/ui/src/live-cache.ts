// Per-server, device-local cache of the last Live snapshot. It lets a COLD start
// paint real (if stale) content the instant the Live page mounts — before any
// network round-trip resolves — then revalidate from the live receiver. This is
// what removes the empty "Connecting…" gap on launch: the feed shows the last
// known events immediately. The cache is a DISPLAY accelerator only — the first
// authoritative snapshot always re-fetches in full and REPLACES the cached rows
// wholesale (planSnapshotFold's "replace" branch), so a cached row the server no
// longer returns cannot linger; the cache cursor is not used to skip the fetch.
//
// Stored as ONE entry keyed by the active serverBaseUrl, so switching servers (or
// an Android client with no server) never reads another server's events. Capped
// and stripped of heavy `raw` payloads to stay well under the localStorage quota;
// the fresh fetch restores full fidelity within seconds. All DOM/storage access is
// guarded so importing or calling this in a non-browser test is a safe no-op.
import { isLiveSnapshot } from "./contract.ts";
import type { LiveEvent, LiveSnapshot } from "./model.ts";

const CACHE_KEY = "symphony-board:live-snapshot-cache";

// Newest events to retain in the cache. The live buffer holds up to 1000; the
// cold-start view only needs the most recent window, and a smaller cap keeps the
// serialized entry small even with rich event bodies.
export const LIVE_SNAPSHOT_CACHE_MAX_EVENTS = 300;
// Ignore a cache older than this so a long-dormant client does not flash
// genuinely ancient events before the fresh fetch lands. The live store itself
// retains ~30 days; a one-day display freshness window is conservative.
export const LIVE_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface LiveSnapshotCacheEntry {
  serverBaseUrl: string | null;
  cachedAt: number;
  snapshot: LiveSnapshot;
}

// The events the list view needs, minus the heavy raw webhook payload (the
// single biggest field). The detail view's full payload is restored by the fresh
// fetch that lands seconds later.
function trimEventForCache(ev: LiveEvent): LiveEvent {
  return ev.raw == null ? ev : { ...ev, raw: null };
}

// Read the cached snapshot for `serverBaseUrl`, or null when absent, for a
// different server, expired, or malformed. `now` is injectable for tests.
export function loadCachedLiveSnapshot(
  serverBaseUrl: string | null,
  now: number = Date.now(),
): LiveSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as LiveSnapshotCacheEntry;
    if ((entry.serverBaseUrl ?? null) !== (serverBaseUrl ?? null)) return null;
    if (typeof entry.cachedAt !== "number" || !Number.isFinite(entry.cachedAt)) return null;
    if (now - entry.cachedAt > LIVE_SNAPSHOT_CACHE_TTL_MS) return null;
    return isLiveSnapshot(entry.snapshot) ? entry.snapshot : null;
  } catch {
    return null;
  }
}

// Persist the current live buffer (newest-first) as the cache for `serverBaseUrl`.
// Silent on any failure (storage unavailable / over quota) — the cache is a
// best-effort accelerator, never a correctness dependency. `now` is injectable.
export function saveCachedLiveSnapshot(
  serverBaseUrl: string | null,
  events: readonly LiveEvent[],
  maxSeq: number,
  now: number = Date.now(),
): void {
  try {
    const kept = events.slice(0, LIVE_SNAPSHOT_CACHE_MAX_EVENTS).map(trimEventForCache);
    const entry: LiveSnapshotCacheEntry = {
      serverBaseUrl: serverBaseUrl ?? null,
      cachedAt: now,
      snapshot: {
        schema: "live-snapshot/1",
        events: kept,
        max_seq: maxSeq,
        // The cache loader keys freshness off cachedAt, not this field; carry the
        // newest event's timestamp so the shape is a faithful LiveSnapshot.
        generated_at: kept[0]?.received_at ?? "",
      },
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* storage unavailable / over quota — the cache just won't persist this time */
  }
}
