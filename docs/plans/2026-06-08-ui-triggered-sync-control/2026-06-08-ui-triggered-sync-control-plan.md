# Plan: UI-Triggered Sync Control Plane

## Overview

Add a writer-owned manual sync control plane so the web UI can start a real
provider sync + contract emit when the user wants an immediate update or a
provider-connectivity test. The feature must preserve the existing architecture:
`board` remains the only DB writer, `api` stays read-only, and `web` remains a
browser UI served by nginx.

## Read First

- Primary source: docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-discussion-source.md
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none; Task 1.1 owns the explicit
  implementation decisions.

## Scope

- In scope:
  - Confirm the control-plane policy defaults for manual sync mode, full sweep,
    dry-run, source selection, re-entrancy, and local-only safety.
  - Replace the shell-only loop implementation with, or wrap it behind, a single
    writer-owned scheduler/control process that can serialize loop and manual
    runs.
  - Add a small HTTP control surface owned by `board` for creating and reading
    sync runs.
  - Route the control surface through Docker/nginx only when enabled for the
    local UI deployment.
  - Add UI controls and status feedback for starting a sync, observing progress,
    and reloading the active contract/range after completion.
  - Update tests, smoke coverage, README/DESIGN/UI docs, and devlog if the
    feature ships.
- Out of scope:
  - Any provider write action.
  - Making the read-only `api` sidecar a writer.
  - Public multi-user admin authentication.
  - Removing the background loop.
  - Live provider fetches in automated tests.

## Assumptions

1. The first shipped UI action can default to incremental sync because the
   background loop already performs periodic full sweeps.
2. Full sweep and dry-run are useful enough to expose as advanced options, but
   they do not need to be the default button behavior.
3. A same-origin control token/header is sufficient for the local Docker use
   case when combined with an explicit enable flag and local deployment docs.
4. The implementation can reuse `syncSource`, DB helpers, and contract emission
   code without changing the contract schema.

## Sprint 1: Writer-Owned Scheduler And Control API

**Goal**: Establish the backend control plane without changing the UI.
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test`
- Verify: manual and loop runs cannot overlap; dry-run does not write or emit.

### Task 1.1: Confirm control policy and API shape

- **Location**:
  - `docs/DESIGN.md`
  - `README.md`
  - `packages/ui/README.md`
- **Description**: Confirm the exact manual sync behavior before code changes:
  default mode, advanced options, disabled-by-default versus local-compose
  enabled behavior, same-origin token/header, re-entrancy response, and status
  fields.
- **Dependencies**:
  - none
- **Complexity**: 3
- **Acceptance criteria**:
  - The chosen request shape is documented, including `mode`, `dry_run`, and
    optional `source_id`.
  - The chosen response shape is documented, including run id, status, mode,
    source scope, timestamps, counts, and error summaries.
  - Re-entrancy behavior is documented as either active-run rejection or one
    bounded pending run.
  - The safety model states when the route is exposed and how blind cross-site
    POSTs are rejected.
- **Validation**:
  - `plan-tooling validate --file docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-plan.md --format text --explain`

### Task 1.2: Extract a reusable sync + emit runner

- **Location**:
  - `src/cli/sync.ts`
  - `src/cli/emit-contract.ts`
  - `src/sync-runner.ts`
  - `test/sync-engine.test.ts`
  - `test/sync-runner.test.ts`
- **Description**: Move the common "sync selected sources, then emit contract
  unless dry-run or failed" behavior into a reusable module that both CLI and
  daemon paths can call.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Existing CLI behavior remains compatible for `pnpm run sync`, `--dry-run`,
    `--incremental`, `--full`, and `--source`.
  - The runner returns structured per-source results suitable for UI status.
  - Dry-run never opens a write transaction and never emits a new contract.
  - Failed sync preserves the existing contract-emission semantics unless Task
    1.1 explicitly changes them.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

### Task 1.3: Add the board control daemon

- **Location**:
  - `src/cli/sync-daemon.ts`
  - `docker/docker-entrypoint.sh`
  - `docker/Dockerfile`
  - `test/sync-daemon.test.ts`
- **Description**: Add a Node daemon for `SYNC_MODE=loop` that owns the
  background cadence, the manual sync endpoint, run serialization, and in-memory
  status. The shell entrypoint can delegate loop mode to this daemon.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 6
- **Acceptance criteria**:
  - The daemon still performs the first full sweep and mostly-incremental loop
    cadence configured by `INTERVAL` and `FULL_EVERY`.
  - `POST /api/sync-runs` starts a manual run only when no run is active.
  - `GET /api/sync-runs/current` and `GET /api/sync-runs/last` return stable
    status JSON.
  - Manual and scheduled runs share one lock and cannot overlap.
  - The control route can be disabled by configuration.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

### Task 1.4: Wire Docker and nginx without changing the read-only API

- **Location**:
  - `docker/compose.yaml`
  - `docker/ui-nginx.conf`
  - `README.md`
  - `packages/ui/README.md`
- **Description**: Route sync-control requests from `web` to `board`, keep
  `/api/range` routed to the read-only `api` sidecar, and document the local
  safety boundary.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 4
- **Acceptance criteria**:
  - `api` still mounts config/data read-only and only serves range queries.
  - `web` can proxy the sync-control routes to `board` when enabled.
  - Compose does not expose the board control port directly unless explicitly
    requested.
  - Docker healthchecks still prove the first contract and read-only range API
    are ready.
- **Validation**:
  - `pnpm run typecheck`
  - Docker smoke with a seeded or existing local DB.

## Sprint 2: UI Sync UX

**Goal**: Make manual sync usable from the UI without a full browser reload.
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: the UI can start a manual sync, poll status, and reload the active
  contract/range after completion.

### Task 2.1: Add UI client and state for sync runs

- **Location**:
  - `packages/ui/src/contract.ts`
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/model.ts`
  - `packages/ui/test/model.test.ts`
  - `packages/ui/test/contract.test.ts`
