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
  loadBoardScope, saveBoardScope, boardScopeDays, defaultBoardScope, isBoardScope, presetExceedsBoardScope, clampDefaultRangeToBoardScope, boardWindowRange,
  isWindowedRangeEnv, boardDisplayRange, windowedRangeTailUnfetched, rangeOverlayAllowedForSource, rangeOverlayAllowed, isStaticDeployment, liveControlsDisabled, primaryLoadWindowDays,
  loadWideLayout, saveWideLayout,
  loadHiddenEventTypes, saveHiddenEventTypes,
  defaultServerBaseUrlForRuntime,
  loadServerBaseUrl, saveServerBaseUrl, normalizeServerBaseUrl,
} from "../src/viewconfig.ts";
import { TIME_RANGE_PRESETS, activeTimeRangePresetId, staticContractTimeRange, timeRangeForPreset, timeRangeToIso, windowQuickPreset } from "../src/model.ts";
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

test("clampDefaultRangeToBoardScope keeps today visible when same-span presets tie (3d-window regression)", () => {
  // A 3d Board window: clamping an oversized default ranks fitting presets by span,
  // tie-broken by latest end — NOT by earliest start. The earliest-start tie-break
  // is a bug: when the only fitting named presets are the 1-day "today" and
  // "yesterday" (same span), earliest-start picks "yesterday", so App opens on
  // yesterday's overlay and hides today's board items even though "today" fits.
  // This happens on Sunday and Wednesday–Saturday, when "this week" reaches before
  // the 3-day window and drops out, leaving only today/yesterday.
  for (const [label, iso] of [
    ["Sunday", "2026-06-07T12:00:00Z"],
    ["Wednesday", "2026-06-10T12:00:00Z"],
    ["Saturday", "2026-06-13T12:00:00Z"],
  ] as const) {
    const day = Date.parse(iso);
    const clamped = clampDefaultRangeToBoardScope("3mo", "3d", day);
    assert.notEqual(clamped, "yesterday", `${label}: must not clamp to yesterday and hide today`);
    const range = timeRangeForPreset(clamped, day);
    const today = timeRangeForPreset("today", day);
    assert.equal(range.to, today.to, `${label}: the clamped default still reaches today`);
    assert.equal(presetExceedsBoardScope(clamped, "3d", day), false, `${label}: the clamped default fits the 3d window`);
  }
});

test("boardDisplayRange windows the display only for an actual /api/range env, not an uploaded contract", () => {
  // staticRange must window the display ONLY when the loaded env is itself a
  // /api/range projection (it carries range_query). A device whose default board
  // scope is windowed (Android) can still load a full / uploaded contract.json via
  // loadFile; that env is NOT a range response, so it must keep its true
  // item_window extent — otherwise the range control and empty-state extent claim
  // only the device window is loaded and hide the larger presets the file fills.
  const now = Date.parse("2026-06-08T12:00:00Z");
  const baseEnv = {
    contract_version: "2.0.0",
    generated_at: "2026-06-08T12:00:00Z",
    generator: "t",
    sources: [],
    items: [],
    edges: [],
    item_window: {
      scope: "boardWindow",
      window: { kind: "active_since", basis: "item_updated_at", since: "2026-03-10T00:00:00.000Z", days: 90, edge_filter: null },
      primary_items: 0,
      edge_endpoint_items: 0,
      total_items: 0,
      truncated: false,
    },
  } as const;

  // An uploaded / full contract: no range_query. On a windowed device it must keep
  // its real ~90-day item_window extent, not a synthetic 1mo device window.
  const uploaded = { ...baseEnv } as unknown as ContractEnvelope;
  assert.equal(isWindowedRangeEnv(uploaded, "1mo"), false, "an env without range_query is never a windowed range env");
  assert.deepEqual(boardDisplayRange(uploaded, "1mo", now), staticContractTimeRange(uploaded), "uploaded contract keeps its item_window extent on a windowed device");

  // A genuine /api/range projection: carries range_query. The display is the
  // synthetic, preset-aligned window (unchanged behavior).
  const rangeEnv = {
    ...baseEnv,
    range_query: { kind: "time_range", timezone: "UTC", from: "2026-05-10", to: "2026-06-08" },
  } as unknown as ContractEnvelope;
  assert.equal(isWindowedRangeEnv(rangeEnv, "1mo"), true, "an env with range_query on a windowed scope IS a windowed range env");
  assert.deepEqual(boardDisplayRange(rangeEnv, "1mo", now), boardWindowRange("1mo", now), "a range env keeps the preset-aligned synthetic window");

  // Unwindowed scopes never window the display, range_query or not.
  assert.equal(isWindowedRangeEnv(rangeEnv, "full"), false, "full scope is never windowed");
  assert.equal(isWindowedRangeEnv(rangeEnv, "off"), false, "off scope is never windowed");
  assert.deepEqual(boardDisplayRange(rangeEnv, "full", now), staticContractTimeRange(rangeEnv), "full scope keeps the item_window extent");
});

