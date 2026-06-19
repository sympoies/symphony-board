# Activity Windowing + Aggregates + Range Model Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: complete; tracking issue closed
- Target scope: window emitted `activities[]` to 30 days, add the
  `activity_daily` contract aggregate (major bump), rewire the Activity Overview
  to read it, add the UI narrow-local / wide-fetch range threshold, date-bound
  `/api/range` in both drivers, and gzip the standalone `app-server`.
- Execution window: Sprint 1 transport + query efficiency -> Sprint 2 contract
  reshape (major bump) -> Sprint 3 UI range model.
- Current task: complete.
- Next task: closeout.
- Last updated: 2026-06-19
- Branch/commit/PR: sympoies/symphony-board#281 merged (https://github.com/sympoies/symphony-board/pull/281); sympoies/symphony-board#282 merged (https://github.com/sympoies/symphony-board/pull/282)
- Source document: `docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-discussion-source.md`
- Plan document: `docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-plan.md`
- Direct source-doc execution waiver: not applicable
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/279>
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

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | gzip the standalone app-server contract response | `test/app-server.test.ts` gzip+cache test green; `serveContract` gzips on `Accept-Encoding` with an mtime-keyed cache (`src/cli/app-server.ts`) | PR #281; no contract change. |
| 1.2 | done | Date-bound the range activity query in both drivers | `listActivitiesInRange` added to `Store` + sqlite + postgres (coarse text band on `activity_by_time` + precise instant filter); conformance test green; `EXPLAIN QUERY PLAN` shows index search, not a full scan; no new migration | PR #281; `Store` seam, Postgres gates green in CI. |
| 2.1 | done | Add the `activity_daily` aggregate to the contract | `activity_daily` DTO in `packages/contract/types.ts` + `$defs` in `contract.schema.json` (optional top-level); `docs/CONTRACT.md` Activity Daily section + 4.0.0 note | PR #281. |
| 2.2 | done | Compute `activity_daily` and window emitted activities at emit | `buildActivityDaily` over the full set; emitted `activities[]` windowed to 30d; `CONTRACT_VERSION` 3.5.0 -> 4.0.0; windowing + reconcile tests green; 271 backend tests pass | PR #281; contract major bump. |
| 2.3 | done | Rewire the Activity Overview to read `activity_daily` | `buildActivityHeatmapFromDaily` anchored at `generated_at`; `SUPPORTED_MAJOR` 3 -> 4; `activityDataExtent` uses `activity_daily`; UI 164 tests + build + render-smoke green | PR #281; anchored to `generated_at`, not the UI clock. |
| 2.4 | done | Drop redundant `id` and `summary` | `id`/`summary` removed from `ActivityDTO` + schema (`required` + `properties`); UI `activityKey()` rebuilds the composite key; `activityDisplay` derives its label from the structured fields; 271 backend + 164 UI green | PR #282; option C (UI owns its labels; no producer-summary reconstruction). |
| 3.1 | deferred | Narrow-local / wide-fetch range threshold | Deferred to #283: local range serving needs the UI to re-derive `repo_metrics`, which is server-computed per-window and cannot be reproduced without duplicating backend logic; the fetch gate is kept unchanged so there is no regression, and the `activities[]` windowing still shrinks the contract | Follow-up #283; plan under-scoped the `repo_metrics` coupling. |
