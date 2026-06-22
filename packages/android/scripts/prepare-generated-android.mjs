import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mainDir = join(here, "..", "src-tauri", "gen", "android", "app", "src", "main");

if (!existsSync(mainDir)) {
  throw new Error("Missing src-tauri/gen/android. Run pnpm android:init after installing the Android SDK/NDK.");
}

// Launcher icons MUST live under `mipmap/` (the launcher may load a higher
// density than the device) and SHOULD be adaptive icons — otherwise modern
// Android surfaces (the recents/running-apps list, themed icons) don't render a
// plain `@drawable` vector and fall back to the framework default. We point the
// manifest at the adaptive mipmap icon written below.
const manifestPath = join(mainDir, "AndroidManifest.xml");
const manifest = readFileSync(manifestPath, "utf8")
  .replace(/\n\s*android:roundIcon="@[^"]+"/g, "")
  .replace(/android:icon="@[^"]+"/, 'android:icon="@mipmap/ic_launcher"')
  .replace(
    'android:label="@string/app_name"',
    'android:label="@string/app_name"\n        android:roundIcon="@mipmap/ic_launcher_round"',
  );
writeFileSync(manifestPath, manifest);

const mainActivityPath = join(mainDir, "java", "com", "sympoies", "symphonyboard", "android", "MainActivity.kt");
writeFileSync(
  mainActivityPath,
  `package com.sympoies.symphonyboard.android

import android.os.Bundle
import android.webkit.WebView
import android.webkit.JavascriptInterface
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

class MainActivity : TauriActivity() {
    private var safeInsetTop = 0f
    private var safeInsetRight = 0f
    private var safeInsetBottom = 0f
    private var safeInsetLeft = 0f

    inner class SafeAreaBridge {
        @JavascriptInterface fun top(): Float = safeInsetTop
        @JavascriptInterface fun right(): Float = safeInsetRight
        @JavascriptInterface fun bottom(): Float = safeInsetBottom
        @JavascriptInterface fun left(): Float = safeInsetLeft
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Android 15+ (targetSdk >= 35) forces edge-to-edge: the activity draws
        // under the status and navigation bars. Opt the decor view out of fitting
        // system windows so the WebView can fill the screen, then re-inset the page
        // content ourselves via the safe-area bridge below.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        webView.addJavascriptInterface(SafeAreaBridge(), "symphonyAndroidInsets")

        // Honor a fixed-width viewport meta (width=N) and scale it to fit the screen.
        // With the default width=device-width meta this is a no-op (the normal
        // responsive phone layout is unchanged); it lets the "Wide layout" setting
        // force a desktop-width viewport so a large e-reader renders the desktop
        // layout the CSS breakpoints gate on instead of the phone layout it falls
        // into at its small native device-width.
        webView.settings.useWideViewPort = true
        webView.settings.loadWithOverviewMode = true

        // Listen on the decor view, not the WebView. Inside wry's view hierarchy the
        // WebView is not reliably in the window-inset dispatch path, so a listener on
        // it never observed a non-zero status-bar inset and the page kept drawing
        // under the status bar. The decor view always receives the raw window insets.
        // Fold display-cutout insets into the system bars so notch / punch-hole
        // devices stay clear too.
        val decorView = window.decorView
        ViewCompat.setOnApplyWindowInsetsListener(decorView) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val density = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
            safeInsetTop = bars.top / density
            safeInsetRight = bars.right / density
            safeInsetBottom = bars.bottom / density
            safeInsetLeft = bars.left / density
            injectSafeAreaInsets(webView)
            insets
        }
        ViewCompat.requestApplyInsets(decorView)
    }

    private fun cssPx(value: Float): String = String.format(Locale.US, "%.2fpx", value)

    private fun injectSafeAreaInsets(webView: WebView) {
        val script = """
            (() => {
              const root = document.documentElement;
              if (!root) return;
              root.style.setProperty('--android-safe-area-top', '\${cssPx(safeInsetTop)}');
              root.style.setProperty('--android-safe-area-right', '\${cssPx(safeInsetRight)}');
              root.style.setProperty('--android-safe-area-bottom', '\${cssPx(safeInsetBottom)}');
              root.style.setProperty('--android-safe-area-left', '\${cssPx(safeInsetLeft)}');
              root.dataset.androidSystemInsets = 'true';
            })();
        """.trimIndent()

        webView.post { webView.evaluateJavascript(script, null) }
        webView.postDelayed({ webView.evaluateJavascript(script, null) }, 250)
        webView.postDelayed({ webView.evaluateJavascript(script, null) }, 1000)
    }
}
`,
);

