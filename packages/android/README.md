# Symphony Board Android

This package is the Android thin-client shell. It bundles the shared
`@symphony-board/ui` build in a Tauri v2 Android app and connects to an existing
Symphony Board server over HTTP(S). It does not contain SQLite, Postgres,
provider tokens, a sync daemon, or any backend sidecar.

## Prerequisites

- Android Studio
- Android SDK Platform Tools
- Android SDK Build Tools
- Android SDK Command-line Tools
- Android NDK
- `JAVA_HOME`
- `ANDROID_HOME`
- `NDK_HOME`
- Rust Android targets for the ABIs you build, for example:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

## Commands

Run from the repository root:

```sh
pnpm android:info
pnpm android:init
pnpm android:dev
pnpm android:run
pnpm android:build
pnpm android:build:apk
```

Run `pnpm android:init` once after the Android SDK and NDK are installed; Tauri
creates the native Android project under `src-tauri/gen/android`. `pnpm
android:build:apk` runs `tauri android build --apk --ci` and uses
`packages/ui/dist` from the shared UI build. Set
`VITE_SYMPHONY_BOARD_SERVER_URL` at build time to preconfigure a server URL;
otherwise the Android app starts without a default server and Settings ->
Server is the recovery path.

## Release signing

A `release` APK is only installable / update-compatible when it is signed, and
testers can update in place across versions **only if every build uses the same
key**. `prepare-generated-android.mjs` injects a release `signingConfig` into the
generated Gradle project when a keystore is available — otherwise the release
build stays unsigned and `debug` is unaffected, so keyless CI and contributors
still build (see `scripts/lib/android-signing.mjs`).

Provide the keystore one of two ways:

- **Locally** — copy `keystore.properties.example` to `keystore.properties`
  (gitignored) and point `storeFile` at your `.jks`. Then `pnpm android:build:apk`
  produces a signed release APK.
- **CI** — the `release-apk` workflow reads the keystore from repo secrets
  (`ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` + `ANDROID_KEY_ALIAS` +
  `ANDROID_KEY_PASSWORD`), via the env vars `ANDROID_KEYSTORE_FILE` /
  `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`.

Create a keystore once (back it up — losing it means you can never update an
installed app again; the master belongs in the encrypted secrets store):

```sh
keytool -genkeypair -v -keystore symphony-board-release.jks \
  -alias symphony-board -keyalg RSA -keysize 2048 -validity 10000
```

The first switch from a previous debug-signed install to a release-signed one
needs a one-time uninstall (the signing key changes); every release-signed build
after that updates in place as long as the version (and thus `versionCode`)
increases. A side-loaded APK may still trip Play Protect's "unknown developer"
warning on first install — tap "Install anyway".

## CI: build + publish the APK on release

`.github/workflows/release-apk.yml` builds a **signed universal** release APK and
attaches it to the GitHub Release on `release: published` (and on
`workflow_dispatch`, optionally to a given tag). Testers download and install the
APK from the Releases page. The NDK version it installs is pinned in
`ndk-version.json` — keep it in sync with your local `NDK_HOME`.

The Android generated project is intentionally gitignored. The package scripts
run `scripts/prepare-generated-android.mjs` before dev/build commands so the
generated app uses the Symphony Board launcher mark and applies Android
system-bar insets to the WebView, avoiding status/navigation bar overlap on
edge-to-edge devices.

The launcher mark is written as an **adaptive icon under `mipmap-anydpi-v26/`**
(a navy background, the cyan equalizer foreground, and a `<monochrome>` bar
silhouette, all vectors) and the manifest points at `@mipmap/ic_launcher`. A
plain `@drawable` vector renders on the home screen but is ignored by the
recents/running-apps list and themed-icon surfaces, which fall back to the
framework default — so the icon must be an adaptive `mipmap` resource. The
`<monochrome>` layer is what Android 13+ themed-icon mode tints; without it the
launcher themes the framework default instead of our mark.

Adaptive icons only apply on API 26+. For the API 24–25 fallback the script
writes a full-icon brand vector (navy tile + bars) to **`mipmap-anydpi/`**, which
outranks any per-density raster on every API level yet is itself outranked by
`mipmap-anydpi-v26` on API 26+ — so it renders only on API 24–25. `tauri android
init`'s own per-density `mipmap-*/ic_launcher*.png` rasters are the **Tauri**
logo (generated from its template, not `bundle.icon`), so the script deletes them
rather than shipping an off-brand pre-v26 icon.

Note Android caches launcher icons aggressively: after an icon change, a full
uninstall + reinstall (or reboot) is needed to see it, since `adb install -r`
does not bust the cache.

## Server Shape

The intended deployment is the Docker Compose Postgres stack on the Ubuntu host:

```sh
docker compose -f docker/compose.pg.yaml up -d --build
docker compose -f docker/compose.pg.yaml ps
```

Keep the compose web and Postgres ports loopback-only. Expose only the web
surface to the tailnet, preferably with Tailscale Serve on the Ubuntu host:

```sh
tailscale serve --bg 18080
```

Use the resulting tailnet web URL in Settings -> Server on Android. Validate
from a tailnet device:

```sh
curl -fsS https://<host>.<tailnet>.ts.net/contract.json
curl -fsS https://<host>.<tailnet>.ts.net/api/stats
curl -fsS "https://<host>.<tailnet>.ts.net/api/range?from=2026-06-01&to=2026-06-07"
```

Postgres remains unexposed to Android. If Tailscale Serve is unavailable, bind
the web port to the host's Tailscale IP by setting `SYMPHONY_PG_WEB_BIND` to
that IP in an untracked `.env` (see [`.env.example`](../../.env.example)); do
not bind web to `0.0.0.0`, and never expose Postgres.
