import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAndroidSafeAreaInsets,
  internalRouteHashFromHref,
  shouldOpenExternalHttpHref,
} from "../src/runtime.ts";

// The desktop cold-start landing decision now lives in `startupRouteHash`
// (nav.ts, unit-tested there) and is shared with the web path; runtime.ts only
// keeps the DOM applier `normalizeDesktopStartupRoute`, which is exercised by the
// render-smoke rather than a unit test (it touches window.location + the Tauri
// host probe).

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

test("Android safe-area bridge writes CSS inset variables", () => {
  const style = new Map<string, string>();
  const doc = {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (name: string, value: string) => style.set(name, value),
      },
    },
  };
  const fakeWindow = {
    document: doc,
    symphonyAndroidInsets: {
      top: () => 24,
      right: () => 1.5,
      bottom: () => 16,
      left: () => -1,
    },
  } as unknown as Window;

  assert.equal(applyAndroidSafeAreaInsets(fakeWindow), true);
  assert.equal(style.get("--android-safe-area-top"), "24.00px");
  assert.equal(style.get("--android-safe-area-right"), "1.50px");
  assert.equal(style.get("--android-safe-area-bottom"), "16.00px");
  assert.equal(style.get("--android-safe-area-left"), "0.00px");
  assert.equal(doc.documentElement.dataset.androidSystemInsets, "true");
});
