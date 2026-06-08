# Repo Analytics Contract And Trends UI Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: planned; tracking issue not yet opened
- Target scope: repo analytics contract, canonical metrics foundation, read-only
  range API integration, and Repo Analytics UI page.
- Execution window: Sprint 1 (contract/canonical foundation) -> Sprint 2
  (metrics/range API) -> Sprint 3 (UI/docs), serial.
- Current task: open plan tracking issue.
- Next task: Task 1.1.
- Last updated: 2026-06-08
- Branch/commit/PR: none yet.
- Source document: docs/plans/2026-06-08-repo-analytics-contract-trends-ui/2026-06-08-repo-analytics-contract-trends-ui-discussion-source.md
- Direct source-doc execution waiver: not applicable.
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/90>

## Validation Plan

- Bundle creation: `plan-tooling validate --file docs/plans/2026-06-08-repo-analytics-contract-trends-ui/2026-06-08-repo-analytics-contract-trends-ui-plan.md --format text --explain`.
- Sprint 1: `pnpm run typecheck && pnpm test`.
- Sprint 2: `pnpm run typecheck && pnpm test && pnpm run validate --in packages/ui/public/contract.json`.
- Sprint 3: `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`.
- Final implementation: Docker smoke for `/`, `/contract.json`, and
  `/api/range?...` returning range-scoped repo metrics.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | pending | Define the repo analytics contract | pending | Add optional `repo_metrics[]`; keep `repo_stats[]` as inventory counts. |
| 1.2 | pending | Add canonical analytics input fields | pending | Additive migration only; keep raw/canonical/contract boundaries. |
| 1.3 | pending | Extend GitHub and GitLab normalization | pending | Preserve provider gaps as nullable fields or data-quality notes. |
| 2.1 | pending | Implement repo metrics aggregation | pending | Group by `(source_id, project_path)` and include bucketed series. |
| 2.2 | pending | Emit metrics in static and range contracts | pending | Static default and `/api/range` must validate against the same schema family. |
| 2.3 | pending | Document analytics semantics and provider coverage | pending | Include timestamp bases and data-quality semantics. |
| 3.1 | pending | Add route, tab, and shared range wiring | pending | Reuse existing URL-backed range controls and presets. |
| 3.2 | pending | Build repo summary table and trend charts | pending | Render from `repo_metrics[]`, not inferred missing history. |
| 3.3 | pending | Final docs, sample data, and devlog | pending | Record issue, PR, and validation evidence after implementation lands. |

## Session Log

- 2026-06-08: Created this bundle from the converged repo analytics discussion.
  The chosen design is Option C: a broad repo analytics contract and canonical
  metrics foundation followed by a Repo Analytics UI page using the shared
  time-range UX.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `plan-tooling validate --file docs/plans/2026-06-08-repo-analytics-contract-trends-ui/2026-06-08-repo-analytics-contract-trends-ui-plan.md --format text --explain` | pass | Plan bundle validates with 0 errors. | local |
