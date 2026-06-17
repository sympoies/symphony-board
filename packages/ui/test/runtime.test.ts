import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_DEFAULT_HASH,
  desktopStartupRouteHash,
  internalRouteHashFromHref,
  shouldOpenExternalHttpHref,
} from "../src/runtime.ts";

test("desktop startup route defaults app launches to Activity while preserving reloads", () => {
  assert.equal(DESKTOP_DEFAULT_HASH, "#/activity");
  assert.equal(desktopStartupRouteHash("", "navigate"), "#/activity");
  assert.equal(desktopStartupRouteHash("#/graph", "navigate"), "#/activity");
  assert.equal(desktopStartupRouteHash("#/board", "back_forward"), "#/activity");
  assert.equal(desktopStartupRouteHash("#/graph", null), "#/activity");
  assert.equal(desktopStartupRouteHash("#/activity", "navigate"), null);
  assert.equal(desktopStartupRouteHash("#/graph", "reload"), null);
});

test("Tauri external opener keeps internal hash routes inside the app", () => {
  const current = "http://tauri.localhost/#/activity";
  assert.equal(internalRouteHashFromHref("#/commits", "http://tauri.localhost/#/commits", current), "#/commits");
  assert.equal(
    internalRouteHashFromHref("http://tauri.localhost/#/settings", "http://tauri.localhost/#/settings", current),
    "#/settings",
  );
  assert.equal(shouldOpenExternalHttpHref("#/commits", "http://tauri.localhost/#/commits", current), false);
  assert.equal(shouldOpenExternalHttpHref("https://github.com/sympoies/symphony-board", "https://github.com/sympoies/symphony-board", current), true);
  assert.equal(internalRouteHashFromHref("https://github.com/#/issues", "https://github.com/#/issues", current), null);
  assert.equal(internalRouteHashFromHref("/other#/settings", "http://tauri.localhost/other#/settings", current), null);
});
