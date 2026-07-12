# Graph Focus Multi-Hop Neighborhood Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: independent specialist review passed — merge pending.
- Target scope: bounded canonical-history multi-hop Graph focus API and UI.
- Execution window: Sprint 1 -> Sprint 2, serial, one feature PR.
- Current task: wait for the final provider checks, approve, and merge PR #566.
- Next task: merge, close the tracker, archive the plan, and rebuild the macOS app.
- Last updated: 2026-07-12
- Branch/commit/PR: `feat/graph-focus-neighborhood`; initial implementation `aedc85f`; PR <https://github.com/sympoies/symphony-board/pull/566>.
- Source document: docs/plans/2026-07-12-graph-focus-neighborhood/2026-07-12-graph-focus-neighborhood-plan.md
- Direct source-doc execution waiver: not applicable
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/565>

## Validation Plan

- Bundle: `plan-tooling validate --file docs/plans/2026-07-12-graph-focus-neighborhood/2026-07-12-graph-focus-neighborhood-plan.md --format text --explain`.
- Core: `pnpm run typecheck && pnpm test`.
- UI: `pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`.
- Coverage: `pnpm coverage`.
- Desktop: `pnpm desktop:build`, then project rebuild/install/open after merge.
- Postgres: `pnpm run test:pg-e2e` and an isolated-port, serialized `pnpm run test:pg-compose` because review hardening added Store snapshot/ref-scoped reads to both drivers.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Specify and test deterministic graph neighbourhood selection | pending; Meaningful red captured in b3c6b4c; deterministic BFS, cycles, induced edges, and caps now pass test/graph-neighborhood.test.ts. | Production behavior implemented after red. |
| 1.2 | done | Expose the read-only API route | Ref-scoped indexed frontier reads, explicit truncation sentinels, identical-request coalescing, abort checks, one-snapshot SQLite/Postgres projection, body omission, and negotiated gzip transport pass route/conformance tests. | Invalid or shallow focus work is bounded by returned-neighbourhood caps; cross-source deduplication cannot hide SQL truncation. |
| 2.1 | done | Add focus-depth route state and neighbourhood loading | Depth 1..5 route state, cancellable fetch, strict graph consistency/ceiling validation, and labeled static/file fallback pass UI tests. | Default depth is 5 and survives focus/filter/range route changes. |
| 2.2 | done | Render depth, limits, and expanded focus graph | Topology-keyed remounts, filter-safe isolated focus nodes, adaptive force ticks, and render-smoke depth/race/three-limit/network/local-file scenarios pass. | Overview behavior remains range-windowed; expanded focus keeps only focus plus surviving-edge endpoints. |
| 2.3 | done | Document and validate the shipped boundary | README, DESIGN, CONTRACT, and UI docs updated. Final Node 24 gates: core 604/604, UI 378/378, render-smoke PASS, coverage 90.23%, both Postgres gates, plan bundle, and desktop release build. | Initial traversal red chronology is retained as an explicit evidence waiver; every review-fix contract has authentic red. |

## Session Log

- 2026-07-12: User approved L2 delivery through implementation, review, merge,
  and macOS thin-app acceptance. Feasibility confirmed current focus is one-hop
  over a range-bounded payload; dedicated canonical-history neighbourhood route
  selected.
- 2026-07-12: Captured backend/API and UI route meaningful reds, then implemented
  the bounded read-only projection and five-hop focus UI. Focused backend tests
  and the full UI test/build/render-smoke gates pass; full validation is next.
- 2026-07-12: Opened PR #566 after the test-first record verified against the
  delivered head; all 12 required provider checks passed. Independent review is
  the remaining pre-merge gate.
- 2026-07-12: Testing, maintainability, security, performance, API-contract,
  and required red-team review completed. Addressed bounded-query/snapshot,
  client consistency, stale topology, payload/layout, acceptance-matrix, and
  isolated-focus findings; all scoped, Postgres, coverage, smoke, and desktop
  gates pass.
- 2026-07-12: Follow-up review also hardened graph-only DB rows, coalescer
  coverage, gzip quality negotiation, cross-source edge-cap truthfulness, and
  item-filtered focus nodes. All affected specialists passed the final head,
  17/17 actionable review threads are resolved, and merge is the remaining gate.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `plan-tooling validate --file ... --format text --explain` | pass | 1 plan bundle valid; 0 errors. | this execution state |
| `pnpm run typecheck && pnpm test` | pass | Backend typecheck and 604/604 tests passed. | terminal evidence retained in session |
| `pnpm --filter @symphony-board/ui run test` | pass | 378/378 UI tests passed under Node 24.16.0. | terminal evidence retained in session |
| `pnpm --filter @symphony-board/ui run build` | pass | TypeScript and Vite production build passed. | terminal evidence retained in session |
| `pnpm --filter @symphony-board/ui run smoke` | pass | Full render-smoke passed: depth refetch, stale race, all limits, API fallback, and local-file fallback. | terminal evidence retained in session |
| `pnpm coverage` (ambient Node 26.5.0) | fail | Coverage loader hit the known CommonJS/ESM runtime mismatch before tests. | corrected by pinned-runtime rerun below |
| `fnm use` (Node 24.16.0) + `pnpm coverage` | pass | Combined line coverage 90.23% (20916/23181), above 85% floor. | terminal evidence retained in session |
| `pnpm desktop:build` under Node 24.16.0 | pass | Thin desktop release binary built successfully. | `packages/desktop/src-tauri/target/release/symphony-board-desktop` |
| `pnpm run test:pg-e2e` | pass | SQLite/Postgres conformance plus Postgres live e2e passed (61 tests). | terminal evidence retained in session |
| `pnpm run test:pg-compose` | pass after environment isolation | First build raced on the shared `:dev` tag; second found the user's existing Live port. Serialized build with isolated 28081/25433/28091 ports passed without touching the running stack. | terminal evidence retained in session |
