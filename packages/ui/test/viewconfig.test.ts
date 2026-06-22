import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadHidden, saveHidden,
  loadHiddenSources, saveHiddenSources,
  loadCollapsedColumns, saveCollapsedColumns,
  loadColorOverrides, saveColorOverrides,
  loadDefaultRangePreset, saveDefaultRangePreset,
  loadTheme, saveTheme,
  loadDefaultTab, saveDefaultTab,
  loadLiveTabEnabled, saveLiveTabEnabled,
  loadLivePulseOpen, saveLivePulseOpen,
  loadBoardScope, saveBoardScope, boardScopeDays, defaultBoardScope, isBoardScope, presetExceedsBoardScope, clampDefaultRangeToBoardScope,
  loadWideLayout, saveWideLayout,
  loadHiddenEventTypes, saveHiddenEventTypes,
  defaultServerBaseUrlForRuntime,
  loadServerBaseUrl, saveServerBaseUrl, normalizeServerBaseUrl,
} from "../src/viewconfig.ts";
import { TIME_RANGE_PRESETS } from "../src/model.ts";

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

test("theme is a device-local setting with night owl as the default", () => {
  assert.equal(loadTheme(), "night-owl");
  saveTheme("paper");
  assert.equal(loadTheme(), "paper");
  saveTheme("night-owl");
  assert.equal(loadTheme(), "night-owl");
  store._raw("symphony-board:theme", "unknown-theme");
  assert.equal(loadTheme(), "night-owl", "invalid value -> default");
});

test("default tab is a device-local setting defaulting to Live", () => {
  assert.equal(loadDefaultTab(), "live"); // factory default
  saveDefaultTab("activity");
  assert.equal(loadDefaultTab(), "activity");
  saveDefaultTab("board");
  assert.equal(loadDefaultTab(), "board");
  store._raw("symphony-board:default-tab", "settings"); // not an offered landing tab
  assert.equal(loadDefaultTab(), "live", "non-offered / invalid value -> default");
});

test("live tab enabled is a device-local setting that is OFF by default", () => {
  assert.equal(loadLiveTabEnabled(), false, "default: Live tab disabled (no SSE, hidden tab)");
  saveLiveTabEnabled(true);
  assert.equal(loadLiveTabEnabled(), true);
  saveLiveTabEnabled(false);
  assert.equal(loadLiveTabEnabled(), false);
  // Hand-edited / stale garbage falls back to the safe OFF default.
  store._raw("symphony-board:live-tab-enabled", "yes");
  assert.equal(loadLiveTabEnabled(), false, "non-boolean value -> default off");
});

test("live metrics disclosure is a device-local setting that is OPEN by default", () => {
  assert.equal(loadLivePulseOpen(), true, "default: metrics cards expanded (no stored value)");
  saveLivePulseOpen(false);
  assert.equal(loadLivePulseOpen(), false, "an explicit collapse is remembered across reopens");
  saveLivePulseOpen(true);
  assert.equal(loadLivePulseOpen(), true);
  // Only the exact strings round-trip; any other stored value reads as collapsed
  // (the strict !== "true" rule), never throws.
  store._raw("symphony-board:live-pulse-open", "yes");
  assert.equal(loadLivePulseOpen(), false, "non-boolean stored value -> collapsed");
});

test("boardScopeDays stays in lockstep with the matching TIME_RANGE_PRESETS day counts", () => {
  // boardScopeDays hand-maps a windowed scope to trailing days; the same day
  // counts are independently declared by the rolling quick-range presets in
  // model.ts. The two live in different files, so pin the overlapping ids equal to
  // catch drift (e.g. tuning a preset's `days`) before it desyncs a windowed fetch
  // from the matching on-page preset. (1d/3d are board-scope-only — no preset.)
  const presetDays = (id: string) => TIME_RANGE_PRESETS.find((p) => p.id === id)?.days;
  assert.equal(boardScopeDays("7d"), presetDays("1w"), "7d window == 1w preset");
  assert.equal(boardScopeDays("1mo"), presetDays("1mo"));
  assert.equal(boardScopeDays("3mo"), presetDays("3mo"));
  assert.equal(boardScopeDays("6mo"), presetDays("6mo"));
  assert.equal(boardScopeDays("1y"), presetDays("1y"));
});

