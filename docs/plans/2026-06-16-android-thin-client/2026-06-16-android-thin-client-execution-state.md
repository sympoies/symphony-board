# Android Thin Client Shell Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: ready-to-start; tracking issue not yet opened.
- Target scope: Android internal thin-client APK, portrait-responsive shared UI,
  Ubuntu compose-pg over Tailscale, and real-device validation on Samsung Galaxy
  S24 Plus plus Hanvon N10 Pro.
- Execution window: Sprint 1 Android shell and transport -> Sprint 2 portrait UI
  -> Sprint 3 compose-pg/Tailscale plus device smoke.
- Current task: none (tracking issue not yet opened).
- Next task: Task 1.1 - scaffold Android Tauri thin package.
- Last updated: 2026-06-16
- Branch/commit/PR: `feat/android-thin-client-shell` (local branch for the plan
  bundle; no PR yet).
- Source document: `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-plan.md`
- Plan document: `docs/plans/2026-06-16-android-thin-client/2026-06-16-android-thin-client-plan.md`
- Direct source-doc execution waiver: not applicable
- Tracking issue: tbd (to be opened by `create-plan-tracking-issue` against
  `sympoies/symphony-board`)
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
| 1.1 | pending | Scaffold Android Tauri thin package | - | Add `packages/android` and root scripts; no sidecar/store/tokens. |
| 1.2 | pending | Split desktop and Android server URL defaults | - | Android must not inherit `localhost:8080`; Settings/build env own server URL. |
| 1.3 | pending | Document Android thin-client operation | - | Include Ubuntu compose-pg plus Tailscale Serve guidance. |
| 2.1 | pending | Add responsive render-smoke viewport coverage | - | Include phone/tablet portrait presets and overflow checks. |
| 2.2 | pending | Rework Board navigation for portrait | - | Phone single-lane selector; tablet portrait compact status/spotlight access. |
| 2.3 | pending | Make Graph, controls, and navigation touch-safe | - | No hover-only path; reduced motion and readable focus flow. |
| 2.4 | pending | Replace wide analytics/settings layouts on portrait | - | Repo Analytics card/list alternative; Settings URL controls fit. |
| 3.1 | pending | Validate compose-pg web exposure over Tailscale | - | Expose web only; never Postgres. |
| 3.2 | pending | APK install and target-device portrait smoke | - | Record CSS viewport/DPR and page smoke for both devices. |
