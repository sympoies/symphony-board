# Repo Analytics Contract And Trends UI Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: complete; tracking issue closed
- Target scope: repo analytics contract, canonical metrics foundation, read-only
  range API integration, and Repo Analytics UI page.
- Execution window: Sprint 1 (contract/canonical foundation) -> Sprint 2
  (metrics/range API) -> Sprint 3 (UI/docs), serial.
- Current task: open plan tracking issue.
- Next task: Task 1.1.
- Last updated: 2026-06-08
- Branch/commit/PR: sympoies/symphony-board#91 merged (https://github.com/sympoies/symphony-board/pull/91)
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
| 1.1 | done | Define the repo analytics contract | contract 2.2.0 repo_metrics schema/types/version plus contract tests | repo_stats remains inventory; repo_metrics is optional and window-scoped |
| 1.2 | done | Add canonical analytics input fields | metrics derive from existing canonical item, edge, label, and activity rows; no DB migration required | data_quality notes preserve activity coverage gaps |
| 1.3 | done | Extend GitHub and GitLab normalization | existing GitHub/GitLab normalization inputs covered by full source tests in pnpm test | provider-specific missing metrics remain nullable/open-map/data-quality signals |
| 2.1 | done | Implement repo metrics aggregation | pure buildRepoMetrics aggregation with totals, series, top actors, and data quality; pnpm test | Group by `(source_id, project_path)` and include bucketed series. |
| 2.2 | done | Emit metrics in static and range contracts | static buildContract and buildRangeContract emit repo_metrics; sample contract validates | Static default and `/api/range` must validate against the same schema family. |
| 2.3 | done | Document analytics semantics and provider coverage | README, docs/DESIGN.md, docs/CONTRACT.md, package READMEs updated | Include timestamp bases and data-quality semantics. |
| 3.1 | done | Add route, tab, and shared range wiring | #/repo-analytics route/tab uses shared hash range and presets; UI tests and smoke | Reuse existing URL-backed range controls and presets. |
| 3.2 | done | Build repo summary table and trend charts | RepoAnalyticsPage ranked table, trend bars, empty states, and data-quality badges; UI build and smoke | Render from `repo_metrics[]`, not inferred missing history. |
| 3.3 | done | Final docs, sample data, and devlog | sample contract, docs, and docs/devlog/2026-06.md updated; validation evidence recorded | Record issue, PR, and validation evidence after implementation lands. |

## Session Log

- 2026-06-08: Created this bundle from the converged repo analytics discussion.
  The chosen design is Option C: a broad repo analytics contract and canonical
  metrics foundation followed by a Repo Analytics UI page using the shared
  time-range UX.
- 2026-06-08: Implemented contract 2.2.0 repo_metrics, static and range metric
  emission, Repo Analytics UI, docs, sample data, and devlog entry on
  feat/repo-analytics-contract-trends-ui.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `plan-tooling validate --file docs/plans/2026-06-08-repo-analytics-contract-trends-ui/2026-06-08-repo-analytics-contract-trends-ui-plan.md --format text --explain` | pass | Plan bundle validates with 0 errors. | local |
| `pnpm run typecheck` | pass | TypeScript root typecheck clean. | local |
| `pnpm test` | pass | Backend tests pass 83/83. | local |
| `pnpm --filter @symphony-board/ui run test` | pass | UI model tests pass 47/47. | local |
| `pnpm --filter @symphony-board/ui run build` | pass | UI production build clean. | local |
| `pnpm run validate --in packages/ui/public/contract.json` | pass | Sample contract validates as 2.2.0. | local |
| `pnpm --filter @symphony-board/ui run smoke` | pass | Board, Graph, Activity, Repo Analytics, Settings, and graph deep-link focus render with 0 console errors and 0 uncaught exceptions. | local |
| `git diff --check` | pass | No whitespace errors. | local |
| `fnm exec --using 24 pnpm coverage` | pass | Combined line coverage 87.03% (4033/4634), above the 85% floor. | local |