test("board scope is a device-local setting with off/window/full semantics", () => {
  // Day-count mapping: only the windowed scopes are a /api/range window; off/full
  // are not (they load nothing / the full contract respectively).
  assert.equal(boardScopeDays("off"), null);
  assert.equal(boardScopeDays("full"), null);
  assert.equal(boardScopeDays("1d"), 1);
  assert.equal(boardScopeDays("3d"), 3);
  assert.equal(boardScopeDays("7d"), 7);
  assert.equal(boardScopeDays("1mo"), 30);
  assert.equal(boardScopeDays("3mo"), 90);
  assert.equal(boardScopeDays("6mo"), 180);
  assert.equal(boardScopeDays("1y"), 365);
  // Per-client default: Android (weak e-ink hardware) starts on a 7-day window;
  // every other client keeps the full board.
  assert.equal(defaultBoardScope("android"), "7d");
  assert.equal(defaultBoardScope("desktop"), "full");
  assert.equal(defaultBoardScope(null), "full");
  // Round-trip + the type guard.
  assert.equal(isBoardScope("7d"), true);
  assert.equal(isBoardScope("2w"), false);
  // No client kind in the test env -> the non-Android default ("full").
  assert.equal(loadBoardScope(), "full", "default with no stored value and no Android client kind");
  saveBoardScope("3d");
  assert.equal(loadBoardScope(), "3d");
  saveBoardScope("off");
  assert.equal(loadBoardScope(), "off");
  // Hand-edited / stale garbage falls back to the default.
  store._raw("symphony-board:board-scope", "5d");
  assert.equal(loadBoardScope(), "full", "invalid stored value -> default");
});

test("presetExceedsBoardScope flags only ranges larger than the Board data window", () => {
  const now = Date.parse("2026-06-08T12:00:00Z"); // a Monday
  assert.equal(presetExceedsBoardScope("3mo", "1mo", now), true, "3mo is larger than a 1mo board");
  assert.equal(presetExceedsBoardScope("1y", "3mo", now), true);
  assert.equal(presetExceedsBoardScope("1w", "1mo", now), false, "1w fits inside a 1mo board");
  assert.equal(presetExceedsBoardScope("1mo", "1mo", now), false, "1mo exactly fits a 1mo board");
  assert.equal(presetExceedsBoardScope("today", "1d", now), false);
  // Full / off have no window ceiling, so no preset is ever out of range.
  assert.equal(presetExceedsBoardScope("3mo", "full", now), false, "Full board has no ceiling");
  assert.equal(presetExceedsBoardScope("3mo", "off", now), false, "Off has no board to bound");
});

test("clampDefaultRangeToBoardScope shrinks an oversized default to fit, leaving smaller ones alone", () => {
  const now = Date.parse("2026-06-08T12:00:00Z");
  // Larger than the window -> pulled down: Board 1y -> 1mo clamps a 3mo default to 1mo.
  assert.equal(clampDefaultRangeToBoardScope("3mo", "1mo", now), "1mo");
  // Already within the window -> untouched (no auto-grow, no needless shrink).
  assert.equal(clampDefaultRangeToBoardScope("1w", "1mo", now), "1w");
  assert.equal(clampDefaultRangeToBoardScope("3mo", "1y", now), "3mo");
  // Full board and Off have no window to bound, so they never clamp.
  assert.equal(clampDefaultRangeToBoardScope("1y", "full", now), "1y");
  assert.equal(clampDefaultRangeToBoardScope("1y", "off", now), "1y", "off has no board to clamp");
  // A window with no exact preset (3d) clamps to the largest preset that still fits.
  // On this Monday that is "this week" (Sun–Mon, 2 days, inside the 3-day window);
  // today/yesterday also fit but are smaller. Pin the value so the calendar-vs-rolling
  // tie-break is documented, and confirm the result itself fits the window.
  const clamped3d = clampDefaultRangeToBoardScope("3mo", "3d", now);
  assert.equal(clamped3d, "this-week", "largest preset that fits a 3d window on a Monday");
  assert.equal(presetExceedsBoardScope(clamped3d, "3d", now), false, "the clamped default fits the 3d window");
});