test("rangeOverlayAllowedForSource suppresses the ./api/range overlay for a file-loaded env (#424)", () => {
  // A windowed-scope device that loads an uploaded contract via loadFile gets an env
  // with no range_query, so its landing default range (a preset window) differs from
  // the file's true item_window extent → customRange → the range overlay would
  // otherwise fetch ./api/range and OVERWRITE the uploaded payload (or surface
  // rangeError on a static/offline host, or an Android client with no server URL).
  // The overlay must stay suppressed for a file env; the views filter the loaded env
  // to the active range client-side, so an uploaded contract never needs the server
  // projection.
  assert.equal(rangeOverlayAllowedForSource("file"), false, "a file-loaded env never refetches the range overlay");
  // A network-loaded env keeps the existing server-projection behavior.
  assert.equal(rangeOverlayAllowedForSource("network"), true, "a network env may fetch the range overlay");
  // Before any contract has loaded there is no metadata; treat it as allowed so the
  // existing (non-file) behavior is the default.
  assert.equal(rangeOverlayAllowedForSource(null), true, "no source yet (pre-load) keeps the default overlay behavior");
  assert.equal(rangeOverlayAllowedForSource(undefined), true, "undefined source keeps the default overlay behavior");
});

test("rangeOverlayAllowed also suppresses the overlay on a static, server-less deployment (Pages demo)", () => {
  // A static host (the GitHub Pages demo) serves ./contract.json but 404s
  // ./api/range, so the overlay must stay off even for a NETWORK-loaded contract —
  // otherwise a fresh visitor whose default range falls outside the contract window
  // opens on "Could not load selected range." The views filter the full payload
  // client-side, the same as the #424 file-env path.
  assert.equal(rangeOverlayAllowed("network", true), false, "static deployment never fetches the range overlay, even for a network env");
  assert.equal(rangeOverlayAllowed("file", true), false, "static + file: still suppressed");
  assert.equal(rangeOverlayAllowed(null, true), false, "static + pre-load: suppressed");
  // Non-static keeps the source-based behavior (#424) unchanged — the historical path.
  assert.equal(rangeOverlayAllowed("network", false), true, "non-static network env may fetch the overlay");
  assert.equal(rangeOverlayAllowed("file", false), false, "non-static file env stays suppressed (#424)");
  assert.equal(rangeOverlayAllowed(null, false), true, "non-static pre-load keeps the default overlay behavior");
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

test("isStaticDeployment defaults to false without the VITE flag (the safe default for every non-Pages build)", () => {
  // import.meta.env is absent under the node test runner (no Vite injection), the
  // same as any deployment that does not set VITE_SYMPHONY_BOARD_STATIC — so the
  // overlay-suppression must NOT engage by default, leaving Docker web / standalone /
  // Android on the historical server-projection path.
  assert.equal(isStaticDeployment(), false);
});

test("boardWindowRange pins the loaded window to the contract clock so it lines up with its named preset (mobile windowed-range regression)", () => {
  // A windowed mobile board FETCHES /api/range with the live clock (Date.now),
  // but every quick preset, the active-preset highlight, and the synthetic
  // window button resolve against the contract's generated_at. When the load
  // crosses local midnight — or the contract is stale / a fixture with an older
  // generated_at — those two instants land on different days, so a window built
  // from item_window (fetch clock for `from`, generated_at for `to`) drifts off
  // its same-named preset. The UI then injects a SECOND identically-labelled
  // quick button (the duplicate "1mo" in the bug report) and mis-hides longer
  // presets. boardWindowRange resolves the window on generated_at — the same
  // clock the presets use — so it always equals its preset.
  const generatedAt = Date.parse("2026-06-08T12:00:00Z"); // a Monday
  const windowedScopes = [["1d", "today"], ["7d", "1w"], ["1mo", "1mo"], ["3mo", "3mo"], ["6mo", "6mo"], ["1y", "1y"]] as const;
  for (const [scope, preset] of windowedScopes) {
    const win = boardWindowRange(scope, generatedAt);
    assert.ok(win, `${scope} is windowed -> has a window`);
    assert.equal(windowQuickPreset(win, generatedAt, scope), null, `${scope} window == ${preset} preset -> no duplicate quick button`);
    assert.equal(activeTimeRangePresetId(win, generatedAt, null), preset, `${scope} window highlights the ${preset} preset`);
  }
  // 3d is the one windowed scope with no built-in equivalent, so it keeps its own
  // synthetic "whole window" button (this is the button's intended purpose).
  const threeDay = boardWindowRange("3d", generatedAt)!;
  assert.deepEqual(windowQuickPreset(threeDay, generatedAt, "3d"), { label: "3d", range: threeDay });
  // Unwindowed scopes (off / full) have no fixed window.
  assert.equal(boardWindowRange("off", generatedAt), null);
  assert.equal(boardWindowRange("full", generatedAt), null);

  // Contrast — the OLD derivation that produced the bug: a 1mo window fetched the
  // day AFTER generated_at builds a mixed-clock range via item_window (since =
  // 2026-05-11 from the fetch clock; to = 2026-06-08 from generated_at). That
  // range no longer equals the generated_at-based "1mo" preset (2026-05-10..06-08),
  // so a duplicate "1mo" button is surfaced — exactly what boardWindowRange avoids.
  const staleAfterMidnight: ContractEnvelope = {
    contract_version: "2.0.0",
    generated_at: "2026-06-08T12:00:00Z",
    generator: "t",
    sources: [],
    items: [],
    edges: [],
    item_window: {
      scope: "boardWindow",
      window: { kind: "active_since", basis: "item_updated_at", since: "2026-05-11T00:00:00.000Z", days: 30, edge_filter: null },
      primary_items: 0,
      edge_endpoint_items: 0,
      total_items: 0,
      truncated: false,
    },
  };
  const mixedClockWindow = staticContractTimeRange(staleAfterMidnight); // { from: "2026-05-11", to: "2026-06-08" }
  assert.notEqual(activeTimeRangePresetId(mixedClockWindow, generatedAt, null), "1mo", "the mixed-clock window misses the 1mo preset (the bug)");
  assert.deepEqual(windowQuickPreset(mixedClockWindow, generatedAt, "1mo"), { label: "1mo", range: mixedClockWindow }, "the mixed-clock window injects a duplicate 1mo button (the bug)");
  assert.equal(activeTimeRangePresetId(boardWindowRange("1mo", generatedAt)!, generatedAt, null), "1mo", "boardWindowRange avoids the drift");

  // tz is threaded end to end. Resolve in a non-UTC zone whose local day differs
  // from the UTC day (Taipei is UTC+8, so 18:00Z is already the next local day) —
  // the exact midnight-crossing condition the bug is named for. The windowed scope
  // must still map to its named preset, not drift off it.
  const taipeiAcrossMidnight = Date.parse("2026-06-08T18:00:00Z");
  assert.equal(
    activeTimeRangePresetId(boardWindowRange("1mo", taipeiAcrossMidnight, "Asia/Taipei")!, taipeiAcrossMidnight, null, "Asia/Taipei"),
    "1mo",
    "boardWindowRange threads tz so a windowed scope aligns to its preset across a UTC/local day boundary",
  );
});

test("windowedRangeTailUnfetched flags a windowed env whose displayed tail extends past the fetched range_query day (#414 fetch-vs-display drift)", () => {
  // A windowed mobile board FETCHES /api/range with the live Date.now() clock, but
  // the DISPLAYED window (boardWindowRange) resolves on the contract's generated_at
  // — two clocks in one load. When a load crosses local midnight (or under client /
  // server clock skew) the generated_at day lands LATER than the fetched `to` day,
  // so staticRange claims a trailing day the env never fetched. The landing range
  // equals staticRange (customRange false), so without this signal no range overlay
  // would fill the gap and today's items read as missing. windowedRangeTailUnfetched
  // detects exactly that case so App can force the overlay refetch (#414, option 2).

  // range_query mirrors the server: from/to are the fetch-clock calendar days
  // expanded to the zone's day boundaries (parseRange -> zonedDay{Start,End}Iso),
  // which timeRangeToIso reproduces. Only `to` matters to the helper.
  const rangeEnv = (fetchFrom: string, fetchTo: string, tz = "UTC"): ContractEnvelope =>
    ({
      contract_version: "2.0.0",
      generated_at: "2026-06-08T00:30:00Z", // a hair past UTC midnight
      generator: "t",
      sources: [],
      items: [],
      edges: [],
      range_query: { kind: "time_range", timezone: tz, ...timeRangeToIso({ from: fetchFrom, to: fetchTo }, tz) },
    }) as unknown as ContractEnvelope;

  // DRIFT: generated just after local midnight on 2026-06-08, but the /api/range
  // fetch fired just BEFORE midnight, so it requested a 1mo window ending 2026-06-07.
  // The displayed 1mo window ends 2026-06-08 (generated_at) -> its tail day was never
  // fetched, and no overlay would otherwise fill it.
  const generatedAt = Date.parse("2026-06-08T00:30:00Z");
  assert.equal(boardWindowRange("1mo", generatedAt, "UTC")!.to, "2026-06-08", "display window ends on the generated_at day");
  const drifted = rangeEnv("2026-05-09", "2026-06-07");
  assert.equal(windowedRangeTailUnfetched(drifted, "1mo", generatedAt, "UTC"), true, "displayed tail (06-08) was never fetched (06-07) -> overlay needed");

  // NO DRIFT (the common case): fetch and generated_at land on the SAME day, so the
  // displayed window is exactly what was fetched. Must stay false so #407's preset
  // alignment is untouched and no needless overlay fetch fires.
  assert.equal(windowedRangeTailUnfetched(rangeEnv("2026-05-10", "2026-06-08"), "1mo", generatedAt, "UTC"), false, "fetched tail == displayed tail -> no overlay");

  // FETCH AHEAD (#417): the fetch clock ran LATER than generated_at, so the fetched
  // window is shifted one day later than the displayed window. The two windows share
  // the SAME span (boardScopeDays), so a later fetch is NOT a superset — it drops the
  // displayed HEAD day instead of the tail. Here display 2026-05-10..06-08 vs fetched
  // 2026-05-11..06-09: the head day 05-10 was never fetched, so the overlay IS needed.
  // The old `to`-only check wrongly returned false (06-08 > 06-09 is false) and left
  // the head day reading empty under client-ahead clock skew.
  assert.equal(windowedRangeTailUnfetched(rangeEnv("2026-05-11", "2026-06-09"), "1mo", generatedAt, "UTC"), true, "fetch-ahead drops the displayed head day (05-10 never fetched) -> overlay needed");

  // Unwindowed scopes never overlay, range_query or not.
  assert.equal(windowedRangeTailUnfetched(drifted, "full", generatedAt, "UTC"), false, "full scope is never windowed");
  assert.equal(windowedRangeTailUnfetched(drifted, "off", generatedAt, "UTC"), false, "off scope is never windowed");

  // An uploaded / full contract carries no range_query -> never an overlay candidate.
  assert.equal(windowedRangeTailUnfetched({ ...drifted, range_query: undefined } as unknown as ContractEnvelope, "1mo", generatedAt, "UTC"), false, "an env without range_query is not a windowed range env");

  // tz threaded end to end: in Asia/Taipei (UTC+8) the generated_at instant 18:00Z is
  // already the next LOCAL day (06-09 02:00). A fetch that ended 06-08 (local) is one
  // local day behind the displayed window -> the cross-midnight gap the bug is named
  // for, detected in a non-UTC zone.
  const taipeiGenerated = Date.parse("2026-06-08T18:00:00Z");
  assert.equal(boardWindowRange("1mo", taipeiGenerated, "Asia/Taipei")!.to, "2026-06-09", "Taipei display window ends on the local generated_at day");
  const taipeiDrift = { ...rangeEnv("2026-05-10", "2026-06-08", "Asia/Taipei"), generated_at: "2026-06-08T18:00:00Z" } as unknown as ContractEnvelope;
  assert.equal(windowedRangeTailUnfetched(taipeiDrift, "1mo", taipeiGenerated, "Asia/Taipei"), true, "tz-aware: the Taipei displayed tail (06-09) was never fetched (06-08)");
});

test("windowedRangeTailUnfetched is a both-ends coverage check, not tail-only (#417 client-ahead skew)", () => {
  // The displayed window (boardWindowRange, on generated_at) and the fetched window
  // (range_query, on the fetch clock) share the SAME span. So a clock skew shifts the
  // fetched window relative to the displayed one without changing its length: a fetch
  // BEHIND drops the displayed tail (#414), a fetch AHEAD drops the displayed head, and
  // a large-enough skew drops both (no overlap). The helper must flag a gap at EITHER
  // end, so the overlay refetches the displayed window the user actually sees.
  const rangeEnv = (fetchFrom: string, fetchTo: string, tz = "UTC"): ContractEnvelope =>
    ({
      contract_version: "2.0.0",
      generated_at: "2026-06-08T00:30:00Z",
      generator: "t",
      sources: [],
      items: [],
      edges: [],
      range_query: { kind: "time_range", timezone: tz, ...timeRangeToIso({ from: fetchFrom, to: fetchTo }, tz) },
    }) as unknown as ContractEnvelope;

  // 1mo display window ending on the generated_at day 2026-06-08 (so from = 2026-05-10).
  const generatedAt = Date.parse("2026-06-08T00:30:00Z");
  assert.equal(boardWindowRange("1mo", generatedAt, "UTC")!.from, "2026-05-10", "display window starts 05-10");
  assert.equal(boardWindowRange("1mo", generatedAt, "UTC")!.to, "2026-06-08", "display window ends 06-08");

  // HEAD uncovered (client clock one day ahead): fetched 05-11..06-09 leaves 05-10 out.
  assert.equal(windowedRangeTailUnfetched(rangeEnv("2026-05-11", "2026-06-09"), "1mo", generatedAt, "UTC"), true, "fetch-ahead by 1 day -> head day 05-10 unfetched");

  // No overlap at all on a 1d scope (display window is the single generated_at day, a
  // one-day-ahead fetch lands entirely on the next day): the whole displayed day is unfetched.
  assert.equal(boardWindowRange("1d", generatedAt, "UTC")!.from, "2026-06-08", "1d display window is the generated_at day");
  assert.equal(windowedRangeTailUnfetched(rangeEnv("2026-06-09", "2026-06-09"), "1d", generatedAt, "UTC"), true, "1d fetch-ahead -> displayed day never fetched (no overlap)");

  // Fully covered: a fetched window that contains the displayed window on BOTH ends
  // (only possible if the fetch span is wider, e.g. a larger fixture) needs no overlay.
  assert.equal(windowedRangeTailUnfetched(rangeEnv("2026-05-01", "2026-06-20"), "1mo", generatedAt, "UTC"), false, "displayed window fully inside fetched data -> no overlay");
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

test("primaryLoadWindowDays: a static deployment loads the full contract even with a windowed scope (#432)", () => {
  // Normal deployment: the windowed Board scope drives a /api/range primary load.
  assert.equal(primaryLoadWindowDays(7, false), 7, "non-static windowed scope keeps its window");
  assert.equal(primaryLoadWindowDays(null, false), null, "non-static full scope loads the full contract");
  // Static (Pages) deployment: ./api/range 404s, so the primary load must be the
  // full ./contract.json regardless of a stored windowed scope.
  assert.equal(primaryLoadWindowDays(7, true), null, "static deployment ignores a windowed scope");
  assert.equal(primaryLoadWindowDays(30, true), null, "static deployment ignores any window");
  assert.equal(primaryLoadWindowDays(null, true), null, "static deployment full scope loads the full contract");
});
