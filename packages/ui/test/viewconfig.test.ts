import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadHidden, saveHidden,
  loadHiddenSources, saveHiddenSources,
  loadCollapsedColumns, saveCollapsedColumns,
  loadColorOverrides, saveColorOverrides,
  loadDefaultRangePreset, saveDefaultRangePreset,
  loadColorMode, saveColorMode, resolveViewTheme, subscribeSystemColorScheme, systemPrefersDark, SYSTEM_DARK_MODE_QUERY,
  loadDefaultTab, saveDefaultTab,
  loadLiveTabEnabled, saveLiveTabEnabled,
  loadLivePulseOpen, saveLivePulseOpen,
  loadBoardScope, saveBoardScope, defaultBoardScope,
  isStaticDeployment, liveControlsDisabled, effectiveLiveTabEnabled,
  deviceCeilingDays, clampRangeToCeiling, isDefaultWindowRange, usesStaticContractFastPath, defaultRangePresetForClient,
  loadLastContractTimezone, saveLastContractTimezone,
  loadWideLayout, saveWideLayout,
  loadHiddenEventTypes, saveHiddenEventTypes,
  defaultServerBaseUrlForRuntime,
  loadServerBaseUrl, saveServerBaseUrl, normalizeServerBaseUrl,
} from "../src/viewconfig.ts";
import { cutoffIso, timeRangeForPreset } from "../src/model.ts";
import type { ContractEnvelope } from "@symphony-board/contract";

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

test("color mode is a device-local setting with system as the default", () => {
  assert.equal(loadColorMode(), "system");
  assert.equal(resolveViewTheme("system", true), "night-owl");
  assert.equal(resolveViewTheme("system", false), "paper");
  saveColorMode("light");
  assert.equal(loadColorMode(), "light");
  assert.equal(resolveViewTheme("light", true), "paper");
  saveColorMode("dark");
  assert.equal(loadColorMode(), "dark");
  assert.equal(resolveViewTheme("dark", false), "night-owl");
  store._raw("symphony-board:theme", "paper");
  assert.equal(loadColorMode(), "light", "legacy Paper theme value -> Light mode");
  store._raw("symphony-board:theme", "night-owl");
  assert.equal(loadColorMode(), "dark", "legacy Night Owl theme value -> Dark mode");
  store._raw("symphony-board:theme", "unknown-theme");
  assert.equal(loadColorMode(), "system", "invalid value -> default");
});

test("system color-scheme helpers support legacy Android WebView matchMedia listeners", () => {
  let matches = false;
  const listeners = new Set<() => void>();
  const media = {
    get matches() { return matches; },
    addListener(listener: () => void) { listeners.add(listener); },
    removeListener(listener: () => void) { listeners.delete(listener); },
  } as unknown as MediaQueryList;
  const target = {
    matchMedia(query: string) {
      assert.equal(query, SYSTEM_DARK_MODE_QUERY);
      return media;
    },
  };
  const seen: boolean[] = [];

  assert.equal(systemPrefersDark(target), false);
  const cleanup = subscribeSystemColorScheme((prefersDark) => seen.push(prefersDark), target);
  assert.equal(listeners.size, 1, "legacy addListener path subscribed");
  assert.deepEqual(seen, [false], "subscription emits the initial value");

  matches = true;
  for (const listener of listeners) listener();
  assert.deepEqual(seen, [false, true], "legacy listener emits changed value");

  cleanup?.();
  assert.equal(listeners.size, 0, "cleanup removes legacy listener");
  matches = false;
  for (const listener of listeners) listener();
  assert.deepEqual(seen, [false, true], "cleanup stops future emissions");
});

