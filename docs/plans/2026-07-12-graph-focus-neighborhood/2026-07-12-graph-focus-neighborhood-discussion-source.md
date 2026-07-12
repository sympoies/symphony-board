# Graph Focus Multi-Hop Neighborhood Implementation Handoff

- Status: decisions settled; ready for L2 plan tracking.
- Date: 2026-07-12
- Source: user review of the focused Graph view and repository feasibility
  assessment.
- Intended next step: execute the sibling L2 plan through implementation,
  independent review, merge, and macOS app rebuild.

## Execution

- Recommended plan: docs/plans/2026-07-12-graph-focus-neighborhood/2026-07-12-graph-focus-neighborhood-plan.md
- Recommended execution state: docs/plans/2026-07-12-graph-focus-neighborhood/2026-07-12-graph-focus-neighborhood-execution-state.md
- Status: ready for tracked execution.
- Next-task source: this document.

## Purpose

Focused Graph inspection currently shows only the selected item and its direct
neighbours. Expand that view through older canonical relationships so a user can
see the connected work history around an issue or change request, with a maximum
of five relationship hops and explicit safety limits.

## Confirmed Facts

- [F1] `focusSubgraph()` retains the focus, its direct neighbours, and edges
  among that one-hop node set (`packages/ui/src/model.ts`).
- [F2] The UI currently builds focus from the loaded range projection, so older
  second-hop and later edges are unavailable to a front-end-only traversal
  (`packages/ui/src/App.tsx`).
- [F3] The canonical store retains the full live item/edge set independently of
  the bounded contract and range projections (`docs/DESIGN.md`,
  `docs/CONTRACT.md`).
- [F4] Read-only operational endpoints already open the configured SQLite or
  Postgres store per request without becoming a writer (`src/server/range.ts`,
  `src/server/actionable.ts`).
- [F5] The force layout performs a fixed simulation before rendering; depth
  alone does not prevent a dense connected component from overwhelming the UI
  (`packages/ui/src/components/GraphPage.tsx`).
- [U1] The user wants prior relationships drawn recursively and accepts a
  variable that caps the display at five relationship levels.
- [U2] The user authorized an L2 issue-backed implementation through merge and
  requested the macOS app be updated and opened for acceptance.

## Decisions

- Add a dedicated read-only operational endpoint for a focused graph
  neighbourhood. Do not expand every range response or the static contract with
  multi-hop history.
- Traverse canonical live edges as an undirected graph for hop discovery while
  preserving each returned edge's original direction, type, endpoint state, and
  lifecycle.
- Default focused depth is five hops and the server hard-clamps requests to the
  supported range `1..5`.
- Apply deterministic node and edge safety caps in addition to depth. Return
  explicit metadata when the requested component continues beyond a depth or
  safety boundary.
- Focus mode remains independent of the selected date range and continues to
  include every relationship type, including mentions. Graph overview keeps its
  existing date-range and mention-filter behaviour.
- Keep focus and depth URL-backed. A shared/reloaded focus URL must reproduce
  the same requested depth.
- On static/demo deployments or when the endpoint is unavailable, retain the
  loaded one-hop focus behaviour and explain the fallback instead of breaking
  Graph navigation.

## Scope

- Read-only server projection and handler over configured canonical live rows.
- Route wiring for the API sidecar and standalone app server.
- UI loading, cancellation, fallback, depth controls, truncation metadata, and
  multi-hop rendering.
- Contract-independent operational response typing and documentation.
- Backend, UI-model, integration, and render-smoke coverage.
- macOS thin-client rebuild/install/open after the merged implementation is on
  `main`.

## Non-Scope

- Provider relationship pagination or source-normalization expansion.
- Tombstoned relationships or an "ever observed" historical edge archive.
- Changing Graph overview date semantics.
- Returning provider secrets, writing providers, or adding a second canonical
  store writer.
- Rebuilding the standalone macOS app; the requested acceptance target is the
  thin `packages/desktop` app.

## Implementation Boundaries

- The endpoint reads only configured, live canonical rows and closes its store
  handle on every request.
- Identity remains the composite provider ref; traversal never keys on
  `project_path` or `iid`.
- The response is an operational API with its own schema identifier, not a
  change to `ContractEnvelope`; no contract semver bump is implied.
- Traversal and cap selection must be pure and deterministic so SQLite,
  Postgres, tests, and UI retries return the same neighbourhood.
- Viewer-local source/repo/search/facet filters remain client-side and apply to
  the returned neighbourhood before rendering.

## Requirements

1. Focusing an item can load canonical live relationships through five hops,
   including relationships whose endpoints are older than the selected range.
2. A request can select depth 1 through 5; absent depth defaults to 5 and values
   outside the range are rejected or clamped consistently.
3. The result includes the focus item, deterministic hop information, all
   selected induced edges within caps, and explicit limit/truncation metadata.
4. Depth, node count, and edge count are bounded server-side; the UI never
   silently presents a capped result as complete.
5. Focus depth is URL-backed, visible in the Graph controls, and preserved while
   navigating between focused nodes.
6. Range controls remain suspended in focus and Graph overview remains
   unchanged.
7. API sidecar and standalone server expose the endpoint read-only; static/demo
   deployments fall back cleanly.

## Acceptance Criteria

- A graph fixture with a six-hop chain returns hops 0..5 by default, excludes
  hop 6, and reports that more relations exist.
- Cycles, reciprocal edges, multiple edge types, and neighbour-neighbour edges
  do not duplicate nodes and retain deterministic edges.
- Node/edge safety caps produce deterministic output and visible truncation
  metadata.
- A focused UI route defaults to five hops, lets the user choose 1..5, and
  fetches the corresponding canonical neighbourhood.
- A multi-hop response draws second-hop and later nodes; focus stats and node
  relation counts use the expanded result.
- Endpoint failure or absence preserves the existing loaded one-hop focus and
  displays a concise fallback notice.
- Root typecheck/tests, UI tests/build/smoke, coverage, and desktop build pass.

## Validation Plan

- Capture meaningful red tests for traversal depth/caps and UI route/depth
  behaviour before production edits.
- Run `pnpm run typecheck && pnpm test`.
- Run `pnpm --filter @symphony-board/ui run test`, `build`, and `smoke`.
- Run `pnpm coverage`.
- Run `pnpm desktop:build` and the project rebuild/open skill after merge.
- Run Postgres gates only if the `Store` interface or driver SQL changes; the
  intended implementation reuses existing full live read methods.

## Risks And Guardrails

- Five hops can cover a whole connected component; node and edge caps are
  mandatory, not optional polish.
- A late response from a prior focus/depth must not replace the current route's
  result; use cancellation or request identity checks.
- "All prior relationships" means all currently live relationships observed in
  the configured canonical store. Provider fetch limits and tombstoned edges are
  intentionally not redefined by this feature.
- The rich React Flow node renderer may still become expensive near the cap;
  validate the chosen limits with render smoke and a synthetic dense fixture.

## Read-First References

- `README.md`
- `DEVELOPMENT.md`
- `docs/DESIGN.md`
- `docs/CONTRACT.md`
- `src/server/range.ts`
- `src/server/actionable.ts`
- `src/contract/build.ts`
- `packages/ui/src/App.tsx`
- `packages/ui/src/model.ts`
- `packages/ui/src/components/GraphPage.tsx`

## Retention Intent

Retire this bundle through the L2 closeout and archive flow after the feature is
merged and the macOS app acceptance build is installed.
