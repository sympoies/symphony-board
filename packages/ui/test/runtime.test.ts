import { test } from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_DEFAULT_HASH, desktopStartupRouteHash } from "../src/runtime.ts";

test("desktop startup route defaults app launches to Activity while preserving reloads", () => {
  assert.equal(DESKTOP_DEFAULT_HASH, "#/activity");
  assert.equal(desktopStartupRouteHash("", "navigate"), "#/activity");
  assert.equal(desktopStartupRouteHash("#/graph", "navigate"), "#/activity");
  assert.equal(desktopStartupRouteHash("#/board", "back_forward"), "#/activity");
  assert.equal(desktopStartupRouteHash("#/graph", null), "#/activity");
  assert.equal(desktopStartupRouteHash("#/activity", "navigate"), null);
  assert.equal(desktopStartupRouteHash("#/graph", "reload"), null);
});
