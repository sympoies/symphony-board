import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadHidden, saveHidden,
  loadHiddenSources, saveHiddenSources,
  loadCollapsedColumns, saveCollapsedColumns,
  loadColorOverrides, saveColorOverrides,
  loadDefaultRangePreset, saveDefaultRangePreset,
  loadServerBaseUrl, saveServerBaseUrl, normalizeServerBaseUrl,
} from "../src/viewconfig.ts";

// viewconfig persists Settings choices to localStorage. node has no DOM, so we
// install a tiny in-memory Storage shim and (for the failure paths) a throwing
// one — the module is written to degrade to "everything visible / no overrides"
// when storage is unavailable or hand-edited into garbage.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  // Test seam: write a raw value to mimic stale / hand-edited storage.
  _raw(k: string, v: string): void { this.m.set(k, v); }
}
let store: MemStorage;
beforeEach(() => {
  store = new MemStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
});

test("hidden repos/sources round-trip and are independent layers", () => {
  assert.deepEqual([...loadHidden()], [], "default: nothing hidden (everything visible)");
  saveHidden(new Set(["o/r", "o/s"]));
  saveHiddenSources(new Set(["github:github.com"]));
  assert.deepEqual([...loadHidden()].sort(), ["o/r", "o/s"]);
  assert.deepEqual([...loadHiddenSources()], ["github:github.com"]);
  // Toggling one layer leaves the other untouched.
  saveHidden(new Set());
  assert.deepEqual([...loadHidden()], []);
  assert.deepEqual([...loadHiddenSources()], ["github:github.com"]);
});

test("collapsed columns round-trip and are independent from the hidden layers", () => {
  assert.deepEqual([...loadCollapsedColumns()], [], "default: no column collapsed");
  saveCollapsedColumns(new Set(["in_progress", "lane-pr"]));
  assert.deepEqual([...loadCollapsedColumns()].sort(), ["in_progress", "lane-pr"]);
  // Its own key — writing the hidden-repos layer never disturbs it.
  saveHidden(new Set(["o/r"]));
  assert.deepEqual([...loadCollapsedColumns()].sort(), ["in_progress", "lane-pr"]);
  saveCollapsedColumns(new Set());
  assert.deepEqual([...loadCollapsedColumns()], []);
});

test("loadHidden tolerates malformed / non-array / non-string storage", () => {
  store._raw("symphony-board:hidden-repos", "{not json");
  assert.deepEqual([...loadHidden()], [], "malformed JSON -> empty");
  store._raw("symphony-board:hidden-repos", JSON.stringify({ nope: 1 }));
  assert.deepEqual([...loadHidden()], [], "non-array -> empty");
  store._raw("symphony-board:hidden-repos", JSON.stringify(["ok", 7, null, "two"]));
  assert.deepEqual([...loadHidden()].sort(), ["ok", "two"], "non-strings filtered out");
});

test("color overrides keep only valid hex and round-trip", () => {
  assert.equal(loadColorOverrides().size, 0);
  saveColorOverrides(new Map([["o/r", "#1f6feb"], ["o/s", "#abc"]]));
  const loaded = loadColorOverrides();
  assert.equal(loaded.get("o/r"), "#1f6feb");
  assert.equal(loaded.get("o/s"), "#abc");
  // Hand-edited garbage / non-hex / non-object are dropped (the value reaches a CSS sink).
  store._raw("symphony-board:repo-colors", JSON.stringify({ "o/r": "#1f6feb", "o/bad": "red", "o/x": 5 }));
  const filtered = loadColorOverrides();
  assert.deepEqual([...filtered.entries()], [["o/r", "#1f6feb"]], "only valid hex survives");
  store._raw("symphony-board:repo-colors", JSON.stringify(["array", "not", "object"]));
  assert.equal(loadColorOverrides().size, 0, "non-object -> empty");
  store._raw("symphony-board:repo-colors", "{bad");
  assert.equal(loadColorOverrides().size, 0, "malformed -> empty");
});

test("default range preset falls back to this week and round-trips valid preset ids", () => {
  assert.equal(loadDefaultRangePreset(), "this-week");
  saveDefaultRangePreset("today");
  assert.equal(loadDefaultRangePreset(), "today");
  store._raw("symphony-board:default-range-preset", "not-a-preset");
  assert.equal(loadDefaultRangePreset(), "this-week", "invalid value -> default");
});

test("server base URL normalizes http/https roots and rejects unsafe schemes", () => {
  assert.equal(normalizeServerBaseUrl("http://localhost:8080"), "http://localhost:8080/");
  assert.equal(normalizeServerBaseUrl("https://board.example.com/app"), "https://board.example.com/app/");
  assert.equal(normalizeServerBaseUrl("https://board.example.com/app?x=1#top"), "https://board.example.com/app/");
  assert.equal(normalizeServerBaseUrl("file:///tmp/contract.json"), null);
  assert.equal(normalizeServerBaseUrl("not a url"), null);
});

test("server base URL persists as an optional setting", () => {
  assert.equal(loadServerBaseUrl(), null);
  saveServerBaseUrl("http://localhost:8080");
  assert.equal(loadServerBaseUrl(), "http://localhost:8080/");
  saveServerBaseUrl(null);
  assert.equal(loadServerBaseUrl(), null);
});

test("loaders/savers swallow a throwing Storage (unavailable / over quota)", () => {
  const boom = new Proxy({}, { get() { throw new Error("storage disabled"); } });
  (globalThis as { localStorage?: unknown }).localStorage = boom;
  assert.deepEqual([...loadHidden()], [], "load degrades to empty");
  assert.deepEqual([...loadCollapsedColumns()], [], "collapsed columns degrade to empty");
  assert.equal(loadColorOverrides().size, 0, "load degrades to no overrides");
  assert.equal(loadDefaultRangePreset(), "this-week", "load degrades to default range");
  assert.equal(loadServerBaseUrl(), null, "load degrades to same-origin");
  assert.doesNotThrow(() => saveHidden(new Set(["x"])), "save swallows the error");
  assert.doesNotThrow(() => saveHiddenSources(new Set(["y"])));
  assert.doesNotThrow(() => saveCollapsedColumns(new Set(["in_progress"])));
  assert.doesNotThrow(() => saveColorOverrides(new Map([["o/r", "#fff"]])));
  assert.doesNotThrow(() => saveDefaultRangePreset("3mo"));
  assert.doesNotThrow(() => saveServerBaseUrl("http://localhost:8080"));
});
