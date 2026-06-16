# Android Thin Client Implementation Handoff

- Status: ready for L2 plan tracking
- Date: 2026-06-16
- Source: user discussion in the current Codex session, local repo inspection,
  Tauri v2 documentation, and Tailscale documentation.
- Intended next step: open a plan tracking issue, then execute the plan with
  `execute-plan-tracking-issue`.

## Execution

This document feeds one L2 plan executed as a single-lane Android thin-client
delivery.

- Recommended plan: `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-plan.md`
- Recommended execution state: `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-execution-state.md`
- Status: ready to implement immediately
- Next-task source: this document

## Evidence Index

- [U1] User requested an Android version for phones/tablets, portrait-only, with
  support scoped to Samsung Galaxy S24 Plus physical 2340 x 1080 and Hanvon N10
  Pro physical 2480 x 1860.
- [U2] User clarified the Android app should be only a thin-client shell, with
  backend service from the Docker Compose Postgres deployment on an Ubuntu server
  reached over Tailscale.
- [U3] User accepted the L2 recommendation and asked for a plan that the next
  execution step can finish directly.
- [F1] `README.md:8-15` defines the product surface as contract plus UI; the DB
  is an implementation store.
- [F2] `README.md:35-47` lists the current UI pages, Docker writer/read-only
  split, and macOS thin client behavior.
- [F3] `README.md:204-216` describes compose services: `board` writer, read-only
  `api`, and read-only `web` proxy.
- [F4] `README.md:245-247` says compose-pg uses loopback web/Postgres ports and
  separate Postgres/contract volumes.
- [F5] `README.md:316-328` says the macOS thin client contains no SQLite,
  provider tokens, or sync daemon and uses Settings -> Server for hosted servers.
- [F6] `README.md:419-424` lists root, UI, and Postgres compose validation
  gates.
- [F7] `docs/DESIGN.md:361-363` states the UI is a read-only consumer and never
  reaches DB, sources, provider APIs, or the configured store.
- [F8] `docs/DESIGN.md:427-453` records the Docker writer/read-only/web split and
  the `/contract.json` plus `/api/range` proxy surface.
- [F9] `docs/DESIGN.md:569-578` records that config mutations are disabled by
  default in Docker and hidden when the capability probe is disabled.
- [F10] `packages/ui/src/runtime.ts:34-39`,
  `packages/ui/src/contract.ts:20-51`, and
  `packages/ui/src/viewconfig.ts:100-128` show current Tauri native HTTP fetch,
  server URL resolution, and the hardcoded Tauri localhost default.
- [F11] `packages/ui/src/styles.css:355-388`,
  `packages/ui/src/styles.css:579-594`,
  `packages/ui/src/styles.css:1366-1417`, and
  `packages/ui/src/styles.css:1441-1451` show desktop-first Board/Graph layouts,
  limited phone rules, and the wide Repo Analytics table.
- [F12] `packages/desktop/src-tauri/capabilities/default.json:6-15` shows the
  current desktop HTTP plugin scope allows `http://*:*` and `https://*:*`.
- [W1] Tauri v2 CLI docs list Android commands including `android init`,
  `android dev`, `android build`, and `android run`, and state Android build
  generates APKs/AABs: <https://v2.tauri.app/reference/cli/>.
- [W2] Tauri prerequisites docs list Android Studio, SDK platform/tools, NDK,
  Build Tools, command-line tools, `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`, and
  Rust Android targets: <https://v2.tauri.app/start/prerequisites/>.
- [W3] Tauri HTTP plugin docs show URL scopes are configured in
  `src-tauri/capabilities/default.json` and allowed URLs can be constrained:
  <https://v2.tauri.app/plugin/http-client/>.
- [W4] Tailscale Serve docs say Serve shares a local service within a tailnet,
  can reverse-proxy local ports, and is distinct from public Funnel exposure:
  <https://tailscale.com/docs/reference/tailscale-cli/serve> and
  <https://tailscale.com/docs/features/tailscale-serve>.
