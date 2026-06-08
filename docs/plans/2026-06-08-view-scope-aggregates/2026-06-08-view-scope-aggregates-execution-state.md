# View-Scope Aggregates Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: Sprint 2 implemented; validation pass; provider follow-up updated.
- Target scope: symphony-board UI view-scoped stats followed by #56 contract
  aggregate/window redesign.
- Execution window: Sprint 1 (UI view-scoped stats) -> Sprint 2 (contract
  aggregate/window shape), serial.
- Current task: Task 2.4 - done.
- Next task: PR delivery, review, merge, and plan-tracking close-ready probe.
- Last updated: 2026-06-08
- Branch/commit/PR: `feat/contract-scoped-aggregates`; PR pending.
- Source document: docs/plans/2026-06-08-view-scope-aggregates/2026-06-08-view-scope-aggregates-plan.md
- Direct source-doc execution waiver: not applicable
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/70>

## Validation Plan

- Bundle creation: `plan-tooling validate --file docs/plans/2026-06-08-view-scope-aggregates/2026-06-08-view-scope-aggregates-plan.md --format text --explain`.
- Sprint 1: `pnpm run typecheck`, UI model tests, UI build, and UI render smoke.
- Sprint 2: full backend/contract tests plus UI build/tests for contract
  aggregate consumption.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Define scoped stats primitives | Scoped stats primitives in packages/ui/src/model.ts with model tests. | Add explicit UI model scope vocabulary and helpers. |
| 1.2 | done | Wire Board summary to the Board window | Board StatsBar now uses board-window items and relevant edges; smoke verifies 8 -> 2 when narrowed. | Board stats follow item-local active-since filtering. |
| 1.3 | done | Wire Graph summary to the Graph overview window | Graph StatsBar now uses graph-window/focus graph data; smoke verifies 9 -> 2 when narrowed and focus scope label. | Graph stats follow relationship-window inputs; focus counts remain separate. |
| 1.4 | done | Update UI documentation | Updated packages/ui/README.md, docs/DESIGN.md, and docs/devlog/2026-06.md. | Document scoped summaries and devlog only if warranted. |
| 2.1 | done | Specify aggregate scope in the contract | Contract scope/window vocabulary documented in docs/CONTRACT.md and mirrored in packages/contract/types.ts plus contract.schema.json. | Schema/types/docs define full and windowed aggregate semantics. |
| 2.2 | done | Emit contract aggregates and window metadata | Producer emits v1.3 global/boardWindow/graphWindow aggregates; tests cover full and active-since rows; sample and throwaway emitted contracts validate. | Producer emits validated aggregate/window data without exposing DB schema. |
| 2.3 | done | Consume contract aggregates in the UI | UI consumes compatible contract aggregates through findContractScopedStats and falls back for viewer-local filters; UI tests and smoke pass. | UI uses contract aggregates where compatible and local fallbacks where needed. |
| 2.4 | done | Close issue #56 or mark its supersession | Updated #56 with remaining payload-trimming scope: https://github.com/sympoies/symphony-board/issues/56#issuecomment-4646009410 | Provider issue reflects shipped or remaining contract work. |

## Session Log

- 2026-06-08: Created this bundle after deciding the UI stats issue should not
  be fixed as a narrow one-off. The chosen sequence is UI scoped-stats first,
  then #56 contract aggregate/window redesign using the same scope vocabulary.
- 2026-06-08: Opened tracking issue
  <https://github.com/sympoies/symphony-board/issues/70> and recorded the URL in
  this execution-state file before PR delivery.
- 2026-06-08: Implemented Sprint 1 on `feat/view-scope-ui-stats`: scoped stats
  primitives, Board-window summary, Graph-window/focus summaries, UI docs, and
  devlog.
- 2026-06-08: Implemented Sprint 2 on `feat/contract-scoped-aggregates`:
  contract v1.3 optional aggregate rows, producer emit/validation, UI
  compatible-aggregate consumption with local fallback, docs/devlog, and #56
  scope update.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `fnm exec --using 24 pnpm run typecheck` | pass | TypeScript clean. | local |
| `fnm exec --using 24 pnpm test` | pass | 72/72 root tests passed, including contract aggregate producer/schema coverage. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run test` | pass | 40/40 UI tests passed, including compatible-aggregate lookup fallback coverage. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run build` | pass | Vite production build clean. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run smoke` | pass | Board scoped stats changed 8 -> 2, Graph scoped stats changed 9 -> 2, and focus stats were labelled separately. | local |
| `fnm exec --using 24 pnpm run validate --in packages/ui/public/contract.json` | pass | Tracked v1.3 sample contract validates. | local |
| `fnm exec --using 24 pnpm run emit --config $HOME/.local/state/agent-runtime-kit/out/projects/sympoies__symphony-board/20260608-141640-issue70-sprint2/throwaway-sources.json --out $HOME/.local/state/agent-runtime-kit/out/projects/sympoies__symphony-board/20260608-141640-issue70-sprint2/contract-empty-node24.json` | pass | Throwaway producer emit wrote a valid aggregate-bearing contract. | local |
| `fnm exec --using 24 pnpm coverage` | pass | Combined line coverage 86.65% (3011/3475), above 85% floor. | local |
| `git diff --check` | pass | Clean. | local |
