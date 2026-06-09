# Provider Links Contract And UI Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: ready; tracking issue not yet opened
- Target scope: provider-link contract additions, producer URL emission, and
  Activity / Repo Analytics UI links.
- Execution window: Sprint 1 (contract and producer link semantics) -> Sprint 2
  (source-aware UI links and drill-down), serial.
- Current task: open plan tracking issue.
- Next task: Task 1.1.
- Last updated: 2026-06-09
- Branch/commit/PR: none.
- Source document: docs/plans/2026-06-09-provider-links-contract-ui/2026-06-09-provider-links-contract-ui-plan.md
- Direct source-doc execution waiver: not applicable.
- Tracking issue: pending.

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
| 1.1 | pending | Define additive contract link fields | none yet | Target contract 3.2.0 additive fields. |
| 1.2 | pending | Add provider URL helpers and repo metric URLs | none yet | Preserve null for unknown project paths. |
| 1.3 | pending | Emit Activity URLs for reliable event destinations | none yet | Avoid false links for ambiguous comments and deleted refs. |
| 1.4 | pending | Refresh sample contract and contract documentation | none yet | Keep sample contract valid and docs aligned. |
| 2.1 | pending | Extend hash routes for source-aware drill-down | none yet | Avoid project-path-only ambiguity. |
| 2.2 | pending | Add Repo Analytics external and internal links | none yet | Link repo names and metric cells. |
| 2.3 | pending | Render Activity link affordances conservatively | none yet | Keep virtualization dimensions stable. |
| 2.4 | pending | Final validation, docs, and devlog | none yet | Retain issue/PR/validation evidence after delivery. |

## Session Log

- 2026-06-09: Created this bundle from the converged UI link review. The chosen
  approach is to handle contract support, producer URL emission, Activity and
  Repo Analytics links, route model, docs, sample contract, and smoke coverage
  in one tracked implementation pass.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `agent-docs preflight --intent project-dev` | pass | Required project-dev docs are present and valid; no validation contract declared. | local |
| `plan-issue --version && plan-tooling --version && semantic-commit --version && skill-usage --version` | pass | All CLIs report 1.0.14, satisfying the create-plan-tracking-issue floor. | local |

