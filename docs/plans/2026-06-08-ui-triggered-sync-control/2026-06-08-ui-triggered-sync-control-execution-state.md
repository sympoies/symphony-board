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
- Tracking issue: pending.

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
| 1.1 | pending | Confirm control policy and API shape | none | Decide default mode, advanced options, safety header, and re-entrancy behavior before code changes. |
| 1.2 | pending | Extract a reusable sync + emit runner | none | Preserve existing CLI behavior and dry-run no-write/no-emit semantics. |
| 1.3 | pending | Add the board control daemon | none | One writer-owned scheduler handles loop and manual runs. |
| 1.4 | pending | Wire Docker and nginx without changing the read-only API | none | `/api/range` stays read-only; sync control routes target `board`. |
| 2.1 | pending | Add UI client and state for sync runs | none | Poll status while active and reload active data after completion. |
| 2.2 | pending | Add the visible Sync control | none | Header default action plus advanced Settings options. |
| 2.3 | pending | Cover failures, re-entrancy, and stale-data states | none | Endpoint disabled, active run, provider error, dry-run, and reload failure. |
| 2.4 | pending | Update docs, smoke, and devlog | none | Record shipped behavior only after implementation lands. |

## Session Log

- 2026-06-08: Created this bundle after deciding that browser refresh is enough
  for reloading emitted `contract.json`, but not enough for manual provider sync.
  The chosen design direction is a writer-owned control plane in `board`, with
  the read-only `api` sidecar kept read-only.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `plan-tooling validate --file docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-plan.md --format text --explain` | pass | Plan bundle validates with 0 errors. | local |
