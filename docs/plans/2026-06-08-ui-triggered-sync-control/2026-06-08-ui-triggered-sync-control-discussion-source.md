# UI-Triggered Sync Control Plane Source

- Status: design framed; ready for L2 plan tracking.
- Date: 2026-06-08
- Source: product/design discussion after clarifying that browser refresh only
  reloads the latest emitted contract and does not trigger provider sync.
- Intended next step: open an L2 plan-tracking issue from this bundle.

## Execution

- Recommended plan: docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-plan.md
- Recommended execution state: docs/plans/2026-06-08-ui-triggered-sync-control/2026-06-08-ui-triggered-sync-control-execution-state.md
- Status: design framed; implementation should start by confirming the control
  policy defaults in Task 1.1.
- Next-task source: this document.

## Problem

The web UI currently refreshes data only by loading `./contract.json` again. A
browser reload works because `/contract.json` is served with `no-store`, but it
does not ask providers for newer data. The next useful feature is a real "Sync
now" capability that a user can invoke from the UI for manual updates or
provider-connectivity testing.

That cannot be implemented as a simple React button that calls the existing
read-only API. The repository intentionally keeps `board` as the only writer,
while `api` and `web` are read-only sidecars. A UI-triggered sync therefore
needs a narrow writer-owned control plane, not a second writer.

## User Intent

- [U1] The desired feature is manual sync from the UI, not just a `contract.json`
  refresh button.
- [U2] The work should be designed and tracked now, then implemented later.
- [U3] Design uncertainties should be surfaced for discussion instead of hidden
  in the implementation.
- [U4] The final product goal is that sync becomes a usable UI feature.

## Confirmed Repository Facts

- [F1] `README.md` describes Docker Compose services as `board` (sole writer),
  `api` (read-only range API), and `web` (read-only nginx sidecar).
- [F2] `README.md` says the daemon defaults to `INTERVAL=120` and
  `FULL_EVERY=30`, with incremental runs about every two minutes and a full
  sweep roughly hourly.
- [F3] `docs/DESIGN.md` defines the UI as a read-only consumer that fetches
  `./contract.json` and never reaches into DB, sources, provider APIs, or
  SQLite.
- [F4] `docs/DESIGN.md` says there is intentionally no external cron and no
  second writer.
- [F5] `docker/docker-entrypoint.sh` implements `once`, `loop`, and `api`
  modes. `loop` runs sync + emit on a timer; `api` never syncs or emits.
- [F6] `src/cli/range-api.ts` is explicitly read-only and opens SQLite with
  `openDbReadOnly`.
- [F7] `packages/ui/src/contract.ts` fetches `./contract.json` with
  `cache: "no-store"`.

## Decisions

- Treat this as an L2 plan because the work spans backend daemon behavior,
  Docker routing, UI state, safety controls, tests, and docs.
- Name the user-facing action "Sync now" or equivalent; do not call it
  "Refresh contract" because refresh only reloads already-emitted data.
- Keep `api` read-only. It must not run sync, emit contracts, open writable DB
  handles, or consume provider tokens for writes.
- Put the sync control surface in the writer boundary owned by `board`.
- Serialize manual and loop-triggered syncs in one process so SQLite never has
  two sync writers.
- After a successful manual sync + emit, the UI should reload the active
  contract or range response without a full browser reload.
- Keep provider write actions out of scope; this is only provider read sync into
  the local store.

## Recommended Control Defaults

These are adopted planning defaults. Task 1.1 should confirm or adjust them
before implementation:

1. Default UI action: incremental sync across all configured sources, followed
   by contract emit.
2. Advanced UI options: full sweep, dry run, and optional source selection.
3. Re-entrancy: reject a second manual request while any sync is running and
   return the active run status; do not silently queue unlimited runs.
4. Safety: expose the control route only when explicitly enabled for the local
   Docker deployment, and require a same-origin control token/header to prevent
   cross-site blind POSTs.
5. Visibility: show current/last run status, mode, source scope, started time,
   finished time, item/edge/activity counts, and error summaries.

## Requirements

1. A user can start a manual sync from the UI without using Docker commands or
   browser reload.
2. Manual sync can run incremental by default and full sweep on explicit user
   selection.
3. Manual dry-run can exercise provider fetch/normalize paths without writing
   DB rows or emitting a new contract.
4. Manual sync and the background loop share one scheduler/lock so they cannot
   overlap.
5. When a manual sync succeeds and emits `data/contract.json`, the UI refreshes
   the loaded contract and keeps the current route, filters, visibility
   settings, and selected time range.
6. The UI surfaces partial/error states clearly and does not present a failed
   manual sync as fresh data.
7. Docker still has exactly one DB writer.
8. Documentation explains when to use the UI button, when browser refresh is
   enough, and when the background loop will update automatically.

## Non-Goals

- Turning the read-only range API into a writer.
- Provider write actions such as editing issues, labels, PRs, or MRs.
- Exposing a production-grade public admin API.
- Replacing the background loop with only manual sync.
- Changing provider normalization or contract schema unless implementation
  reveals a missing status field that must be represented.
- Live provider calls in automated tests.

## Acceptance Criteria

1. The UI exposes a manual sync affordance with clear disabled, running,
   success, dry-run, and error states.
2. `POST`ing the control endpoint starts exactly one writer-owned sync + emit
   run or returns the active run status when a run is already in progress.
3. The loop scheduler skips or waits while a manual run is active; no overlapping
   DB writer is possible.
4. Manual incremental, full, dry-run, and source-scoped requests are covered by
   tests or explicit validation.
5. Docker smoke proves `/`, `/contract.json`, the existing read-only
   `/api/range`, and the new sync control route work together.
6. Docs and UI copy distinguish "reload emitted contract" from "trigger sync".

## Risks And Guardrails

- A public or LAN-exposed control route can burn provider rate limits or trigger
  unwanted syncs. Keep the route opt-in and local-oriented, and require a
  same-origin token/header.
- Running the control endpoint in the read-only `api` sidecar would violate the
  architecture. Keep all write paths in `board`.
- Full sweeps can tombstone disappeared items only when complete. The UI must
  label full mode carefully and preserve existing sync-engine completeness
  rules.
- Dry-run must not emit a new contract, otherwise the UI could show data derived
  from a non-written store state.
- The loop shell script is not a great place for an HTTP control plane. Prefer a
  small Node daemon that owns scheduling, sync execution, status, and HTTP.

## Read-First References

- `README.md`
- `docs/DESIGN.md`
- `docs/CONTRACT.md`
- `docker/compose.yaml`
- `docker/docker-entrypoint.sh`
- `docker/ui-nginx.conf`
- `src/cli/sync.ts`
- `src/cli/emit-contract.ts`
- `src/cli/range-api.ts`
- `src/sync-engine.ts`
- `packages/ui/src/App.tsx`
- `packages/ui/src/contract.ts`
- `packages/ui/src/components/Header.tsx`

## Retention Intent

Retire this bundle through the plan-tracking closeout and archive flow after the
UI-triggered sync feature lands, is validated in Docker, and the issue is closed.
