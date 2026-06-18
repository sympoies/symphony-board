# Plan: Android Thin Client Shell

## Overview

Add an Android thin-client shell for the existing read-only Symphony Board UI,
then make the UI comfortable in portrait on the two target devices: Samsung
Galaxy S24 Plus and Hanvon N10 Pro. The Android app will not contain a store,
provider tokens, or a sync daemon; it will point at the existing Ubuntu Docker
Compose Postgres deployment over Tailscale and consume the same `/contract.json`
and read-only API/control surfaces as the web and macOS thin client. The plan is
single-lane L2 because the work spans packaging, transport defaults, responsive
UI, server reachability, and real-device validation.

## Read First

- Primary source: `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope: Android internal thin-client shell, Android-specific server URL
  defaults, Tauri HTTP permissions for a user-configured Tailscale server URL,
  responsive portrait UI for the two named devices, Ubuntu compose-pg tailnet
  exposure guidance, tests/smoke coverage, APK build, and real-device smoke.
- Out of scope: Android standalone, Play Store release, provider write-backs,
  Android-hosted SQLite/Postgres, Android-hosted sync, direct Postgres access
  from Android, public Internet exposure, and contract or DB schema changes.

## Assumptions

1. This is an internal/self-use Android APK, not a Play Store distribution.
2. The Ubuntu server and both Android devices can join the same tailnet.
3. Android real-device validation can be completed on the Samsung Galaxy S24
   Plus physical 2340 x 1080 portrait device and the Hanvon N10 Pro physical
   2480 x 1860 portrait device.
4. The real CSS viewport size and device pixel ratio will be measured on the
   devices during execution; physical pixels are requirements context, not CSS
   breakpoint values.
5. The Docker compose-pg stack remains the sole writer for the shared store.

## Sprint 1: Android shell and server transport

**Goal**: add an Android-only Tauri thin-client package that builds an APK and
connects to a user-configured server URL without inheriting the macOS
`localhost:8080` default.

**Demo/Validation**:

- Command(s): `pnpm --filter @symphony-board/android run info`, `pnpm android:build:apk`.
- Verify: the APK builds, contains only the UI shell plus Tauri plugins, and has
  no Node sidecar, SQLite/Postgres store, provider tokens, or sync daemon.

### Task 1.1: Scaffold Android Tauri thin package

- **Location**:
  - `package.json`
  - `packages/android/package.json`
  - `packages/android/src-tauri`
  - `packages/android/README.md`
- **Description**: create a new Android thin shell package that reuses
  `packages/ui/dist` as the frontend, installs only the needed Tauri Android
  runtime pieces, and exposes root scripts such as `android:dev`,
  `android:run`, `android:build`, and `android:build:apk`.
- **Dependencies**:
  - none
- **Complexity**: 5
- **Acceptance criteria**:
  - `packages/android` has its own Tauri config and Android target, with a
    unique Android application identifier such as
    `com.sympoies.symphony_board.android`.
  - The Android package reuses the shared React UI build and does not copy or
    fork UI source code.
  - The Android shell includes the HTTP and opener plugins needed by the shared
    runtime adapter.
  - The package README lists Android Studio, Android SDK, NDK, Build Tools,
    command-line tools, `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`, and Rust
    Android targets as prerequisites.
- **Validation**:
  - `pnpm --filter @symphony-board/android run info`.
  - `pnpm android:build:apk`.

### Task 1.2: Split desktop and Android server URL defaults

- **Location**:
  - `packages/ui/src/viewconfig.ts`
  - `packages/ui/test/viewconfig.test.ts`
  - `packages/desktop/src-tauri/tauri.conf.json`
  - `packages/android/src-tauri/tauri.conf.json`
  - `packages/android/src-tauri/capabilities/default.json`
- **Description**: make server URL defaults explicit per shell. Keep the macOS
  thin client defaulting to the local Docker web surface, but make Android use a
  build-time `VITE_SYMPHONY_BOARD_SERVER_URL` when supplied and otherwise start
  with no default so Settings -> Server is the first recovery path. Retain native
  HTTP fetch for Tauri `http://` and `https://` URLs.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 4
