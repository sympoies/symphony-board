import { test } from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_DEFAULT_HASH, desktopStartupRouteHash } from "../src/runtime.ts";

test("desktop startup route defaults a fresh app session to Activity", () => {
  assert.equal(DESKTOP_DEFAULT_HASH, "#/activity");
  assert.equal(desktopStartupRouteHash("", false), "#/activity");
  assert.equal(desktopStartupRouteHash("#/graph", false), "#/activity");
  assert.equal(desktopStartupRouteHash("#/activity", false), null);
  assert.equal(desktopStartupRouteHash("#/graph", true), null);
});
