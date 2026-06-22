import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadCachedLiveSnapshot,
  saveCachedLiveSnapshot,
  removeCachedLiveSnapshot,
  LIVE_SNAPSHOT_CACHE_MAX_EVENTS,
  LIVE_SNAPSHOT_CACHE_TTL_MS,
} from "../src/live-cache.ts";
import type { LiveEvent } from "../src/model.ts";

// The Live snapshot cache lets a COLD start paint real (if stale) content
// instantly, then revalidate. node has no DOM, so install an in-memory Storage
// shim — the module must degrade to "no cache" when storage is absent or junk.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  _raw(k: string, v: string): void { this.m.set(k, v); }
  _keys(): string[] { return [...this.m.keys()]; }
}
let store: MemStorage;
beforeEach(() => {
  store = new MemStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
});

const ev = (seq: number, extra: Partial<LiveEvent> = {}): LiveEvent =>
  ({ seq, event_id: `e${seq}`, source_id: "s", provider: "github", received_at: "2026-06-22T00:00:00Z", event_type: "x", category: "commit", ...extra }) as LiveEvent;

test("a snapshot round-trips for the matching server", () => {
  const now = 1_000_000;
  saveCachedLiveSnapshot("https://srv", [ev(3), ev(2), ev(1)], 3, now);
  const got = loadCachedLiveSnapshot("https://srv", now + 1_000);
  assert.ok(got, "the cache returns the snapshot within TTL");
  assert.equal(got.max_seq, 3);
  assert.deepEqual(got.events.map((e) => e.seq), [3, 2, 1]);
  assert.ok(got.schema.startsWith("live-snapshot/1"));
});

test("a relative (server-less) cache round-trips under the null key", () => {
  const now = 5;
  saveCachedLiveSnapshot(null, [ev(1)], 1, now);
  assert.ok(loadCachedLiveSnapshot(null, now));
});

test("the cache is per-server: a different server URL is a miss", () => {
  const now = 10;
  saveCachedLiveSnapshot("https://a", [ev(1)], 1, now);
  assert.equal(loadCachedLiveSnapshot("https://b", now), null, "another server must not read the previous server's events");
  assert.equal(loadCachedLiveSnapshot(null, now), null);
});

test("an expired cache (past TTL) is dropped", () => {
  const now = 1_000_000;
  saveCachedLiveSnapshot("https://srv", [ev(1)], 1, now);
  assert.ok(loadCachedLiveSnapshot("https://srv", now + LIVE_SNAPSHOT_CACHE_TTL_MS - 1));
  assert.equal(
    loadCachedLiveSnapshot("https://srv", now + LIVE_SNAPSHOT_CACHE_TTL_MS + 1),
    null,
    "stale-beyond-TTL content is not resurrected",
  );
});

test("save caps the event count to keep storage bounded", () => {
  const many = Array.from({ length: LIVE_SNAPSHOT_CACHE_MAX_EVENTS + 50 }, (_, i) =>
    ev(LIVE_SNAPSHOT_CACHE_MAX_EVENTS + 50 - i),
  );
  saveCachedLiveSnapshot("https://srv", many, many[0]!.seq, 0);
  const got = loadCachedLiveSnapshot("https://srv", 0);
  assert.ok(got);
  assert.equal(got.events.length, LIVE_SNAPSHOT_CACHE_MAX_EVENTS, "only the newest cap is kept");
  assert.equal(got.events[0]!.seq, many[0]!.seq, "newest-first order is preserved");
});

test("save strips heavy raw payloads to stay under the storage quota", () => {
  const big = ev(1, { raw: { huge: "x".repeat(10_000) } });
  saveCachedLiveSnapshot("https://srv", [big], 1, 0);
  const got = loadCachedLiveSnapshot("https://srv", 0);
  assert.ok(got);
  assert.equal(got.events[0]!.raw ?? null, null, "raw is dropped from the cache; the fresh fetch restores it");
});

test("a missing or junk cache reads as no cache", () => {
  assert.equal(loadCachedLiveSnapshot("https://srv", 0), null, "empty storage -> null");
  store._raw("symphony-board:live-snapshot-cache", "{not json");
  assert.equal(loadCachedLiveSnapshot("https://srv", 0), null, "garbage -> null, never throws");
});

test("a well-formed entry whose snapshot fails the shape guard reads as no cache", () => {
  // Defends the seed against a forward/backward-incompatible cached snapshot: the
  // entry parses and matches the server + TTL, but the snapshot shape is invalid.
  store._raw(
    "symphony-board:live-snapshot-cache",
    JSON.stringify({ serverBaseUrl: "https://srv", cachedAt: 0, snapshot: { schema: "live-snapshot/1", events: {}, max_seq: 1 } }),
  );
  assert.equal(loadCachedLiveSnapshot("https://srv", 0), null, "bad snapshot shape -> null, never seeds from it");
});

test("saving never throws when storage is unavailable", () => {
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
  assert.doesNotThrow(() => saveCachedLiveSnapshot("https://srv", [ev(1)], 1, 0));
  assert.equal(loadCachedLiveSnapshot("https://srv", 0), null);
});

// When the first authoritative snapshot empties the buffer, useLive removes this
// server's cache so the deleted/pruned rows do not reappear on the next cold
// start until the TTL expires. The removal is server-scoped (the store holds one
// entry keyed by serverBaseUrl) so clearing one server never wipes another's.
test("removeCachedLiveSnapshot drops this server's entry so a now-empty feed is not resurrected", () => {
  saveCachedLiveSnapshot("https://srv", [ev(2), ev(1)], 2, 0);
  assert.ok(loadCachedLiveSnapshot("https://srv", 0), "precondition: the cache exists");
  removeCachedLiveSnapshot("https://srv");
  assert.equal(loadCachedLiveSnapshot("https://srv", 0), null, "the stale cache is gone after removal");
});

test("removeCachedLiveSnapshot only clears the matching server, never another server's cache", () => {
  saveCachedLiveSnapshot("https://a", [ev(1)], 1, 0);
  removeCachedLiveSnapshot("https://b");
  assert.ok(loadCachedLiveSnapshot("https://a", 0), "removing server B must not wipe server A's entry");
  removeCachedLiveSnapshot("https://a");
  assert.equal(loadCachedLiveSnapshot("https://a", 0), null);
});

test("removeCachedLiveSnapshot is a no-op when absent and never throws on bad storage", () => {
  assert.doesNotThrow(() => removeCachedLiveSnapshot("https://srv"));
  // A present-but-malformed entry: the JSON.parse throw is swallowed and the
  // junk is left untouched (the loader already reads it as no-cache).
  store._raw("symphony-board:live-snapshot-cache", "{not json");
  assert.doesNotThrow(() => removeCachedLiveSnapshot("https://srv"));
  assert.equal(store.getItem("symphony-board:live-snapshot-cache"), "{not json", "a malformed entry never throws and is left as-is");
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
  assert.doesNotThrow(() => removeCachedLiveSnapshot("https://srv"));
});