- **Acceptance criteria**:
  - macOS thin client still defaults to `http://localhost:8080/` unless the user
    stored another server URL.
  - Android never defaults to `http://localhost:8080/` unless a build or user
    setting explicitly asks for it.
  - A Tailscale HTTPS or HTTP server URL entered in Settings persists and is used
    for `./contract.json`, `./api/range`, `./api/stats`, sync-control probes,
    and diagnostics probes.
  - Android uses the Tauri HTTP plugin for HTTP(S) requests and the opener plugin
    for provider links.
  - For the first internal APK, the Android HTTP plugin scope may match the
    current desktop broad `http://*:*` and `https://*:*` capability. This is an
    accepted risk only for internal/self-use distribution; a public distribution
    must narrow the scope or add an allowlist decision first.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm android:build:apk`.

### Task 1.3: Document Android thin-client operation

- **Location**:
  - `README.md`
  - `packages/android/README.md`
  - `docs/DESIGN.md`
- **Description**: document the Android client as the third app surface:
  Docker/server-backed thin Android shell, no local data store, no tokens, no
  sync daemon, portrait-only validation target for the two named devices, and
  server URL configuration over Tailscale.
- **Dependencies**:
  - Task 1.1
  - Task 1.2
- **Complexity**: 3
- **Acceptance criteria**:
  - README clearly distinguishes macOS thin, macOS standalone, and Android thin.
  - DESIGN records that Android shares the UI/contract product surface and does
    not alter the provider/read-only boundary.
  - Android docs include the preferred Ubuntu deployment shape: compose-pg keeps
    `web` bound to localhost and Tailscale Serve proxies only the web surface to
    the tailnet. Postgres remains unexposed to Android.
- **Validation**:
  - `pnpm run typecheck`.
  - `pnpm --filter @symphony-board/ui run build`.

## Sprint 2: Portrait UI for phone and e-ink tablet

**Goal**: make the shared UI responsive enough that the Android shell is usable
in portrait on the S24 Plus and Hanvon N10 Pro without pinch zoom, landscape, or
wide horizontal page scrolling.

**Demo/Validation**:

- Command(s): `pnpm --filter @symphony-board/ui run build`, `pnpm --filter @symphony-board/ui run test`, `pnpm --filter @symphony-board/ui run smoke`.
- Verify: render smoke covers phone portrait and tablet portrait viewport
  presets, and real-device smoke records the actual CSS viewport/DPR for both
  devices.

### Task 2.1: Add responsive render-smoke viewport coverage

- **Location**:
  - `packages/ui/scripts/render-smoke.mjs`
  - `packages/ui/test/`
  - `packages/ui/src/styles.css`
- **Description**: extend render-smoke so it can assert layout at desktop,
  phone-portrait, and tablet-portrait viewport presets. The smoke should check
  page-level overflow, console errors, and that the core page controls are
  visible after navigation.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - Render smoke includes a narrow phone portrait preset and a tablet portrait
    preset. Initial preset dimensions may be approximate, but execution must
    update or annotate them with the measured real-device CSS viewport/DPR.
  - Board, Graph, Activity, Commits, Repo Analytics, Settings, and hidden
    Diagnostics render without console errors at all presets.
  - At phone and tablet presets, `document.documentElement.scrollWidth` does not
    materially exceed `clientWidth` for the main app shell.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run smoke`.

### Task 2.2: Rework Board navigation for portrait

- **Location**:
  - `packages/ui/src/components/FullBoard.tsx`
  - `packages/ui/src/styles.css`
  - `packages/ui/src/model.ts`
  - `packages/ui/test/model.test.ts`
- **Description**: keep the desktop 7-lane board intact, but add portrait board
  modes. On phone portrait, show a lane selector with counts and one card column
  at a time. On tablet/e-ink portrait, avoid a 7-column horizontal strip; show
  status lanes in a compact multi-row layout and keep spotlight lanes reachable
  through a stable selector or section below.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 6
- **Acceptance criteria**:
  - Desktop board behavior is unchanged.
  - S24 Plus portrait can switch among all seven lanes without horizontal board
    scrolling.
  - Hanvon N10 Pro portrait can read status lanes and spotlight lanes without
    requiring landscape mode.
  - Lane counts, empty-lane states, collapsed lane preferences, and card
    interactions remain consistent with the existing board model.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm --filter @symphony-board/ui run smoke`.

### Task 2.3: Make Graph, shared controls, and navigation touch-safe

- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/components/GraphPage.tsx`
  - `packages/ui/src/components/TimeRangeControls.tsx`
  - `packages/ui/src/components/Header.tsx`
  - `packages/ui/src/styles.css`
- **Description**: preserve the desktop side-list plus canvas graph, but make
  portrait layouts prioritize list/focus navigation with canvas as a secondary
  view on phone and a low-motion readable split/stack on tablet. Ensure tabs,
  date controls, filters, and sync/status controls have reliable touch targets
  and do not overflow.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Graph overview and focus flows are reachable on phone without relying on
    hover or landscape.
  - N10 Pro portrait uses reduced motion when requested and avoids color-only
    semantics for state.
  - Page tabs and time-range controls remain visible and usable on both target
    portrait devices.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run smoke`.

### Task 2.4: Replace wide analytics/settings layouts on portrait

- **Location**:
  - `packages/ui/src/components/RepoAnalyticsPage.tsx`
  - `packages/ui/src/components/SettingsPage.tsx`
  - `packages/ui/src/components/DebugPage.tsx`
  - `packages/ui/src/components/ServerConnectionForm.tsx`
  - `packages/ui/src/styles.css`
- **Description**: provide compact portrait renderings for wide tables and
  settings forms. Repo Analytics should switch from a 1560px table to cards or a
  ranked compact list; Settings and Diagnostics should wrap controls and rows
  without clipping long repo paths or server URLs.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Repo Analytics no longer depends on a wide horizontal table in phone or
    tablet portrait.
  - Settings -> Server can enter, save, clear, and display long Tailscale HTTPS
    URLs on both devices.
  - Diagnostics remains readable enough to verify `/api/stats` and `/api/logs`
    availability without rotating the device.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm --filter @symphony-board/ui run smoke`.

