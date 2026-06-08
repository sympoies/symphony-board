# View-Scope Aggregates Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: not started; tracking issue not yet opened
- Target scope: symphony-board UI view-scoped stats followed by #56 contract
  aggregate/window redesign.
- Execution window: Sprint 1 (UI view-scoped stats) -> Sprint 2 (contract
  aggregate/window shape), serial.
- Current task: Task 1.1 - not started.
- Next task: Task 1.1 - define scoped stats primitives.
- Last updated: 2026-06-08
- Branch/commit/PR: not yet started
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
| 1.1 | pending | Define scoped stats primitives | pending | Add explicit UI model scope vocabulary and helpers. |
| 1.2 | pending | Wire Board summary to the Board window | pending | Board stats follow item-local active-since filtering. |
| 1.3 | pending | Wire Graph summary to the Graph overview window | pending | Graph stats follow relationship-window inputs; focus counts remain separate. |
| 1.4 | pending | Update UI documentation | pending | Document scoped summaries and devlog only if warranted. |
| 2.1 | pending | Specify aggregate scope in the contract | pending | Schema/types/docs define full and windowed aggregate semantics. |
| 2.2 | pending | Emit contract aggregates and window metadata | pending | Producer emits validated aggregate/window data without exposing DB schema. |
| 2.3 | pending | Consume contract aggregates in the UI | pending | UI uses contract aggregates where compatible and local fallbacks where needed. |
| 2.4 | pending | Close issue #56 or mark its supersession | pending | Provider issue reflects shipped or remaining contract work. |

## Session Log

- 2026-06-08: Created this bundle after deciding the UI stats issue should not
  be fixed as a narrow one-off. The chosen sequence is UI scoped-stats first,
  then #56 contract aggregate/window redesign using the same scope vocabulary.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| pending | pending | Bundle validation will run before opening the tracker. | local |
