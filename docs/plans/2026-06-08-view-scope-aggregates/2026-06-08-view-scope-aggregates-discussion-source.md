# View-Scope Aggregates Implementation Handoff

- Status: decisions settled; ready for L2 plan tracking.
- Date: 2026-06-08
- Source: product/design discussion about whether the Board and Graph
  `active since` controls should drive the summary statistics, and whether
  issue #56 should become the long-term contract boundary for that behavior.
- Intended next step: open an L2 plan-tracking issue from this bundle. This is a
  source artifact, not the task-by-task implementation plan.

## Execution

- Recommended plan: docs/plans/2026-06-08-view-scope-aggregates/2026-06-08-view-scope-aggregates-plan.md
- Recommended execution state: docs/plans/2026-06-08-view-scope-aggregates/2026-06-08-view-scope-aggregates-execution-state.md
- Status: decisions settled; plan tracking is the next step.
- Next-task source: this document.

## Problem

The UI currently has one App-level stats bar shared by Board and Graph. It is
computed from the transient search/source/state/kind filters before either
page-local `active since` window is applied. The Board then applies an
item-local `updated_at` window inside `FullBoard`, while Graph applies a
relationship window inside `GraphPage`.

That leaves two related maintenance problems:

- The summary numbers look like page stats, but they are global filtered stats
  and do not change when the page window changes.
- Issue #56 plans to split contract delivery into full aggregates and windowed
  item sets, but it does not yet define which aggregate scope the UI should show
  for Board, Graph, focus view, and global filters.

## Confirmed Facts

- [F1] `StatsBar` is rendered by `App` from `computeStats(filteredItems,
  filteredEdges)`, before Board or Graph page-local windows apply.
- [F2] Board's active-since window is item-local and filters cards by
  `updated_at`.
- [F3] Graph's active-since window is relationship-local: an edge survives when
  a tracked endpoint is updated within the window.
- [F4] Issue #56 is a contract follow-up to ship windowed items plus aggregates
  instead of the full item set when payload, parse, or memory cost becomes the
  bottleneck.
- [F5] The maintainable long-term boundary is to name the stats/window scope
  explicitly, then let the future contract provide aggregates that match that
  vocabulary.

## Decisions

- Introduce an explicit view-scope vocabulary before changing the contract.
  Required scopes are `global`, `boardWindow`, `graphWindow`, and `focus`.
- Make UI stats page-scoped. Board stats follow the Board item window. Graph
  stats follow the Graph overview window. Focus keeps its own focused counts and
  does not pretend to be an all-page aggregate.
- Keep Board and Graph window semantics distinct. Do not force Graph to use the
  Board item-local rule, and do not force Board to count by Graph edge survival.
- Treat #56 as the contract follow-up for server-provided aggregates and
  windowed item delivery, but expand its design to carry the same view-scope
  vocabulary.
- Ship this in two steps: first make the client-side view model correct while
  the full contract is still available; then add contract aggregates/windowed
  delivery with schema, type, version, and producer changes.

## Scope

- Define a durable UI view-scope model and route stats through it.
- Update Board/Graph UI behavior, tests, render smoke, and docs so the visible
  numbers match the selected page window.
- Redesign the contract aggregate/window shape under #56 so contract-provided
  totals map to the same view scopes.
- Preserve settings visibility, search/facet filters, source/repo hiding, graph
  focus behavior, and provider sync semantics.

## Non-Scope

- Provider API changes.
- SQLite schema changes unless the aggregate producer proves they are necessary.
- Live provider fetches in automated tests.
- External write actions from the UI.
- Virtualized list or load-more UX unless required by the final #56 contract
  shape.

## Requirements

1. A maintainer can answer "what do these numbers count?" from the code and
   docs without tracing component-local state manually.
2. Changing Board `active since` changes Board-scoped item/state/kind/edge
   counts.
3. Changing Graph `active since` changes Graph-scoped node/link/lifecycle
   counts or removes the shared stats bar in favor of a clearly scoped graph
   summary.
4. Contract aggregate additions use a versioned schema/type change and remain
   compatible with the existing raw-store, canonical DB, and contract layer
   boundaries.
5. Issue #56 remains the owner of the payload/windowed-contract redesign, not a
   separate duplicate issue.

## Acceptance Criteria

1. Board and Graph no longer show an identical unscoped stats bar when their
   active windows are different.
2. Unit tests cover Board window stats and Graph window stats separately.
3. Render smoke verifies the visible summary changes when an active-since preset
   changes on Board and Graph.
4. Contract docs and schema describe aggregate scope semantics before producer
   output relies on them.
5. The final contract implementation can provide full and windowed aggregates
   without making the SQLite schema the public contract.

## Validation Plan

- `pnpm run typecheck`
- `pnpm test`
- `pnpm --filter @symphony-board/ui run test`
- `pnpm --filter @symphony-board/ui run build`
- `pnpm --filter @symphony-board/ui run smoke`
- Contract change sprint only: schema validation tests and any contract fixture
  updates required by `docs/CONTRACT.md`.

## Risks And Guardrails

- Board and Graph use different window semantics. Hide that difference in code
  only if the helper names stay explicit; otherwise it becomes another implicit
  stats bug.
- If #56 is implemented only as payload trimming, it can preserve the current
  confusion by showing full aggregates beside windowed items. The contract work
  must therefore define aggregate scope first.
- Settings repo/source visibility is a pre-filter. Windowed aggregates must be
  computed after visibility/search/facet filters in the UI, and the contract
  aggregate design must state which server-side totals are pre-filtered versus
  client-filtered.
- Focus view is intentionally not the same as the overview window. It should
  show focused subgraph counts, not imply full Graph-window totals.

## Read-First References

- https://github.com/sympoies/symphony-board/issues/56
- `packages/ui/src/App.tsx`
- `packages/ui/src/components/FullBoard.tsx`
- `packages/ui/src/components/GraphPage.tsx`
- `packages/ui/src/model.ts`
- `docs/DESIGN.md`
- `docs/CONTRACT.md`

## Retention Intent

Retire this bundle through the plan-tracking closeout and archive flow after
the implementation lands and #56 is either closed or explicitly superseded.