- [A1] `agent-docs preflight --intent project-dev` passed with required policy
  docs present and no project-dev validation contract declared.
- [A2] `plan-archive catalog --grep android --deep` found no matching archived
  Android plan.
- [I1] Because the existing macOS thin client already consumes server HTTP
  surfaces without local data ownership, an Android thin shell is feasible by
  reusing the UI and Tauri HTTP transport while excluding standalone/runtime
  sidecars.

## Purpose

Deliver Android access to Symphony Board for the user's two portrait devices
without changing the data ownership model. The phone/tablet app should be a
shell around the shared read-only UI, backed by the existing Ubuntu compose-pg
deployment over Tailscale.

## Confirmed Facts

- The existing product boundary is contract plus UI, not the underlying DB.
  [F1]
- Docker compose-pg already provides the intended server-side split: one writer,
  read-only API sidecar, and web sidecar serving `/contract.json` and proxying
  read-only/control routes. [F3] [F8]
- The current macOS thin client has the right architectural boundary for
  Android: it contains UI only and keeps SQLite, tokens, sync, and API sidecars
  server-side. [F5]
- The UI already has server URL plumbing and Tauri native HTTP for HTTP(S), but
  the current Tauri default is desktop-local `http://localhost:8080/`; Android
  must not inherit that default. [F10]
- The UI is not yet portrait-ready for the target devices. Board is a horizontal
  seven-column row, Graph assumes list plus canvas, and Repo Analytics uses a
  1560px table. [F11]
- compose-pg binds web and Postgres ports to loopback by default; this is a good
  baseline, but phones cannot reach Ubuntu `127.0.0.1` directly. [F4]
- Tailscale Serve can proxy a local service into the tailnet without making it a
  public Funnel service. [W4]

## Decisions

- Build an Android **thin-client shell only**. No Android standalone, no local
  store, no provider tokens, no Android sync daemon, and no direct DB access.
  [U2] [F5] [F7]
- Use Tauri v2 for Android because the repo already uses Tauri for the thin
  shell, the shared UI already has Tauri runtime adapters, and Tauri supports
  Android build/dev commands. [F10] [W1]
- Create a separate `packages/android` package rather than overloading the
  existing macOS-only `packages/desktop` package. The Android package should
  reuse the shared UI build, not fork UI source.
- Keep the macOS thin-client localhost default, but make Android default to no
  server URL unless `VITE_SYMPHONY_BOARD_SERVER_URL` is supplied at build time or
  the user has entered a Settings -> Server value.
- Preferred server exposure is Tailscale Serve proxying compose-pg's loopback
  web port to the tailnet. Do not expose Postgres or the provider config/token
  files to Android. [F4] [F8] [W4]
- Treat physical pixel dimensions as device identification and manual validation
  targets, not CSS breakpoints. Execution must measure CSS viewport and DPR on
  each device before final acceptance. [U1]
- The first APK is internal/self-use. For that scope, matching the current broad
  Tauri HTTP permission scope is acceptable; public distribution requires a new
  allowlist/security decision. [F12] [W3]

## Scope

- Android Tauri package and root scripts.
- Android server URL/default behavior.
- Shared UI responsive layout changes for Board, Graph, Activity, Commits, Repo
  Analytics, Settings, and Diagnostics.
- Render-smoke coverage for phone and tablet portrait presets.
- Ubuntu compose-pg plus Tailscale Serve runbook and validation.
- APK build and real-device smoke for the two target devices.

## Non-Scope

- Android standalone.
- Play Store/AAB release signing beyond a local/internal APK.
- Contract major/minor changes.
- DB schema or sync engine changes.
- Provider write-backs.
- Any direct Android connection to Postgres.
- Public Internet exposure through Tailscale Funnel, reverse proxies, or
  `0.0.0.0` compose bindings.