- **Description**: Add fetch helpers and app state for control availability,
  current run, last run, loading, error, and completion-triggered data reload.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 4
- **Acceptance criteria**:
  - The UI can detect when sync control is unavailable and hide or disable the
    action.
  - The UI polls current run status only while a run is active.
  - Completion reloads `./contract.json` and, for custom ranges, reloads the
    active `/api/range` response.
  - Existing route, search, filters, range, visibility, and color preferences are
    preserved after data reload.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`

### Task 2.2: Add the visible Sync control

- **Location**:
  - `packages/ui/src/components/Header.tsx`
  - `packages/ui/src/components/SettingsPage.tsx`
  - `packages/ui/src/styles.css`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Add a compact Header action for the default manual sync and
  an advanced Settings section for full sweep, dry-run, and source-scoped runs.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 5
- **Acceptance criteria**:
  - The default Header action is clear, compact, and disabled while a run is
    active.
  - Advanced controls expose full sweep, dry-run, and source selection without
    making the common path noisy.
  - Status text distinguishes "sync running", "dry-run completed", "contract
    reloaded", and error states.
  - UI copy does not imply a dry-run updated the board data.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run build`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 2.3: Cover failures, re-entrancy, and stale-data states

- **Location**:
  - `test/sync-daemon.test.ts`
  - `packages/ui/test/contract.test.ts`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Add regression coverage for common operational states:
  endpoint disabled, active run rejection, provider/source error, dry-run no-op,
  and contract reload failure after a completed run.
- **Dependencies**:
  - Task 1.3
  - Task 2.2
- **Complexity**: 4
- **Acceptance criteria**:
  - A second manual request during an active run does not create a second DB
    writer.
  - Failed sync runs display the error and do not claim data is fresh.
  - Contract reload failures after successful sync are recoverable from the UI.
  - Dry-run status is visible and does not refresh the data view as a write.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`
  - `pnpm --filter @symphony-board/ui run test`

### Task 2.4: Update docs, smoke, and devlog

- **Location**:
  - `README.md`
  - `docs/DESIGN.md`
  - `packages/ui/README.md`
  - `scripts/README.md`
  - `docs/devlog/2026-06.md`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Document the implemented control-plane boundary, manual sync
  behavior, local safety model, and validation. Record the durable feature
  outcome in the devlog if the implementation ships.
- **Dependencies**:
  - Task 2.3
- **Complexity**: 3
- **Acceptance criteria**:
  - Docs explain the difference between browser refresh, reload emitted
    contract, background sync, manual sync, and dry-run.
  - Docs still state that Docker has one writer and that the range API is
    read-only.
  - Render smoke covers the visible sync affordance and disabled/unavailable
    state.
  - Devlog records the issue, PR, and validation evidence after shipping.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run smoke`
  - `pnpm run validate --in packages/ui/public/contract.json`

## Validation Strategy

- Unit: sync runner, daemon lock/re-entrancy, request validation, dry-run
  no-write/no-emit, and UI state helpers.
- Integration: daemon endpoint tests against a fixture or fake source, plus
  contract reload behavior.
- UI: component/model tests for unavailable, running, success, dry-run, and
  error states.
- Docker/manual: endpoint smoke for `/`, `/contract.json`, `/api/range`, sync
  control disabled/enabled behavior, and one manual incremental run against
  configured local sources when credentials are available.

## Risks

- Control endpoint exposure can create unwanted provider traffic. Keep it
  explicit, local-oriented, and protected against blind cross-site POSTs.
- Refactoring the loop into a Node daemon can accidentally change cadence or
  failure behavior. Preserve the existing first-full and `FULL_EVERY` semantics
  with tests.
- Dry-run can mislead users if it appears to refresh data. Keep dry-run status
  separate from contract reload.
- Full sweeps are operationally meaningful because only full complete sweeps can
  tombstone disappeared items/edges. Label full mode clearly and keep existing
  completeness rules.

## Handoff

- Start with Task 1.1. Confirm the safety and re-entrancy defaults before
  editing code.
- Use `execute-plan-tracking-issue` for implementation and state checkpoints.
- Deliver implementation through the normal PR path after validation.
