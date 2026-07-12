# Graph Focus Multi-Hop Neighborhood Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: validation passed — independent review pending.
- Target scope: bounded canonical-history multi-hop Graph focus API and UI.
- Execution window: Sprint 1 -> Sprint 2, serial, one feature PR.
- Current task: deliver the feature PR and run independent pre-merge review.
- Next task: merge, close the tracker, archive the plan, and rebuild the macOS app.
- Last updated: 2026-07-12
- Branch/commit/PR: `feat/graph-focus-neighborhood`; PR pending.
- Source document: docs/plans/2026-07-12-graph-focus-neighborhood/2026-07-12-graph-focus-neighborhood-plan.md
- Direct source-doc execution waiver: not applicable
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/565>

## Validation Plan

- Bundle: `plan-tooling validate --file docs/plans/2026-07-12-graph-focus-neighborhood/2026-07-12-graph-focus-neighborhood-plan.md --format text --explain`.
- Core: `pnpm run typecheck && pnpm test`.
- UI: `pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`.
- Coverage: `pnpm coverage`.
- Desktop: `pnpm desktop:build`, then project rebuild/install/open after merge.
- Postgres: waived unless the Store seam or driver SQL changes.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Specify and test deterministic graph neighbourhood selection | pending; Meaningful red captured in b3c6b4c; deterministic BFS, cycles, induced edges, and caps now pass test/graph-neighborhood.test.ts. | Production behavior implemented after red. |
| 1.2 | done | Expose the read-only API route | pending; Read-only /api/graph-neighborhood wired through range-api and app-server with config gating and 400/404 coverage. | Uses the existing read-only Store lifecycle. |
| 2.1 | done | Add focus-depth route state and neighbourhood loading | pending; Depth 1..5 route state, cancellable fetch, response validation, and labeled static/file fallback pass UI tests. | Default depth is 5 and survives focus/filter/range route changes. |
| 2.2 | done | Render depth, limits, and expanded focus graph | pending; Focus renders the server-provided multi-hop graph and limit status; render-smoke proves an out-of-window second-hop node. | Overview behavior remains range-windowed. |
| 2.3 | done | Document and validate the shipped boundary | pending; README, DESIGN, CONTRACT, and UI docs updated; UI test/build/smoke pass.; Final Node 24 gates pass: core 600/600, UI 374/374, render-smoke PASS, coverage 90.14% (floor 85%), plan bundle valid, desktop release build succeeded. | Postgres waived: no Store interface, driver, migration, or SQL changed; devlog follows PR creation as a standalone commit. |

## Session Log

- 2026-07-12: User approved L2 delivery through implementation, review, merge,
  and macOS thin-app acceptance. Feasibility confirmed current focus is one-hop
  over a range-bounded payload; dedicated canonical-history neighbourhood route
  selected.
- 2026-07-12: Captured backend/API and UI route meaningful reds, then implemented
  the bounded read-only projection and five-hop focus UI. Focused backend tests
  and the full UI test/build/render-smoke gates pass; full validation is next.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `plan-tooling validate --file ... --format text --explain` | pass | 1 plan bundle valid; 0 errors. | this execution state |
| `pnpm run typecheck && pnpm test` | pass | Backend typecheck and 600/600 tests passed. | terminal evidence retained in session |
| `pnpm --filter @symphony-board/ui run test` | pass | 374/374 UI tests passed under Node 24.16.0. | terminal evidence retained in session |
| `pnpm --filter @symphony-board/ui run build` | pass | TypeScript and Vite production build passed. | terminal evidence retained in session |
| `pnpm --filter @symphony-board/ui run smoke` | pass | Full render-smoke passed, including canonical second-hop focus. | terminal evidence retained in session |
| `pnpm coverage` (ambient Node 26.5.0) | fail | Coverage loader hit the known CommonJS/ESM runtime mismatch before tests. | corrected by pinned-runtime rerun below |
| `fnm use` (Node 24.16.0) + `pnpm coverage` | pass | Combined line coverage 90.14% (20533/22778), above 85% floor. | terminal evidence retained in session |
| `pnpm desktop:build` under Node 24.16.0 | pass | Thin desktop release binary built successfully. | `packages/desktop/src-tauri/target/release/symphony-board-desktop` |
| Postgres gates | waived | No Store interface, driver, migration, or SQL changed. | read-only use of existing Store methods only |
