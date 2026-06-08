# UI-Triggered Sync Control Plane Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: planned; tracking issue pending.
- Target scope: UI-triggered manual sync control plane while preserving `board`
  as the sole writer.
- Execution window: Sprint 1 (writer scheduler/control API) -> Sprint 2 (UI
  sync UX), serial.
- Current task: not started.
- Next task: Task 1.1, confirm control policy and API shape.
- Last updated: 2026-06-08
- Branch/commit/PR: none.
- Source document: docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-plan.md
- Direct source-doc execution waiver: not applicable.
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/92>

## Validation Plan

- Bundle creation: `plan-tooling validate --file docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-plan.md --format text --explain`.
- Sprint 1: `pnpm run typecheck && pnpm test`.
- Sprint 2: `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`.
- Final implementation: Docker smoke for `/`, `/contract.json`, existing
  `/api/range`, sync control disabled/enabled behavior, and one manual
  incremental run when local credentials are available.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Confirm control policy and API shape | Control policy + API shape documented in docs/DESIGN.md 'UI-Triggered Sync Control Plane' (request/response shape, re-entrancy=active-run-reject, safety: SYNC_CONTROL_ENABLED + X-Symphony-Sync-Control header, dry-run no-write/no-emit). | Decide default mode, advanced options, safety header, and re-entrancy behavior before code changes. |
| 1.2 | done | Extract a reusable sync + emit runner | src/contract/emit.ts (shared emit) + src/sync-runner.ts (executeSyncRun/runConfiguredSync); sync.ts + emit-contract.ts refactored to share. test/sync-runner.test.ts (6 tests) green; dry-run no-emit + fail-no-emit verified. | Preserve existing CLI behavior and dry-run no-write/no-emit semantics. |
| 1.3 | done | Add the board control daemon | src/cli/sync-daemon.ts: SyncController single-lock + HTTP control surface (POST /api/sync-runs, GET current/last, /api/sync-control). test/sync-daemon.test.ts (5 tests) green; daemon boot smoke OK (healthz/control/202/409/last + SIGTERM). | One writer-owned scheduler handles loop and manual runs. |
| 1.4 | done | Wire Docker and nginx without changing the read-only API | docker-entrypoint.sh loop->exec daemon; compose board SYNC_CONTROL_ENABLED/PORT (port not published); ui-nginx.conf routes /api/sync-control + /api/sync-runs to board, /api/range stays on read-only api. README + DESIGN updated. | `/api/range` stays read-only; sync control routes target `board`. |
| 2.1 | done | Add UI client and state for sync runs | packages/ui/src/useSync.ts (probe + poll-while-active + reload-on-fresh) + contract.ts client (fetchSyncControl/current/last/startSyncRun, same-origin header) + model.ts types/helpers; App.tsx reloadData preserves route/filters/range. UI tests 57/57. | Poll status while active and reload active data after completion. |
| 2.2 | done | Add the visible Sync control | Header Sync action (incremental/all) + SyncControls advanced section (mode/source/dry-run) in Settings; styles.css; states distinguish running/dry-run/reloaded/error. render-smoke asserts affordance + running/done + settings controls. | Header default action plus advanced Settings options. |
| 2.3 | done | Cover failures, re-entrancy, and stale-data states | Daemon re-entrancy/disabled/header guards in test/sync-daemon.test.ts; UI client 202/409-adopt + unavailable(null) in contract.test.ts; dry-run/fresh-data gating in model.test.ts; render-smoke covers running->reloaded. 0 console errors. | Endpoint disabled, active run, provider error, dry-run, and reload failure. |
| 2.4 | done | Update docs, smoke, and devlog | README + DESIGN + packages/ui/README document browser-reload vs reload-contract vs background vs manual vs dry-run + one-writer/read-only invariants; render-smoke covers the affordance; devlog 2026-06 entry added. | Record shipped behavior only after implementation lands. |

## Session Log

- 2026-06-08: Created this bundle after deciding that browser refresh is enough
  for reloading emitted `contract.json`, but not enough for manual provider sync.
  The chosen design direction is a writer-owned control plane in `board`, with
  the read-only `api` sidecar kept read-only.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `plan-tooling validate --file docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-plan.md --format text --explain` | pass | Plan bundle validates with 0 errors. | local |
