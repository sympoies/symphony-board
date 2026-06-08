# Read-Only Range Query API And Unified Time-Range UX Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: complete; tracking issue closed
- Target scope: read-only historical range query API plus unified Board, Graph,
  and Activity time-range UX.
- Execution window: Sprint 1 (range contract and API) -> Sprint 2 (unified UI),
  serial.
- Current task: complete.
- Next task: none.
- Last updated: 2026-06-08
- Branch/commit/PR: sympoies/symphony-board#82 merged (https://github.com/sympoies/symphony-board/pull/82)
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
| 1.1 | done | Define shared time-range request and response contracts | Contract 2.1.0 adds optional range_query plus TimeRangeDTO/RangeQueryDTO; buildRangeContract validates range envelopes. | Static emits omit range_query; /api/range includes explicit UTC range metadata. |
| 1.2 | done | Add read-only DB query helpers | openDbReadOnly uses SQLite mode=ro&immutable=1 plus query_only; tests verify reads work and writes fail. | Supports Docker data:ro mounts without giving the API writer access. |
| 1.3 | done | Expose the read-only HTTP API and Docker route | src/cli/range-api.ts serves /healthz and /api/range; Docker compose adds api sidecar and nginx /api proxy; isolated Docker smoke passed. | board remains the only sync/emit writer. |
| 2.1 | done | Build shared UI range state and controls | Hash routes carry from/to; TimeRangeControls provides shared date inputs and 1w/2w/1mo/3mo quick presets. | One URL-backed range model drives Board, Graph, and Activity. |
| 2.2 | done | Wire Board, Graph, and Activity to range loading | App fetches range contracts for custom ranges; Board/Graph/Activity consume activeEnv and shared range filtering; smoke verifies range narrowing. | Contract aggregates are used only for the default compatible static range. |
| 2.3 | done | Update documentation, sample data, and devlog | README, DESIGN, CONTRACT, package READMEs, sample contract, render smoke, and devlog updated; Node 24 validation and Docker smoke pass. | Devlog records issue #81 and validation evidence. |

## Session Log

- 2026-06-08: Implemented the read-only range API, contract 2.1.0
  `range_query` metadata, Docker `api` sidecar, nginx `/api/` proxy, and shared
  Board/Graph/Activity date-range UX. Node 24 validation, coverage, render
  smoke, and isolated Docker endpoint smoke all passed.
- 2026-06-08: Created this bundle after local v2 Docker validation showed the
  static windowed contract behaves correctly, but the disabled Board/Graph
  `all` button needs a clearer long-term replacement. The chosen design is a
  read-only range query API plus a unified time-range UX across Board, Graph,
  and Activity.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `fnm exec --using 24 pnpm run typecheck` | pass | Root TypeScript clean. | local |
| `fnm exec --using 24 pnpm test` | pass | 76/76 backend tests pass. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run test` | pass | 43/43 UI model tests pass. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run build` | pass | Vite production build clean. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run smoke` | pass | Board/Graph/Activity share range presets without all; API-backed range narrowing verified. | local |
| `fnm exec --using 24 pnpm run validate --in packages/ui/public/contract.json` | pass | Sample contract validates as 2.1.0. | local |
| `fnm exec --using 24 pnpm coverage` | pass | Combined line coverage 85.29% (3357/3936), above 85% floor. | local |
| Docker smoke on isolated project `symphony-board-range-smoke` | pass | `/`, `/contract.json`, and `/api/range?from=2026-06-01&to=2026-06-08` returned 200 through nginx on port 18080. | local |