test("default tab is a device-local setting defaulting to Live", () => {
  assert.equal(loadDefaultTab(), "live"); // factory default
  saveDefaultTab("activity");
  assert.equal(loadDefaultTab(), "activity");
  saveDefaultTab("items");
  assert.equal(loadDefaultTab(), "items");
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

test("board scope is a device-local on/off setting; legacy window values normalize to on", () => {
  // The selected range now controls download size; Board data only toggles on/off.
  assert.equal(defaultBoardScope("android"), "full");
  assert.equal(defaultBoardScope("desktop"), "full");
  assert.equal(defaultBoardScope(null), "full");
  // No client kind in the test env -> the non-Android default ("full").
  assert.equal(loadBoardScope(), "full", "default with no stored value and no Android client kind");
  saveBoardScope("off");
  assert.equal(loadBoardScope(), "off");
  saveBoardScope("full");
  assert.equal(loadBoardScope(), "full");
  // Hand-edited / legacy window values from the old 9-value model mean "on".
  for (const legacy of ["1d", "3d", "7d", "1mo", "3mo", "6mo", "1y", "5d"]) {
    store._raw("symphony-board:board-scope", legacy);
    assert.equal(loadBoardScope(), "full", `${legacy} -> full`);
  }
  // Stale garbage also falls back to the default.
  store._raw("symphony-board:board-scope", "wat");
  assert.equal(loadBoardScope(), "full", "invalid stored value -> default");
});

test("liveControlsDisabled disables the Live preferences only on a static, server-less deployment (Pages demo)", () => {
  // Live needs a running receiver (the SSE/snapshot server). A static host (the
  // GitHub Pages demo) has none, so the Live tab can never appear there and
  // toggling it is a no-op trap — the Settings Live controls must render disabled,
  // the same way the date range suspends on a static host. Every normal
  // deployment (Docker web / standalone / Android) keeps them interactive.
  assert.equal(liveControlsDisabled(true), true, "static deployment disables the Live controls");
  assert.equal(liveControlsDisabled(false), false, "a normal server-backed deployment keeps them interactive");
});

test("effectiveLiveTabEnabled forces a stored Live opt-in OFF on a static, server-less deployment", () => {
  // A static host (the Pages demo) has no live receiver, so the Settings Live
  // controls render disabled — but a stale `live-tab-enabled=true` in localStorage
  // must not leak past that UI, or App would still probe ./api/live-snapshot (404),
  // show the Live tab, and bounce off a dead #/live. The effective opt-in App routes
  // on is the stored flag AND a non-static deployment.
  assert.equal(effectiveLiveTabEnabled(true, false), true, "stored opt-in stays on for a normal server-backed deployment");
  assert.equal(effectiveLiveTabEnabled(true, true), false, "a stale stored opt-in is coerced off on a static deployment");
  assert.equal(effectiveLiveTabEnabled(false, false), false, "no stored opt-in is off");
  assert.equal(effectiveLiveTabEnabled(false, true), false, "no stored opt-in is off on a static deployment too");
});

test("isStaticDeployment defaults to false without the VITE flag (the safe default for every non-Pages build)", () => {
  // import.meta.env is absent under the node test runner (no Vite injection), the
  // same as any deployment that does not set VITE_SYMPHONY_BOARD_STATIC — so the
  // overlay-suppression must NOT engage by default, leaving Docker web / standalone /
  // Android on the historical server-projection path.
  assert.equal(isStaticDeployment(), false);
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
  assert.equal(loadColorMode(), "system", "color mode load degrades to default");
  assert.equal(loadServerBaseUrl(), null, "load degrades to same-origin");
  assert.equal(loadLiveTabEnabled(), false, "live-tab-enabled load degrades to off");
  assert.equal(loadLivePulseOpen(), true, "live-pulse-open load degrades to the open default");
  assert.equal(loadBoardScope(), "full", "board scope load degrades to the full default");
  assert.equal(loadLastContractTimezone(null), null, "last contract timezone load degrades to unknown");
  assert.equal(loadWideLayout(), false, "wide layout load degrades to off");
  assert.deepEqual([...loadHiddenEventTypes()], [], "hidden event types degrade to empty");
  assert.doesNotThrow(() => saveHidden(new Set(["x"])), "save swallows the error");
  assert.doesNotThrow(() => saveLiveTabEnabled(true));
  assert.doesNotThrow(() => saveLivePulseOpen(false));
  assert.doesNotThrow(() => saveBoardScope("full"));
  assert.doesNotThrow(() => saveLastContractTimezone(null, "Asia/Taipei"));
  assert.doesNotThrow(() => saveWideLayout(true));
  assert.doesNotThrow(() => saveHiddenEventTypes(new Set(["commit"])));
  assert.doesNotThrow(() => saveHiddenSources(new Set(["y"])));
  assert.doesNotThrow(() => saveCollapsedColumns(new Set(["in_progress"])));
  assert.doesNotThrow(() => saveColorOverrides(new Map([["o/r", "#fff"]])));
  assert.doesNotThrow(() => saveDefaultRangePreset("3mo"));
  assert.doesNotThrow(() => saveColorMode("light"));
  assert.doesNotThrow(() => saveServerBaseUrl("http://localhost:8080"));
});

// --- range-as-download primitives (#488) ------------------------------------
// A fixed reference instant so the trailing-window math is deterministic in CI.
const REF_NOW = Date.parse("2026-06-26T12:00:00.000Z");

test("defaultRangePresetForClient lands Android on a 7-day window and everything else on this week (#488)", () => {
  assert.equal(defaultRangePresetForClient("android"), "1w", "Android weak-device small landing");
  assert.equal(defaultRangePresetForClient("desktop"), "this-week");
  assert.equal(defaultRangePresetForClient(null), "this-week", "no client kind -> desktop default");
});

test("deviceCeilingDays caps Android at 30 days and everything else at a year", () => {
  assert.equal(deviceCeilingDays("android"), 30, "Android weak-device guard");
  assert.equal(deviceCeilingDays("desktop"), 365);
  assert.equal(deviceCeilingDays(null), 365, "no client kind -> desktop default");
});

test("clampRangeToCeiling pulls a too-wide range's start up to the ceiling, leaving the end and in-range windows untouched", () => {
  // A 1-year request on Android (30-day ceiling) is clamped to the trailing 30 days.
  const wide = { from: "2025-06-26", to: "2026-06-26" };
  const clamped = clampRangeToCeiling(wide, 30, REF_NOW, "UTC");
  assert.equal(clamped.to, "2026-06-26", "the end is never moved");
  assert.equal(clamped.from, timeRangeForPreset("1mo", REF_NOW, "UTC").from, "from pulled up to the 30-day floor");
  // A request already inside the ceiling is returned unchanged.
  const narrow = { from: "2026-06-20", to: "2026-06-26" };
  assert.deepEqual(clampRangeToCeiling(narrow, 30, REF_NOW, "UTC"), narrow);
  // A null ceiling (desktop) never clamps.
  assert.deepEqual(clampRangeToCeiling(wide, null, REF_NOW, "UTC"), wide);
});

test("clampRangeToCeiling never returns an inverted range for an all-historical selection", () => {
  const historical = { from: "2026-01-01", to: "2026-01-10" };
  const clamped = clampRangeToCeiling(historical, 30, REF_NOW, "UTC");
  assert.deepEqual(clamped, { from: "2026-05-28", to: "2026-05-28" });
  assert.ok(clamped.from <= clamped.to, "from <= to");
});

test("isDefaultWindowRange recognises exactly the producer active-since window (the static contract fast-path)", () => {
  const staticWindow = { from: cutoffIso(90, REF_NOW).slice(0, 10), to: "2026-06-26" };
  const rollingPreset = timeRangeForPreset("3mo", REF_NOW, "UTC");
  assert.equal(isDefaultWindowRange(staticWindow, REF_NOW, "UTC"), true, "the producer cutoff window takes the fast-path");
  assert.equal(isDefaultWindowRange(rollingPreset, REF_NOW, "UTC"), false, "the inclusive 90-day picker preset is one day narrower");
  assert.equal(isDefaultWindowRange(timeRangeForPreset("this-week", REF_NOW, "UTC"), REF_NOW, "UTC"), false, "a week does not");
  assert.equal(isDefaultWindowRange(timeRangeForPreset("1y", REF_NOW, "UTC"), REF_NOW, "UTC"), false, "a year does not");
});

test("usesStaticContractFastPath: the 90d window or a static deploy uses contract.json, other ranges use /api/range", () => {
  const def = { from: cutoffIso(90, REF_NOW).slice(0, 10), to: "2026-06-26" };
  const week = timeRangeForPreset("this-week", REF_NOW, "UTC");
  assert.equal(usesStaticContractFastPath(def, false, REF_NOW, "UTC"), true, "exact default window -> static");
  assert.equal(usesStaticContractFastPath(week, false, REF_NOW, "UTC"), false, "a sub-window -> dynamic /api/range");
  assert.equal(usesStaticContractFastPath(week, true, REF_NOW, "UTC"), true, "static deploy always -> bundled contract.json");
});

test("last contract timezone is keyed per server and ignores malformed values", () => {
  assert.equal(loadLastContractTimezone(null), null, "unknown before any contract loads");
  saveLastContractTimezone(null, "Asia/Taipei");
  saveLastContractTimezone("https://board.example.com/app", "America/Los_Angeles");
  assert.equal(loadLastContractTimezone(null), "Asia/Taipei");
  assert.equal(loadLastContractTimezone("https://board.example.com/app"), "America/Los_Angeles");
  assert.equal(loadLastContractTimezone("https://other.example.com"), null, "server keys do not collide");
  store._raw("symphony-board:last-contract-timezone", "{bad");
  assert.equal(loadLastContractTimezone(null), null, "malformed storage -> unknown");
});

test("last contract timezone rejects invalid Intl zones", () => {
  saveLastContractTimezone(null, "Not/AZone");
  assert.equal(loadLastContractTimezone(null), null, "invalid saves are ignored");
  store._raw("symphony-board:last-contract-timezone", JSON.stringify({ "__same-origin__": "Not/AZone" }));
  assert.equal(loadLastContractTimezone(null), null, "invalid stored zones are ignored");
});
