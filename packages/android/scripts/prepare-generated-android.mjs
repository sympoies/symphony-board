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
// background. The launcher masks the layers to its own shape (circle / squircle)
// and shows only the central safe zone of the foreground, which zooms it — so the
// bars are scaled to ~0.66 (see below) to sit with the same padding as icon.png
// instead of coming out oversized/edge-touching. Reads as the brand mark
// everywhere — launcher, recents, themed icons.
const NAVY = "#030B22";
const CYAN = "#24DAE8";
const BAR_PATHS = [
  "M18.98,43.66 H21.98 C24.66,43.66 26.83,45.83 26.83,48.51 V59.48 C26.83,62.16 24.66,64.33 21.98,64.33 H18.98 C16.3,64.33 14.13,62.16 14.13,59.48 V48.51 C14.13,45.83 16.3,43.66 18.98,43.66 Z",
  "M35.64,31.53 H35.99 C39.37,31.53 42.11,34.27 42.11,37.65 V70.34 C42.11,73.72 39.37,76.46 35.99,76.46 H35.64 C32.26,76.46 29.52,73.72 29.52,70.34 V37.65 C29.52,34.27 32.26,31.53 35.64,31.53 Z",
  "M54,22.36 C57.61,22.36 60.54,25.29 60.54,28.9 V79.09 C60.54,82.7 57.61,85.63 54,85.63 C50.39,85.63 47.46,82.7 47.46,79.09 V28.9 C47.46,25.29 50.39,22.36 54,22.36 Z",
  "M72.01,31.53 H72.36 C75.74,31.53 78.48,34.27 78.48,37.65 V70.34 C78.48,73.72 75.74,76.46 72.36,76.46 H72.01 C68.63,76.46 65.89,73.72 65.89,70.34 V37.65 C65.89,34.27 68.63,31.53 72.01,31.53 Z",
  "M86.02,43.66 H89.02 C91.7,43.66 93.87,45.83 93.87,48.51 V59.48 C93.87,62.16 91.7,64.33 89.02,64.33 H86.02 C83.34,64.33 81.17,62.16 81.17,59.48 V48.51 C81.17,45.83 83.34,43.66 86.02,43.66 Z",
];
const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

const writeRes = (relPath, contents) => {
  const target = join(mainDir, "res", relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

writeRes(
  "drawable/ic_launcher_foreground.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group android:scaleX="0.66" android:scaleY="0.66" android:pivotX="54" android:pivotY="54">
${BAR_PATHS.map((d) => `        <path\n            android:fillColor="${CYAN}"\n            android:pathData="${d}" />`).join("\n")}
    </group>
</vector>
`,
);
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

// Dedicated icon for the Android 12+ system splash (windowSplashScreenAnimatedIcon
// below). The splash draws only the icon's foreground, scaled to the splash icon
// slot — so the launcher foreground (bars sized to fill the adaptive canvas) comes
// out oversized there. This splash icon is the same bars padded down to the
// splash's safe size, centered, so they read as a tasteful logo on the navy
// splash background instead of giant bars.
writeRes(
  "drawable/ic_splash.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group android:scaleX="0.55" android:scaleY="0.55" android:pivotX="54" android:pivotY="54">
${BAR_PATHS.map((d) => `        <path\n            android:fillColor="${CYAN}"\n            android:pathData="${d}" />`).join("\n")}
    </group>
</vector>
`,
);

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
// / drawable ic_launcher_background variant EXCEPT the two we authored above, so the
// adaptive icon resolves only to our bars-on-navy mark. (The full-bleed
// `mipmap-*/ic_launcher{,_round}` rasters stay as the pre-API-26 fallback.)
const resDir = join(mainDir, "res");
const keepForeground = join(resDir, "drawable", "ic_launcher_foreground.xml");
for (const entry of readdirSync(resDir)) {
  const dir = join(resDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir)) {
    const full = join(dir, file);
    if (full === keepForeground) continue;
    const isForeground = /^ic_launcher_foreground\.(xml|png|webp)$/.test(file);
    // Our `values/ic_launcher_background.xml` is the <color> we reference and keep;
    // only the drawable-typed background Tauri ships needs to go.
    const isDrawableBackground =
      entry.startsWith("drawable") && /^ic_launcher_background\.(xml|png|webp)$/.test(file);
    if (isForeground || isDrawableBackground) rmSync(full, { force: true });
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
