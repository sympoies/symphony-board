import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAndroidSafeAreaInsets,
  applyWideViewport,
  internalRouteHashFromHref,
  shouldOpenExternalHttpHref,
  wideViewportContent,
  WIDE_VIEWPORT_WIDTH,
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

test("wideViewportContent forces a desktop width only for the Android client with wide layout on", () => {
  // The gate: only the Android client, and only when the user turned wide layout
  // on, gets a fixed desktop-width viewport. Everything else keeps the responsive
  // default (null) — the browser and desktop shell must stay resizable, and the
  // default Android layout stays the responsive phone layout.
  assert.equal(wideViewportContent(true, "android"), `width=${WIDE_VIEWPORT_WIDTH}`);
  assert.equal(wideViewportContent(false, "android"), null, "wide off -> responsive default");
  assert.equal(wideViewportContent(true, "desktop"), null, "desktop shell stays resizable");
  assert.equal(wideViewportContent(true, null), null, "web (no client kind) stays responsive");
  assert.ok(WIDE_VIEWPORT_WIDTH >= 1180, "the forced width must reach the desktop multi-column CSS breakpoint");
});

test("applyWideViewport forces the fixed width on Android and restores the responsive meta when off", () => {
  // The DOM-side-effecting applier (not just the pure wideViewportContent core):
  // the OFF path's restore string lives only here, and toggling wide off must put
  // the responsive meta back without an app restart.
  const makeWindow = () => {
    const meta = new Map<string, string>([["content", "width=device-width, initial-scale=1.0"]]);
    const datasetTarget: Record<string, string> = {};
    const doc = {
      querySelector: (sel: string) =>
        sel === 'meta[name="viewport"]'
          ? {
              setAttribute: (name: string, value: string) => meta.set(name, value),
              getAttribute: (name: string) => meta.get(name) ?? null,
            }
          : null,
      documentElement: {
        dataset: datasetTarget,
        removeAttribute: (name: string) => {
          if (name === "data-wide-viewport") delete datasetTarget.wideViewport;
        },
      },
    };
    return { win: { document: doc } as unknown as Window, meta, datasetTarget };
  };

  // ON (Android): fixed desktop width + the wide-viewport dataset flag.
  const on = makeWindow();
  applyWideViewport(true, "android", on.win);
  assert.equal(on.meta.get("content"), `width=${WIDE_VIEWPORT_WIDTH}`);
  assert.equal(on.datasetTarget.wideViewport, "true");

  // OFF (Android): restore the responsive meta and drop the flag.
  const off = makeWindow();
  off.datasetTarget.wideViewport = "true";
  applyWideViewport(false, "android", off.win);
  assert.equal(off.meta.get("content"), "width=device-width, initial-scale=1.0");
  assert.equal(off.datasetTarget.wideViewport, undefined);

  // Non-Android: no-op — the browser and desktop shell keep their responsive meta.
  const web = makeWindow();
  applyWideViewport(true, null, web.win);
  applyWideViewport(true, "desktop", web.win);
  assert.equal(web.meta.get("content"), "width=device-width, initial-scale=1.0");
});
