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
| 1.1 | done | gzip the standalone app-server contract response | pending; test/app-server.test.ts gzip+cache test green; serveContract gzips on Accept-Encoding w/ mtime-keyed cache (src/cli/app-server.ts) | Independent; no contract change. |
| 1.2 | done | Date-bound the range activity query in both drivers | pending; listActivitiesInRange added to Store + sqlite + postgres (coarse text band on activity_by_time + precise instant filter); range.ts uses it; conformance test green; EXPLAIN QUERY PLAN shows SEARCH USING INDEX activity_by_time (no full scan) -> no new migration needed | Touches the `Store` seam; Postgres gates required. |
| 2.1 | done | Add the `activity_daily` aggregate to the contract | pending; activity_daily DTO added to packages/contract/types.ts + contract.schema.json ($defs activityDaily/activityDailyBucket, optional top-level); docs/CONTRACT.md Activity Daily section + 4.0.0 note | DTO + schema + tests + `docs/CONTRACT.md`. |
| 2.2 | done | Compute `activity_daily` and window emitted activities at emit | pending; buildActivityDaily computes per-day/per-kind over full set; emitted activities[] windowed to 30d; CONTRACT_VERSION 3.5.0->4.0.0; contract.test.ts windowing+reconcile tests green; 271 backend tests pass | Contract major bump (3.5.0 -> 4.0.0). |
| 2.3 | done | Rewire the Activity Overview to read `activity_daily` | pending; buildActivityHeatmapFromDaily reads activity_daily anchored at generated_at; ActivityHeatmap/ActivityPage/App rewired; SUPPORTED_MAJOR 3->4; activityDataExtent uses activity_daily; UI 164 tests + build + render-smoke green | Anchor to `generated_at`, not the UI clock. |
| 2.4 | deferred | Drop redundant `id` and `summary` | pending; Deferred: after 2.2 windows activities[] to 30d, dropping id/summary saves only ~0.2MB (plan's ~1.3-1.8MB was pre-windowing); summary is a real display fallback for push/branch/tag rows the UI cannot faithfully reconstruct. Major bump + shrink goal achieved without it. Clean follow-up. | Reconstruct in `parseContract`; folded into the 2.2 major bump. |
| 3.1 | deferred | Narrow-local / wide-fetch range threshold | pending; Deferred: local range serving needs local re-projection of items+edges AND repo_metrics, but repo_metrics is server-computed per-window and cannot be re-derived in the UI without duplicating backend logic; partial local serving would regress Board/Graph/Repo-Analytics for locally-served ranges. Gate kept unchanged = NO regression (UI fetches /api/range as today); windowing still shrinks the contract. Plan under-scoped the repo_metrics coupling. | 1w/1mo local, 6mo/1yr via `/api/range`. |
