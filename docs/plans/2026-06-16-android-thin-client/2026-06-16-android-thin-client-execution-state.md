# Android Thin Client Shell Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: complete - Samsung Galaxy S24 Plus and Hanvon N10 Pro (e-ink)
  real-device portrait smoke both passed; the deferred e-ink follow-up #242 is
  closed.
- Target scope: Android internal thin-client APK, portrait-responsive shared UI,
  Ubuntu compose-pg over Tailscale, and real-device validation on Samsung Galaxy
  S24 Plus plus Hanvon N10 Pro.
- Execution window: Sprint 1 Android shell and transport -> Sprint 2 portrait UI
  -> Sprint 3 compose-pg/Tailscale plus device smoke.
- Current task: complete - Task 3.2 done; Samsung Galaxy S24 Plus (2026-06-18)
  and Hanvon N10 Pro e-ink (2026-06-23) portrait smoke both passed against a
  Postgres deployment over Tailscale.
- Next task: none - closeout complete; no deferred follow-up remains (#242
  closed).
- Last updated: 2026-06-23
- Branch/commit/PR: plan delivered via `feat/android-thin-client-shell` / PR
  <https://github.com/sympoies/symphony-board/pull/235> (merged); the deferred
  e-ink smoke (#242) was completed on 2026-06-23 during the low-memory Android
  board work in PR <https://github.com/sympoies/symphony-board/pull/403>.
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

## Device Smoke Results

### Samsung Galaxy S24 Plus (2026-06-18) - PASS

- Device: Samsung SM-S9260, Android 16 (SDK 36), WebView/Chromium 149.0.7827.
- Physical 1440 x 3120 at density 560; measured CSS viewport **411 x 891**,
  `devicePixelRatio` **3.5**.
- Build: arm64-v8a debug APK from the PR head, server URL configured to a
  compose-pg deployment over Tailscale; data path is the Tauri HTTP plugin to
  the Postgres-backed web surface (contract 3.4.0, 3 sources, schema v4).
- Every page walked in portrait with **no horizontal overflow**
  (`scrollWidth == clientWidth == 411` on each) and no JS console errors / no
  crash:

  | Page | Result | Note |
  | --- | --- | --- |
  | Board | pass | single-lane selector with counts; tab nav wraps to two rows |
  | Graph | pass | controls/legend/filters prioritized, canvas secondary |
  | Activity | pass | rhythm overview + heatmap render before the feed |
  | Commits | pass | SCM log cards with branch + SHA chips |
  | Repo Analytics | pass | compact metric-card grid, no wide table |
  | Settings | pass | long Tailscale server URL fits; theme + range controls usable |
  | Diagnostics | pass | full store/stats readout reachable in portrait |

- Capability-gated config/token editing stays hidden on the read-only Docker
  deployment, as designed.
- Residual: external provider-link opening uses correct `target="_blank"`
  / `rel="noopener"` anchors and the WebView does not navigate in-app; firing the
  system browser needs a real touch and was not exercised by the automated
  harness (same opener plugin as the validated desktop thin client).

### Hanvon N10 Pro (e-ink) (2026-06-23) - PASS

- Device: Hanvon N10ProIII, Android 14 (SDK 34), WebView/Chromium
  116.0.5845.195.
- Physical 1860 x 2480 at density 440; measured CSS viewport **677 x 902**,
  `devicePixelRatio` **2.75**.
- Build: Symphony Board Android debug APK (app version 1.7.4) from the
  `feat/android-board-scope` work, server URL configured to a redacted non-local
  Tailscale HTTPS deployment, board-data scope `3d`, Paper theme active.
- Every checked page rendered in portrait with **no page-level horizontal
  overflow** (`document` / `body` `scrollWidth == clientWidth == 677`) on the
  CDP-driven route walk:

  | Page | Result | Note |
  | --- | --- | --- |
  | Board | pass | card grid renders; external provider links remain safe anchors |
  | Graph | pass | graph page renders without page overflow |
  | Activity | pass | feed rows render; provider links remain external |
  | Commits | pass | commit rows render without page overflow |
  | Repo Analytics | pass | compact analytics card surface renders without page overflow |
  | Settings | pass | the Board data + Wide layout device-local controls are usable; long Tailscale URL fits |

- E-ink finding that motivated the follow-up: the full `/contract.json`
  (~15 MB decoded) reliably OOM-crashed the WebView render process on this
  device. The per-device **Board data** scope fixes it - a windowed `3d` board
  loads from `/api/range` without the crash. The Paper theme renders legibly, and
  the per-device Wide layout toggle plus the Live-tab visibility fix were
  exercised on-device. These low-memory fixes shipped in PR #403.

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
| 2.5 | done | Acceptance mobile UI adjustments | `pnpm --filter @symphony-board/ui run build` pass; `pnpm --filter @symphony-board/ui run smoke` pass with phone filter/Activity checks; `pnpm --filter @symphony-board/ui run test` pass; `pnpm run typecheck && pnpm test` pass | Phone facet filters now collapse behind an active-count button while date range controls stay visible; phone Activity shows the rhythm panel before a shorter feed. |
| 3.1 | done | Validate compose-pg web exposure over Tailscale | private deployment host compose-pg healthy; Postgres remains loopback-only on the host; web exposure verified over the tailnet for /contract.json, /api/stats, and /api/range; macOS thin desktop was rebuilt/opened against the private deployment host server URL | Tailscale Serve is disabled by tailnet policy, so the host uses an operator-local compose override that binds only the web service to the Tailscale interface. The Gamania source is excluded from private deployment host runtime config until VPN is available. |
| 3.2 | done | APK install and target-device portrait smoke | Samsung Galaxy S24 Plus portrait smoke PASS (arm64 debug APK, CSS 411x891 @ DPR 3.5, Android 16 / WebView 149, no overflow on any page, data via Tailscale compose-pg). Hanvon N10 Pro e-ink portrait smoke PASS (2026-06-23, CSS 677x902 @ DPR 2.75, Android 14 / WebView 116, windowed board-data scope avoids the WebView OOM, no page overflow) - see Device Smoke Results above. | Both target devices validated on real hardware; the deferred e-ink portion (#242) is complete. |