## Sprint 3: Ubuntu compose-pg tailnet path and real devices

**Goal**: prove the Android APK can use the Ubuntu Docker compose-pg deployment
through Tailscale on the two target devices.

**Demo/Validation**:

- Command(s): `pnpm run test:pg-compose`, `pnpm android:build:apk`, device-side
  smoke checklist.
- Verify: Android loads the same server contract/range/stats surfaces over
  Tailscale, not direct DB access.

### Task 3.1: Validate compose-pg web exposure over Tailscale

- **Location**:
  - `docker/compose.pg.yaml`
  - `packages/android/README.md`
  - `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-execution-state.md`
- **Description**: keep compose-pg's Postgres and web ports loopback-only by
  default, then expose only the web surface to the tailnet. Preferred operator
  shape: `tailscale serve --bg 18080` on the Ubuntu host after
  `docker compose -f docker/compose.pg.yaml up -d --build` is healthy; record the
  resulting HTTPS URL in the execution-state evidence. If Serve is unavailable,
  use a compose override that binds only the web port to the Ubuntu Tailscale IP,
  never `0.0.0.0`, and never expose Postgres.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 4
- **Acceptance criteria**:
  - From a tailnet device, `GET /contract.json`, `GET /api/range?...`, and
    `GET /api/stats` succeed through the chosen Tailscale URL.
  - Postgres is not reachable from the Android device.
  - The Android app server URL is the Tailscale web URL, not a Docker-internal,
    localhost, or public Internet URL.
- **Validation**:
  - `pnpm run test:pg-compose`.
  - `curl -fsS <tailscale-url>/contract.json`.
  - `curl -fsS <tailscale-url>/api/stats`.

### Task 3.2: APK install and target-device portrait smoke

- **Location**:
  - `packages/android`
  - `packages/ui/src/`
  - `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-execution-state.md`
- **Description**: install the APK on the Samsung Galaxy S24 Plus and Hanvon N10
  Pro, configure the Tailscale server URL, and walk every page in portrait. Record
  each device's `window.innerWidth`, `window.innerHeight`, `devicePixelRatio`,
  Android/WebView version when available, and the pass/fail result for each page.
- **Dependencies**:
  - Task 1.1
  - Task 1.2
  - Task 2.2
  - Task 2.3
  - Task 2.4
  - Task 3.1
- **Complexity**: 5
- **Acceptance criteria**:
  - APK installs and opens on both devices.
  - Settings -> Server accepts the Tailscale URL and the app reloads
    `/contract.json`.
  - Board, Graph, Activity, Commits, Repo Analytics, Settings, and Diagnostics
    are usable in portrait without pinch zoom or required landscape.
  - Provider links open externally.
  - Sync-control affordances behave according to server capability; config/token
    editing remains hidden on the Docker deployment unless explicitly enabled.
- **Validation**:
  - Manual device smoke checklist recorded in the execution-state ledger.
  - `pnpm android:build:apk`.

## Testing Strategy

- Unit: `pnpm run typecheck && pnpm test`; `pnpm --filter @symphony-board/ui run test`.
- Integration: `pnpm --filter @symphony-board/ui run build`; responsive
  `pnpm --filter @symphony-board/ui run smoke`; `pnpm android:build:apk`.
- Server: `pnpm run test:pg-compose` when Docker is available; curl
  `/contract.json`, `/api/range`, and `/api/stats` through the Tailscale URL.
- E2E/manual: install and smoke the APK on Samsung Galaxy S24 Plus portrait and
  Hanvon N10 Pro portrait over Tailscale.

## Risks & gotchas

- Android CSS breakpoints must be based on measured CSS viewport sizes, not the
  physical pixel dimensions.
- Android WebView and e-ink refresh behavior may expose layout or motion issues
  that desktop Chrome smoke will not catch.
- The current macOS thin client hardcodes a Tauri default server URL; Android
  must avoid inheriting that local-only default.
- Broad HTTP plugin scope is acceptable only for this internal APK. A broader
  release needs a narrower allowlist or persisted-scope design.
- Tailscale Serve and CLI syntax should be checked on the Ubuntu host because
  Serve command behavior changed in Tailscale 1.52.
- Do not expose Postgres, provider tokens, config files, or a Docker writer
  surface to the Android app beyond the existing web proxy capabilities.

## Rollback plan

- Remove `packages/android` and the root Android scripts.
- Revert Android-specific server default changes while preserving the existing
  macOS thin-client behavior.
- Revert portrait UI changes page by page; desktop layout should remain covered
  by the existing render smoke.
- On the Ubuntu host, run `tailscale serve reset` or remove the compose override
  used for the web proxy. Leave the Postgres volume untouched unless explicitly
  tearing down the compose-pg deployment.
