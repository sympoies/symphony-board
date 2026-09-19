# Graph Overview Usability Implementation Handoff

Status: ready for tracked implementation
Date: 2026-09-19
Source: user-provided Graph screenshot plus repository implementation review
Intended next step: execute the linked L2 tracking plan and retire this bundle
after strict closeout.

## Purpose

Improve the Graph page's overview readability and remove redundant presentation
noise without changing the graph data model, focused-neighborhood API, or
provider-read-only boundary.

## Confirmed facts

- `not drawn` is a viewer-local cue for a relationship candidate excluded from
  the current overview canvas by edge filtering; it is not provider or workflow
  state.
- Candidate membership and drawn membership are intentionally separate so
  mention-only relationship candidates stay discoverable.
- The supplied screenshot contains 18 rendered nodes and 10 rendered links;
  therefore the overview has at least eight disconnected components.
- The current force layout simulates all overview nodes together, so unrelated
  components repel one another before `fitView` scales the entire result.
- Focused history is already bounded to five hops, 200 nodes, and 500 edges;
  stale client requests are aborted and concurrent identical server reads are
  coalesced.
- Hover rendering currently calls `rfEdges.find(...)` once per edge, producing
  a quadratic scan at the 500-edge focus cap.

## Decisions

- Remove visible `not drawn` badges and explanatory notes with no replacement
  per-card cue.
- Keep the meaningful `off-window` cue and note.
- Preserve candidate/drawn membership and focused-list ranking internally.
- Partition overview graphs into deterministic connected components, lay out
  each component independently with the selected layout, and pack component
  bounds compactly before the initial `fitView`.
- Keep focused graph layout behavior unchanged.
- Correct the legend so solid edges are described as structural
  (`closes`/`relates`) and lifecycle colors are not implied to be node state.
- Replace the hover-time edge lookup with a memoized ID map.

## Scope

- Graph view-model helpers, Graph React component, Graph CSS, unit tests,
  browser render-smoke, package/design docs, and the September devlog.
- Post-merge rebuild, install, and open of the macOS thin app on `m4`.

## Non-scope

- Contract or DB schema changes.
- Graph-neighborhood API changes.
- Compact-list redesign, virtualization, Web Worker layout, new edge filters,
  or completed-response caching.
- Standalone desktop app changes or deployment.

## Implementation boundaries

- Keep pure partitioning and packing logic in `packages/ui/src/model.ts` so it
  has deterministic unit coverage.
- Keep React Flow and d3/dagre integration in `GraphPage.tsx`.
- Do not remove mention-only items from the side-list candidate inventory.
- Do not change identity, range, facet, focus, or edge lifecycle semantics.

## Requirements

1. The overview must pack disconnected components tightly enough that a graph
   shaped like the supplied 18-node/10-link view opens with readable nodes and
   materially less empty space.
2. Force and hierarchy choices must both work with component packing.
3. Component ordering and positions must be deterministic for unchanged input.
4. `not drawn` must not appear in overview or focused list presentation.
5. `off-window` must continue to appear where canonical focus history falls
   outside the active range.
6. Edge-hover styling must avoid scanning the full edge array per edge.
7. Existing focus/depth routing and graph-neighborhood behavior must remain
   green in render-smoke.

## Acceptance criteria

- Pure tests cover disconnected partitioning/packing, stable placement, and
  demand-scaled component bounds.
- Browser smoke asserts no visible `not drawn` copy and retains an
  `off-window` assertion.
- The legend matches structural/dashed edge behavior.
- Root and UI gates pass with no console errors.
- The merged UI is rebuilt into and opened from the macOS thin app on `m4`.

## Validation plan

- `pnpm run typecheck && pnpm test`
- `pnpm --filter @symphony-board/ui run build`
- `pnpm --filter @symphony-board/ui run test`
- `pnpm --filter @symphony-board/ui run smoke`
- Post-merge on `m4`: `bash .agents/scripts/rebuild-open-app.sh`

## Risks and guardrails

- Packing must use actual demand-scaled dimensions or component bounds can
  overlap even when graph-theoretic grouping is correct.
- Removing a visible cue must not remove its underlying distinction because
  focused ordering still prefers currently drawn relations over filtered ones.
- Performance changes remain bounded and evidence-led; worker/virtualization
  work is deferred until profiling demonstrates need.

## Read-first references

- `DEVELOPMENT.md`
- `docs/development-reference.md`
- `docs/DESIGN.md` Graph section
- `docs/CONTRACT.md` Graph Neighborhood Query section
- `packages/ui/src/components/GraphPage.tsx`
- `packages/ui/src/model.ts`

## Execution

- Recommended plan: docs/plans/2026-09-19-graph-overview-usability/graph-overview-usability-plan.md
- Recommended execution state: docs/plans/2026-09-19-graph-overview-usability/graph-overview-usability-execution-state.md

Retention intent: archive/retire with the completed tracking plan after strict
provider closeout.
