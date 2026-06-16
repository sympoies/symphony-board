# Android Thin Client Shell Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: blocked on real-device validation.
- Target scope: Android internal thin-client APK, portrait-responsive shared UI,
  Ubuntu compose-pg over Tailscale, and real-device validation on Samsung Galaxy
  S24 Plus plus Hanvon N10 Pro.
- Execution window: Sprint 1 Android shell and transport -> Sprint 2 portrait UI
  -> Sprint 3 compose-pg/Tailscale plus device smoke.
- Current task: Task 3.2 real-device smoke is blocked by unavailable target
  devices.
- Next task: install the debug APK on Samsung Galaxy S24 Plus and Hanvon N10 Pro,
  then record portrait CSS viewport, DPR, Android/WebView version, and page smoke
  result.
- Last updated: 2026-06-17
- Branch/commit/PR: `feat/android-thin-client-shell` / PR
  <https://github.com/sympoies/symphony-board/pull/235>.
- Source document: `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-plan.md`
- Plan document: `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-plan.md`
- Direct source-doc execution waiver: not applicable
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/234>
- Source snapshot: pending - posted by `create-plan-tracking-issue` at issue open
- Plan snapshot: pending - posted by `create-plan-tracking-issue` at issue open
- Initial state snapshot: pending - posted by `create-plan-tracking-issue` at
  issue open

## Validation Plan

- Bundle:
  - `plan-tooling validate --file docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-plan.md --format text --explain`.
- Tracker open:
  - Dry-run `plan-issue record open --profile tracking`.
  - Live `plan-issue record open --profile tracking`.
  - Read-back and audit the opened issue with `plan-issue record audit --profile
    tracking --expect-visible`.
- Code:
  - `pnpm run typecheck && pnpm test`.
  - `pnpm --filter @symphony-board/ui run build`.
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm --filter @symphony-board/ui run smoke`.
  - `pnpm android:build:apk`.
- Server:
  - `pnpm run test:pg-compose` when Docker is available.
  - `curl -fsS <tailscale-url>/contract.json`.
  - `curl -fsS <tailscale-url>/api/stats`.
  - `curl -fsS "<tailscale-url>/api/range?from=YYYY-MM-DD&to=YYYY-MM-DD"`.
- Devices:
  - Samsung Galaxy S24 Plus portrait: record CSS viewport width/height,
    `devicePixelRatio`, Android/WebView version when available, and page smoke
    result.
  - Hanvon N10 Pro portrait: record CSS viewport width/height,
    `devicePixelRatio`, Android/WebView version when available, and page smoke
    result.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Scaffold Android Tauri thin package | `pnpm android:init` pass; `pnpm android:build:apk` pass; debug APK install/launch smoke pass on `symphony_board_api36_16k` | Android SDK/NDK/JDK and emulator are configured; `src-tauri/gen/android` is generated locally and ignored. |
| 1.2 | done | Split desktop and Android server URL defaults | pnpm --filter @symphony-board/ui run test pass; pnpm --filter @symphony-board/ui run smoke pass | Android must not inherit `localhost:8080`; Settings/build env own server URL. |
| 1.3 | done | Document Android thin-client operation | README.md, docs/DESIGN.md, packages/android/README.md updated | Include Ubuntu compose-pg plus Tailscale Serve guidance. |
| 2.1 | done | Add responsive render-smoke viewport coverage | pnpm --filter @symphony-board/ui run smoke pass with phone/tablet portrait presets | Include phone/tablet portrait presets and overflow checks. |
| 2.2 | done | Rework Board navigation for portrait | pnpm --filter @symphony-board/ui run smoke pass: phone board one selected lane, tablet multi-lane | Phone single-lane selector; tablet portrait compact status/spotlight access. |
| 2.3 | done | Make Graph, controls, and navigation touch-safe | pnpm --filter @symphony-board/ui run smoke pass: graph stacks list/canvas in portrait | No hover-only path; reduced motion and readable focus flow. |
| 2.4 | done | Replace wide analytics/settings layouts on portrait | pnpm --filter @symphony-board/ui run smoke pass: repo analytics compact, settings/debug no page overflow | Repo Analytics card/list alternative; Settings URL controls fit. |
| 3.1 | done | Validate compose-pg web exposure over Tailscale | g14 compose-pg healthy; Postgres remains loopback-only on the host; web exposure verified over the tailnet for /contract.json, /api/stats, and /api/range; macOS thin desktop was rebuilt/opened against the g14 server URL | Tailscale Serve is disabled by tailnet policy, so the host uses an operator-local compose override that binds only the web service to the Tailscale interface. The Gamania source is excluded from g14 runtime config until VPN is available. |
| 3.2 | blocked | APK install and target-device portrait smoke | Debug APK install/launch smoke passes on `symphony_board_api36_16k`; Samsung Galaxy S24 Plus and Hanvon N10 Pro devices are not attached | Automated portrait smoke uses phone/tablet presets; real device CSS viewport/DPR remains required. |
