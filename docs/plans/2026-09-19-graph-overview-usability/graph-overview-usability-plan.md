# Plan: Improve Graph overview usability and performance

## Overview

Make the Graph overview readable when the selected range contains many
disconnected relationship components, remove the low-value per-card `not drawn`
cue, correct the relationship legend, and remove a quadratic hover-time lookup.
The contract, canonical store, focused-neighborhood API, date/facet semantics,
and meaningful `off-window` cue remain unchanged.

## Read First

- Primary source:
  `docs/plans/2026-09-19-graph-overview-usability/graph-overview-usability-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope: remove visible `not drawn` badges and notes while preserving
  candidate/drawn membership for ordering; lay out connected components
  independently and pack them into a compact overview; correct and simplify the
  Graph legend/status copy; replace the hover-time edge style scan with indexed
  lookup; update Graph docs and regression coverage.
- Out of scope: contract or API changes, compact-list redesign, Web Worker
  layout, list virtualization, new edge filters, or response caching.

## Assumptions

1. `off-window` remains visible because it communicates that focused canonical
   history lies outside the selected date range.
2. Force and hierarchy remain user-selectable; component packing applies only
   to the overview, while focused graphs retain their existing single-subgraph
   spacing.
3. The thin desktop app consumes the shared UI and needs no shell-specific code
   change, but it must be rebuilt, installed, and opened on `m4` after merge.

## Sprint 1: Graph overview implementation

**Goal**: Deliver the agreed Graph usability and low-risk performance changes.
**Demo/Validation**:
- Command(s): `pnpm --filter @symphony-board/ui run build`,
  `pnpm --filter @symphony-board/ui run test`, and
  `pnpm --filter @symphony-board/ui run smoke`
- Verify: disconnected components render in compact packed regions, `not drawn`
  is absent, `off-window` remains, legends match edge behavior, and Graph focus
  behavior remains intact.

### Task 1.1: Capture Graph regressions

- **Location**:
  - `packages/ui/src/model.ts`
  - `packages/ui/test/model.test.ts`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Add a pure connected-component packing contract and render
  assertions for the visible cue/legend behavior before changing the component.
- **Dependencies**:
  - none
- **Complexity**: 3
- **Acceptance criteria**:
  - A disconnected graph fixture fails until component packing is implemented.
  - Render-smoke detects any reappearance of visible `not drawn` copy while
    retaining `off-window` coverage.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`

### Task 1.2: Implement component-aware Graph presentation

- **Location**:
  - `packages/ui/src/components/GraphPage.tsx`
  - `packages/ui/src/model.ts`
  - `packages/ui/src/styles.css`
- **Description**: Compute deterministic connected components, lay each one out
  with the selected algorithm, pack their bounds into a compact overview, hide
  the `not drawn` presentation without changing ordering, correct legend copy,
  and index base edge styles for hover rendering.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 6
- **Acceptance criteria**:
  - Disconnected overview components no longer repel one another across the
    full canvas and remain readable after initial fit.
  - No visible `not drawn` badge or focused-note copy remains.
  - `off-window` continues to render and affect focused-list explanation.
  - The legend describes all solid structural edges and lifecycle coloring
    accurately.
  - Hover styling performs one indexed base-style lookup per edge.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run build`
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 1.3: Synchronize Graph documentation

- **Location**:
  - `packages/ui/README.md`
  - `docs/DESIGN.md`
  - `docs/devlog/2026-09.md`
- **Description**: Remove the obsolete `not drawn` promise, document packed
  component layout and legend semantics, and record the delivered UI behavior.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 2
- **Acceptance criteria**:
  - Normative and package docs match the shipped Graph behavior.
  - The devlog records outcome and validation without secrets or ephemeral
    machine paths.
- **Validation**:
  - `pnpm run typecheck`

## Sprint 2: Delivery and thin-app activation

**Goal**: Review, merge, and activate the shared UI in the `m4` macOS thin app.
**Demo/Validation**:
- Command(s): governed PR delivery and `bash .agents/scripts/rebuild-open-app.sh`
  on `m4`
- Verify: the PR is merged and `/Applications/Symphony Board.app` on `m4` is
  rebuilt from the merged revision and running.

### Task 2.1: Validate, review, and merge

- **Location**:
  - repository-wide validation and provider delivery surfaces
- **Description**: Run the required UI and root gates, complete specialist
  testing/maintainability review, deliver and merge the PR, and close the
  tracking issue through its strict evidence gates.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 4
- **Acceptance criteria**:
  - Required validation passes.
  - Review findings are resolved or dispositioned before merge.
  - Provider merge truth matches the reviewed head.
- **Validation**:
  - `pnpm run typecheck && pnpm test`
  - `pnpm --filter @symphony-board/ui run build`
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 2.2: Rebuild and open the m4 thin app

- **Location**:
  - `m4:/Applications/Symphony Board.app`
- **Description**: Update the clean `m4` checkout to the merged default branch,
  run the project-owned thin-app rebuild/install/open wrapper, and verify the
  app process.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 3
- **Acceptance criteria**:
  - The `m4` checkout is at the merged default-branch revision.
  - The thin app is rebuilt and installed through the project skill script.
  - `symphony-board-desktop` is running after open.
- **Validation**:
  - `bash .agents/scripts/rebuild-open-app.sh`

## Testing Strategy

- Unit: connected-component partitioning/packing, stable positions, and
  existing Graph visibility/layout tick contracts.
- Integration: UI TypeScript build and browser render-smoke covering Graph
  overview, focus, cues, legend, layout, and console errors.
- E2E/manual: merged thin-client build, install, and process verification on
  `m4`.

## Risks & gotchas

- Component packing must account for demand-scaled node dimensions and must be
  deterministic so React Flow remounts do not visually shuffle unchanged data.
- Removing the visible cue must not collapse the candidate inventory to drawn
  nodes or change focused related-item ordering.
- The macOS app activation occurs after merge so `m4` runs provider-confirmed
  source, not the delivery worktree.

## Rollback plan

Revert the Graph UI commit through the normal reviewed PR path and rebuild the
thin app from the reverted default branch. No contract, schema, or stored data
migration is involved.
