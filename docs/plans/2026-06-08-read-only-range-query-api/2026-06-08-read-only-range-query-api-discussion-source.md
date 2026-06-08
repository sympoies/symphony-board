# Read-Only Range Query API And Unified Time-Range UX Source

- Status: decisions settled; ready for L2 plan tracking.
- Date: 2026-06-08
- Source: product/design discussion after contract v2 windowed item payload
  shipped and was deployed locally for validation.
- Intended next step: open an L2 plan-tracking issue from this bundle.

## Execution

- Recommended plan: docs/plans/2026-06-08-read-only-range-query-api/2026-06-08-read-only-range-query-api-plan.md
- Recommended execution state: docs/plans/2026-06-08-read-only-range-query-api/2026-06-08-read-only-range-query-api-execution-state.md
- Status: decisions settled; plan tracking is the next step.
- Next-task source: this document.

## Problem

Contract v2 correctly stops shipping every live item row in static
`contract.json`. The UI now shows true full totals from metadata and renders
only rows that are actually loaded. That made the old Board/Graph `all` time
button misleading: it suggests all-time cards can be shown, but the static v2
payload only contains the primary 90-day item window plus edge endpoint rows.

The desired long-term behavior is not to bring the full item set back into
`contract.json`. The desired behavior is explicit historical range lookup.

## User Decisions

- [U1] The ambiguous `all` button should go away for Board and Graph.
- [U2] The replacement is an explicit time-range filter, not another hidden
  preset.
- [U3] Board, Graph, and Activity must be evaluated and implemented together.
  They must not grow separate date designs or leave one page unchanged.
- [U4] The user wants the full Option D design: a real range query surface for
  historical windows, not a front-end-only filter over the static payload.

## Confirmed Repository Facts

- [F1] `docs/CONTRACT.md` says contract `2.0.0` changed `items[]` into a
  bounded payload complete only for `item_window`, with `repo_stats[]` and
  `aggregates[]` carrying full totals.
- [F2] `docs/CONTRACT.md` states that choosing older or all-time Board/Graph
  card windows requires another payload or a future load-more API; the static
  v2 contract cannot synthesize missing historical cards.
- [F3] `docs/DESIGN.md` defines the UI as read-only and says it fetches
  `./contract.json` rather than reaching into DB, source, provider, or backend
  modules.
- [F4] `docs/DESIGN.md` defines Docker responsibilities: `board` is the backend
  loop daemon and sole writer; `web` is the read-only sidecar serving the UI and
  `/contract.json`.
- [F5] `packages/contract/README.md` warns that Graph views can render loaded
  edges only for the loaded window unless a future API provides more rows.
- [F6] The current code fixes the static contract item window at 90 days.

## Decisions

- Treat this as an L2 plan because it changes product architecture, Docker
  shape, contract/query semantics, and three UI pages.
- Preserve the static contract as the fast default payload.
- Add a read-only query surface for explicit historical `from` / `to` windows.
- Keep `board` as the only DB writer. The range query service must open SQLite
  read-only and must not run migrations, sync, or emit.
- Replace Board/Graph `all` with explicit ranges. If a future full-history mode
  exists, it must be labelled by the exact range or endpoint it uses rather than
  reusing ambiguous `all` language.
- Design Board, Graph, and Activity around one shared time-range state and URL
  model, while keeping each page's timestamp basis explicit.

## Requirements

1. Board can load cards and stats for a selected historical `from` / `to`
   window even when that window is outside the static 90-day item payload.
2. Graph can load the relationship window for the same selected calendar range
   without pretending it uses the Board item-window basis.
3. Activity uses the same visible range UX while querying by `occurred_at`.
4. The UI has one range state model, one URL serialization model, and shared
   loading/error/empty behavior across Board, Graph, and Activity.
5. The Docker deployment continues to have one writer. Any new API service is
   read-only and cannot write contract or DB state.
6. Documentation explains the static contract boundary and the dynamic range
   query boundary.

## Non-Goals

- Revert to full-history static `contract.json`.
- Add provider write actions.
- Add live provider calls to automated tests.
- Make nginx or browser code read SQLite directly.
- Implement arbitrary analytics beyond the Board, Graph, and Activity windows.

## Acceptance Criteria

1. Board/Graph no longer show an ambiguous `all` time button in windowed/static
   mode.
2. Board, Graph, and Activity share one explicit range selector and URL state.
3. Range queries outside the static 90-day contract window load from the
   read-only API and return correct rows, edges, stats, and metadata.
4. Invalid ranges, empty ranges, API failures, and loading states are handled
   consistently across all three pages.
5. Tests cover the backend query path, UI range state, and all three page
   integrations.
6. Docker smoke proves `/contract.json` still works and `/api/...` returns a
   read-only range response.

## Read-First References

- `docs/CONTRACT.md`
- `docs/DESIGN.md`
- `packages/contract/README.md`
- `packages/ui/README.md`
- `src/contract/build.ts`
- `packages/ui/src/App.tsx`
- `packages/ui/src/components/FullBoard.tsx`
- `packages/ui/src/components/GraphPage.tsx`
- `packages/ui/src/components/ActivityPage.tsx`
- `docker/compose.yaml`

## Retention Intent

Retire this bundle through the plan-tracking closeout and archive flow after
the read-only range query implementation lands and the unified range UX is
validated in Docker.