test("wide layout is a device-local setting that is OFF by default", () => {
  assert.equal(loadWideLayout(), false, "default: responsive layout (no stored value)");
  saveWideLayout(true);
  assert.equal(loadWideLayout(), true, "an explicit wide-layout choice is remembered across reopens");
  saveWideLayout(false);
  assert.equal(loadWideLayout(), false);
  // Only the exact string "true" enables it, so a stale / hand-edited value reads as off.
  store._raw("symphony-board:wide-layout", "yes");
  assert.equal(loadWideLayout(), false, "non-boolean stored value -> off");
});

test("hidden event types round-trip and default to nothing hidden (all visible)", () => {
  assert.deepEqual([...loadHiddenEventTypes()], [], "default: no category hidden");
  saveHiddenEventTypes(new Set(["commit", "pipeline"]));
  assert.deepEqual([...loadHiddenEventTypes()].sort(), ["commit", "pipeline"]);
  // Its own key — writing it never disturbs the hidden-repos / hidden-sources layers.
  saveHidden(new Set(["o/r"]));
  assert.deepEqual([...loadHiddenEventTypes()].sort(), ["commit", "pipeline"]);
  saveHiddenEventTypes(new Set());
  assert.deepEqual([...loadHiddenEventTypes()], []);
  // Malformed / non-array storage degrades to empty (everything visible).
  store._raw("symphony-board:hidden-event-types", "{not json");
  assert.deepEqual([...loadHiddenEventTypes()], [], "malformed -> empty");
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

test("Tauri host defaults split desktop and Android shells", () => {
  assert.equal(defaultServerBaseUrlForRuntime(null, false), null, "web stays same-origin by default");
  assert.equal(defaultServerBaseUrlForRuntime(null, true), "http://localhost:8080/", "desktop shell keeps the local Docker default");
  assert.equal(defaultServerBaseUrlForRuntime("desktop", true), "http://localhost:8080/", "explicit desktop keeps the local Docker default");
  assert.equal(defaultServerBaseUrlForRuntime("android", true), null, "Android shell requires a configured or user-entered server URL");
});

test("loaders/savers swallow a throwing Storage (unavailable / over quota)", () => {
  const boom = new Proxy({}, { get() { throw new Error("storage disabled"); } });
  (globalThis as { localStorage?: unknown }).localStorage = boom;
  assert.deepEqual([...loadHidden()], [], "load degrades to empty");
  assert.deepEqual([...loadCollapsedColumns()], [], "collapsed columns degrade to empty");
  assert.equal(loadColorOverrides().size, 0, "load degrades to no overrides");
  assert.equal(loadDefaultRangePreset(), "this-week", "load degrades to default range");
  assert.equal(loadTheme(), "night-owl", "theme load degrades to default");
  assert.equal(loadServerBaseUrl(), null, "load degrades to same-origin");
  assert.equal(loadLiveTabEnabled(), false, "live-tab-enabled load degrades to off");
  assert.equal(loadLivePulseOpen(), true, "live-pulse-open load degrades to the open default");
  assert.equal(loadBoardScope(), "full", "board scope load degrades to the full default");
  assert.equal(loadWideLayout(), false, "wide layout load degrades to off");
  assert.deepEqual([...loadHiddenEventTypes()], [], "hidden event types degrade to empty");
  assert.doesNotThrow(() => saveHidden(new Set(["x"])), "save swallows the error");
  assert.doesNotThrow(() => saveLiveTabEnabled(true));
  assert.doesNotThrow(() => saveLivePulseOpen(false));
  assert.doesNotThrow(() => saveBoardScope("7d"));
  assert.doesNotThrow(() => saveWideLayout(true));
  assert.doesNotThrow(() => saveHiddenEventTypes(new Set(["commit"])));
  assert.doesNotThrow(() => saveHiddenSources(new Set(["y"])));
  assert.doesNotThrow(() => saveCollapsedColumns(new Set(["in_progress"])));
  assert.doesNotThrow(() => saveColorOverrides(new Map([["o/r", "#fff"]])));
  assert.doesNotThrow(() => saveDefaultRangePreset("3mo"));
  assert.doesNotThrow(() => saveTheme("paper"));
  assert.doesNotThrow(() => saveServerBaseUrl("http://localhost:8080"));
});