// Adaptive launcher icon, authored entirely from vectors so the script stays
// self-contained (no committed PNGs, no `tauri icon` at build time). The five
// cyan equalizer bars are the foreground; a solid brand-navy fill is the
// background; a single-color bar silhouette is the <monochrome> layer the system
// tints for Android 13+ themed icons. The launcher masks the layers to its own
// shape (circle / squircle) and shows only the central safe zone of the
// foreground, which zooms it — so the bars are scaled to ~0.66 (see below) to sit
// with the same padding as icon.png instead of coming out oversized/edge-touching.
// Reads as the brand mark everywhere — launcher, recents, themed icons.
const NAVY = "#030B22";
const CYAN = "#24DAE8";
const BAR_PATHS = [
  "M18.98,43.66 H21.98 C24.66,43.66 26.83,45.83 26.83,48.51 V59.48 C26.83,62.16 24.66,64.33 21.98,64.33 H18.98 C16.3,64.33 14.13,62.16 14.13,59.48 V48.51 C14.13,45.83 16.3,43.66 18.98,43.66 Z",
  "M35.64,31.53 H35.99 C39.37,31.53 42.11,34.27 42.11,37.65 V70.34 C42.11,73.72 39.37,76.46 35.99,76.46 H35.64 C32.26,76.46 29.52,73.72 29.52,70.34 V37.65 C29.52,34.27 32.26,31.53 35.64,31.53 Z",
  "M54,22.36 C57.61,22.36 60.54,25.29 60.54,28.9 V79.09 C60.54,82.7 57.61,85.63 54,85.63 C50.39,85.63 47.46,82.7 47.46,79.09 V28.9 C47.46,25.29 50.39,22.36 54,22.36 Z",
  "M72.01,31.53 H72.36 C75.74,31.53 78.48,34.27 78.48,37.65 V70.34 C78.48,73.72 75.74,76.46 72.36,76.46 H72.01 C68.63,76.46 65.89,73.72 65.89,70.34 V37.65 C65.89,34.27 68.63,31.53 72.01,31.53 Z",
  "M86.02,43.66 H89.02 C91.7,43.66 93.87,45.83 93.87,48.51 V59.48 C93.87,62.16 91.7,64.33 89.02,64.33 H86.02 C83.34,64.33 81.17,62.16 81.17,59.48 V48.51 C81.17,45.83 83.34,43.66 86.02,43.66 Z",
];
// The equalizer bars as a standalone vector, scaled around the 108-canvas centre.
// Reused for the adaptive foreground (0.66 safe-zone padding), the themed-icon
// monochrome silhouette (same geometry; the system supplies the tint, so the fill
// colour is irrelevant), and the Android-12 splash icon (0.55).
const barsVector = (scale, fillColor) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group android:scaleX="${scale}" android:scaleY="${scale}" android:pivotX="54" android:pivotY="54">
${BAR_PATHS.map((d) => `        <path\n            android:fillColor="${fillColor}"\n            android:pathData="${d}" />`).join("\n")}
    </group>
</vector>
`;

const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;

const writeRes = (relPath, contents) => {
  const target = join(mainDir, "res", relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

writeRes("drawable/ic_launcher_foreground.xml", barsVector("0.66", CYAN));
// Themed-icon monochrome layer (Android 13+): launchers tint a single-color
// silhouette, so this is the same bars at the same safe-zone scale as the
// foreground, painted one flat colour (the system supplies the tint). Without it,
// themed-icon launchers drop our mark and tint the framework default instead.
writeRes("drawable/ic_launcher_monochrome.xml", barsVector("0.66", "#FFFFFF"));
writeRes(
  "values/ic_launcher_background.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${NAVY}</color>
</resources>
`,
);
writeRes("mipmap-anydpi-v26/ic_launcher.xml", adaptiveIcon);
writeRes("mipmap-anydpi-v26/ic_launcher_round.xml", adaptiveIcon);

// Pre-API-26 launcher fallback. Adaptive icons (`mipmap-anydpi-v26`) only apply on
// API 26+. On API 24-25 the launcher resolves `@mipmap/ic_launcher` to a raster —
// and `tauri android init` lays down per-density `ic_launcher*.png` from its OWN
// default template (the Tauri logo), NOT from bundle.icon, so the brand mark would
// be replaced by Tauri's there. Author the fallback as a full-icon vector instead
// (PNG-free, matching the rest of this script): a navy tile plus the bars at full
// size — no safe-zone crop applies off-adaptive, so scale 1.0 reproduces icon.png's
// proportions. An unversioned `mipmap-anydpi` resource outranks the density rasters
// on every API level (anydpi precedence) yet is itself outranked by
// `mipmap-anydpi-v26` on API 26+, so it renders only on API 24-25 while the adaptive
// icon still owns API 26+. The square launcher gets a rounded tile; the round
// launcher (roundIcon, API 25+) a circle.
const ROUNDED_TILE = "M22,0 H86 A22,22 0 0 1 108,22 V86 A22,22 0 0 1 86,108 H22 A22,22 0 0 1 0,86 V22 A22,22 0 0 1 22,0 Z";
const CIRCLE_TILE = "M0,54 A54,54 0 1 0 108,54 A54,54 0 1 0 0,54 Z";
const fallbackIcon = (tilePath) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="${NAVY}"
        android:pathData="${tilePath}" />
