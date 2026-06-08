# Read-Only Range Query API And Unified Time-Range UX Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: not started; tracking issue pending
- Target scope: read-only historical range query API plus unified Board, Graph,
  and Activity time-range UX.
- Execution window: Sprint 1 (range contract and API) -> Sprint 2 (unified UI),
  serial.
- Current task: Task 1.1 - pending.
- Next task: open the L2 plan-tracking issue and initialize tracking run state.
- Last updated: 2026-06-08
- Branch/commit/PR: pending
- Source document: docs/plans/2026-06-08-read-only-range-query-api/2026-06-08-read-only-range-query-api-plan.md
- Direct source-doc execution waiver: not applicable
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/81>

## Validation Plan

- Bundle creation: `plan-tooling validate --file docs/plans/2026-06-08-read-only-range-query-api/2026-06-08-read-only-range-query-api-plan.md --format text --explain`.
- Sprint 1: `pnpm run typecheck && pnpm test`.
- Sprint 2: `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`.
- Final implementation: Docker smoke for `/`, `/contract.json`, and the
  read-only range API.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | pending | Define shared time-range request and response contracts | pending | Remove ambiguous all semantics and define range metadata. |
| 1.2 | pending | Add read-only DB query helpers | pending | Query canonical rows without migrations or writes. |
| 1.3 | pending | Expose the read-only HTTP API and Docker route | pending | Preserve board as sole writer; route API through web. |
| 2.1 | pending | Build shared UI range state and controls | pending | One range state and URL model for Board, Graph, Activity. |
| 2.2 | pending | Wire Board, Graph, and Activity to range loading | pending | Shared loading/error/empty behavior and API integration. |
| 2.3 | pending | Update documentation, sample data, and devlog | pending | Document range query boundary and Docker responsibilities. |

## Session Log

- 2026-06-08: Created this bundle after local v2 Docker validation showed the
  static windowed contract behaves correctly, but the disabled Board/Graph
  `all` button needs a clearer long-term replacement. The chosen design is a
  read-only range query API plus a unified time-range UX across Board, Graph,
  and Activity.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| pending | pending | Bundle validation pending before opening tracker. | local |
