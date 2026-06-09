# Provider Links Contract And UI Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: implementation validated; delivery pending
- Target scope: provider-link contract additions, producer URL emission, and
  Activity / Repo Analytics UI links.
- Execution window: Sprint 1 (contract and producer link semantics) -> Sprint 2
  (source-aware UI links and drill-down), serial.
- Current task: commit and deliver PR.
- Next task: close tracking issue after PR delivery and close-ready audit.
- Last updated: 2026-06-09
- Branch/commit/PR: branch `feature/provider-links-contract-ui`; commit/PR pending.
- Source document: docs/plans/2026-06-09-provider-links-contract-ui/2026-06-09-provider-links-contract-ui-plan.md
- Direct source-doc execution waiver: not applicable.
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/130>

## Validation Plan

- Bundle creation: `plan-tooling validate --file docs/plans/2026-06-09-provider-links-contract-ui/2026-06-09-provider-links-contract-ui-plan.md --format text --explain`.
- Sprint 1: `pnpm run typecheck && pnpm test && pnpm run validate --in packages/ui/public/contract.json`.
- Sprint 2: `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`.
- Final implementation: `pnpm run typecheck`, `pnpm test`,
  `pnpm --filter @symphony-board/ui run test`,
  `pnpm --filter @symphony-board/ui run build`,
  `pnpm run validate --in packages/ui/public/contract.json`,
  `pnpm --filter @symphony-board/ui run smoke`, and `git diff --check`.
- Optional source smoke: `node src/cli/sync.ts --dry-run` with configured local
  tokens, or an explicit waiver when tokens/network are unavailable.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Define additive contract link fields | contract 3.2.0 schema/types/version + validation tests | Added optional nullable repo_metrics[].repo_url; no activity target_url added. |
| 1.2 | done | Add provider URL helpers and repo metric URLs | src/provider-links.ts + contract repo_url emission tests | Provider URL helper returns null for unsupported/malformed paths. |
| 1.3 | done | Emit Activity URLs for reliable event destinations | GitHub/GitLab source fixture tests cover push/ref/issue/MR links and unlinked comments | Producer fills activities[].url only for reliable destinations. |
| 1.4 | done | Refresh sample contract and contract documentation | packages/ui/public/contract.json validates as 3.2.0; README/CONTRACT/DESIGN/contract README updated | Sample contract includes provider repo URLs for both repo_metrics rows. |
| 2.1 | done | Extend hash routes for source-aware drill-down | model route tests cover source/repo/kind/action hash params and comma actions | Activity and Commits routes are source-aware. |
| 2.2 | done | Add Repo Analytics external and internal links | Repo Analytics links implemented; render-smoke asserts provider repo links and source-aware metric links | Repo labels link externally; non-zero metric cells deep-link internally. |
| 2.3 | done | Render Activity link affordances conservatively | Activity uses existing activities[].url affordance; source tests cover null for ambiguous comments | No new Activity contract field required. |
| 2.4 | done | Final validation, docs, and devlog | typecheck, root tests, UI tests, UI build, sample validation, render-smoke, git diff --check pass; docs/devlog/2026-06.md updated | Live provider dry-run was skipped by missing token env vars; CLI dry-run verified safe skip. |

## Session Log

- 2026-06-09: Created this bundle from the converged UI link review. The chosen
  approach is to handle contract support, producer URL emission, Activity and
  Repo Analytics links, route model, docs, sample contract, and smoke coverage
  in one tracked implementation pass.
- 2026-06-09: Implemented and validated contract 3.2.0 repo links, producer
  Activity URL filling, source-aware UI drilldowns, docs, sample contract, smoke
  coverage, and devlog entry on branch `feature/provider-links-contract-ui`.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `agent-docs preflight --intent project-dev` | pass | Required project-dev docs are present and valid; no validation contract declared. | local |
| `plan-issue --version && plan-tooling --version && semantic-commit --version && skill-usage --version` | pass | All CLIs report 1.0.14, satisfying the create-plan-tracking-issue floor. | local |
| `fnm exec --using 24 pnpm run typecheck` | pass | Root TypeScript check completed cleanly. | local |
| `fnm exec --using 24 pnpm test` | pass | Root test suite passed 129/129. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run test` | pass | UI model/client tests passed 62/62. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run build` | pass | UI build completed; Vite transformed 535 modules. | local |
| `fnm exec --using 24 pnpm run validate --in packages/ui/public/contract.json` | pass | Sample contract validates as contract 3.2.0. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run smoke` | pass | Render smoke passed, including provider repo link and source-aware metric link assertions; 0 console errors / 0 uncaught exceptions. | local |
| `git diff --check` | pass | No whitespace errors. | local |
| `fnm exec --using 24 pnpm run sync --dry-run` | waived | CLI dry-run executed, but all live provider fetches were skipped because token env vars were unset in this shell. | local |