${BAR_PATHS.map((d) => `    <path\n        android:fillColor="${CYAN}"\n        android:pathData="${d}" />`).join("\n")}
</vector>
`;
writeRes("mipmap-anydpi/ic_launcher.xml", fallbackIcon(ROUNDED_TILE));
writeRes("mipmap-anydpi/ic_launcher_round.xml", fallbackIcon(CIRCLE_TILE));

// Dedicated icon for the Android 12+ system splash (windowSplashScreenAnimatedIcon
// below). The splash draws only the icon's foreground, scaled to the splash icon
// slot — so the launcher foreground (bars sized to fill the adaptive canvas) comes
// out oversized there. This splash icon is the same bars padded down to the
// splash's safe size, centered, so they read as a tasteful logo on the navy
// splash background instead of giant bars.
writeRes("drawable/ic_splash.xml", barsVector("0.55", CYAN));

// Drop the legacy plain-vector launcher icon from earlier versions of this
// script — it is no longer referenced (the manifest now uses @mipmap) and a
// non-adaptive @drawable launcher icon is exactly what failed to render in the
// recents list.
rmSync(join(mainDir, "res", "drawable", "ic_launcher.xml"), { force: true });

// `tauri android init` also lays down its OWN default adaptive-icon resources: a
// gradient foreground vector under `drawable-v24/`, a `drawable/` background, and
// per-density foreground rasters. On API 24+ the `-v24`-qualified foreground
// OUTRANKS our unqualified `drawable/ic_launcher_foreground.xml`, so the launcher
// renders Tauri's mark — or, when that foreground fails to inflate, the framework
// default (bugdroid) icon — instead of our bars. Strip every ic_launcher_foreground
// / ic_launcher_monochrome / drawable ic_launcher_background variant EXCEPT the ones
// we authored above, so the adaptive icon resolves only to our bars-on-navy mark and
// its themed-icon silhouette.
const resDir = join(mainDir, "res");
const keepDrawables = new Set([
  join(resDir, "drawable", "ic_launcher_foreground.xml"),
  join(resDir, "drawable", "ic_launcher_monochrome.xml"),
]);
for (const entry of readdirSync(resDir)) {
  const dir = join(resDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir)) {
    const full = join(dir, file);
    if (keepDrawables.has(full)) continue;
    const isLayer = /^ic_launcher_(foreground|monochrome)\.(xml|png|webp)$/.test(file);
    // Our `values/ic_launcher_background.xml` is the <color> we reference and keep;
    // only the drawable-typed background Tauri ships needs to go.
    const isDrawableBackground =
      entry.startsWith("drawable") && /^ic_launcher_background\.(xml|png|webp)$/.test(file);
    if (isLayer || isDrawableBackground) rmSync(full, { force: true });
  }
}

// `tauri android init` likewise generates per-density `mipmap-*/ic_launcher{,_round}.png`
// rasters from its own default template (the Tauri logo), not from bundle.icon. The
// `mipmap-anydpi/` brand fallback authored above outranks them on every API level, so
// they are both off-brand and unreferenced — drop them so the APK ships no Tauri mark.
for (const entry of readdirSync(resDir)) {
  if (!entry.startsWith("mipmap-") || entry.includes("anydpi")) continue;
  const dir = join(resDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir)) {
    if (/^ic_launcher(_round)?\.(png|webp)$/.test(file)) rmSync(join(dir, file), { force: true });
  }
}

for (const themePath of [
  join(mainDir, "res", "values", "themes.xml"),
  join(mainDir, "res", "values-night", "themes.xml"),
]) {
  writeFileSync(
    themePath,
    `<resources xmlns:tools="http://schemas.android.com/tools">
    <style name="Theme.symphony_board_android" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:statusBarColor">#011627</item>
        <item name="android:navigationBarColor">#011627</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>
        <!-- Brand-navy launch background so there is no white flash on cold start.
             windowBackground covers the pre-splash window and pre-Android-12 cold
             start; windowSplashScreenBackground is the Android 12+ system splash,
             which draws the adaptive icon's (cyan-bars) foreground centered on this
             color. Matches the status/navigation bars for a seamless dark launch. -->
        <item name="android:windowBackground">#011627</item>
        <item name="android:windowSplashScreenBackground" tools:targetApi="31">#011627</item>
        <item name="android:windowSplashScreenAnimatedIcon" tools:targetApi="31">@drawable/ic_splash</item>
    </style>
</resources>
`,
  );
}

console.log("Prepared generated Android shell: launcher icon, system-bar insets, and theme bars.");
