# Activity Windowing + Aggregates + Range Model Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: not started — ready to open the L2 tracking issue.
- Target scope: window emitted `activities[]` to 30 days, add the
  `activity_daily` contract aggregate (major bump), rewire the Activity Overview
  to read it, add the UI narrow-local / wide-fetch range threshold, date-bound
  `/api/range` in both drivers, and gzip the standalone `app-server`.
- Execution window: Sprint 1 transport + query efficiency -> Sprint 2 contract
  reshape (major bump) -> Sprint 3 UI range model.
- Current task: Task 1.1 — gzip the standalone app-server contract response.
- Next task: Task 1.2 — date-bound the range activity query in both drivers.
- Last updated: 2026-06-19
- Branch/commit/PR: pending.
- Source document: `docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-discussion-source.md`
- Plan document: `docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-plan.md`
- Direct source-doc execution waiver: not applicable
- Tracking issue: pending — assigned by `create-plan-tracking-issue` at open.
- Source snapshot: pending — posted by `create-plan-tracking-issue` at issue open.
- Plan snapshot: pending — posted by `create-plan-tracking-issue` at issue open.
- Initial state snapshot: pending — posted by `create-plan-tracking-issue` at
  issue open.

## Validation Plan

- Bundle:
  - `plan-tooling validate --file docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-plan.md --format text --explain`.
- Tracker open:
  - Dry-run `plan-issue record open --profile tracking`.
  - Live `plan-issue record open --profile tracking`.
  - Read-back and audit with `plan-issue record audit --profile tracking
    --expect-visible`.
- Code:
  - `pnpm run typecheck && pnpm test`.
  - `pnpm --filter @symphony-board/ui run build`.
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm --filter @symphony-board/ui run smoke`.
- Store / drivers (Sprint 1 Task 1.2 touches the `Store` seam):
  - `pnpm run test:pg-e2e` and `pnpm run test:pg-compose` (Docker required).
- Contract / size:
  - Emit a contract; validate against `packages/contract/contract.schema.json`.
  - Record raw and gz `contract.json` size before/after Sprint 2.
- Range model:
  - Network capture on 1w / 1mo (expect no `/api/range`) and 6mo / 1yr (expect
    `/api/range`).
