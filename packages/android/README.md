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
only the web port to the host's Tailscale IP with an operator-local compose
override; do not bind web to `0.0.0.0`, and never expose Postgres.