## Implementation Boundaries

- Android is a consumer shell. Server data and provider secrets remain on the
  Ubuntu compose-pg deployment. [F7]
- The Android app may call `/contract.json`, `/api/range`, `/api/stats`,
  `/api/logs`, and sync-control routes through the same web proxy as the UI.
  Config/token editing must remain hidden on Docker unless the server capability
  explicitly enables it. [F8] [F9]
- Responsive UI work must preserve desktop behavior and existing browser/web
  deployment behavior.
- Tailscale configuration belongs in docs/runbook and validation evidence, not
  in committed secrets or machine-local config.

## Requirements

- Build an installable Android APK from the repo using pnpm/Tauri scripts.
- The Android shell must use the shared React UI and contract package.
- Server URL entry must handle Tailscale HTTPS hostnames and tailnet HTTP URLs.
- Android must not default to localhost unless explicitly configured.
- Board must be usable in portrait on both target devices without seven-column
  horizontal scrolling.
- Graph focus/list flow must be usable in portrait without hover-only actions.
- Repo Analytics must have a portrait alternative to the 1560px table.
- Settings -> Server must fit long Tailscale URLs.
- The N10 Pro path must avoid unnecessary animation and color-only semantics.
- Validation must include automated UI smoke plus manual real-device smoke.

## Acceptance Criteria

- `pnpm android:build:apk` produces an APK.
- `pnpm run typecheck && pnpm test` passes.
- `pnpm --filter @symphony-board/ui run build`, `pnpm --filter
  @symphony-board/ui run test`, and `pnpm --filter @symphony-board/ui run smoke`
  pass with portrait viewport coverage.
- `pnpm run test:pg-compose` passes when Docker is available.
- Ubuntu compose-pg web is reachable from tailnet devices through the chosen
  Tailscale URL, while Postgres is not reachable from Android.
- APK installs and loads the server on Samsung Galaxy S24 Plus portrait and
  Hanvon N10 Pro portrait.
- Each real-device smoke records CSS viewport width, CSS viewport height, DPR,
  server URL shape, pages checked, and pass/fail notes.

## Validation Plan

- Bundle: `plan-tooling validate --file docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-plan.md --format text --explain`.
- Core repo: `pnpm run typecheck && pnpm test`.
- UI: `pnpm --filter @symphony-board/ui run build`; `pnpm --filter
  @symphony-board/ui run test`; `pnpm --filter @symphony-board/ui run smoke`.
- Android: `pnpm --filter @symphony-board/android run info`;
  `pnpm android:build:apk`.
- Server: `pnpm run test:pg-compose`; curl `/contract.json`, `/api/range`, and
  `/api/stats` through the Tailscale URL.
- Devices: install and smoke the APK on the two named devices in portrait.

## Risks And Guardrails

- Android WebView may differ from desktop Chrome; real devices are required
  before closeout.
- Tailscale Serve syntax changed in Tailscale 1.52, so execution should verify
  `tailscale serve --help` on the Ubuntu host before recording the operator
  command as final. [W4]
- Broad HTTP plugin scope is a conscious internal-APK tradeoff, not a public
  release posture. [F12] [W3]
- Do not create Android-specific contract behavior or a forked UI.
- Do not commit `.env`, config files with secrets, runtime contracts, DB dumps,
  or Tailscale machine-specific state.

## Retention Intent

This bundle is coordination state for an L2 tracker. After implementation and
closeout, archive the plan bundle through the plan-tracking closeout/archive
workflow unless the Android thin-client design needs promotion into durable
README/DESIGN content.

## Read First References

- `README.md`
- `docs/DESIGN.md`
- `docs/CONTRACT.md`
- `packages/ui/src/runtime.ts`
- `packages/ui/src/contract.ts`
- `packages/ui/src/viewconfig.ts`
- `packages/ui/src/styles.css`
- `docker/compose.pg.yaml`

