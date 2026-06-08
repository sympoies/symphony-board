# Plan: Unify View-Scope Aggregates And Windowed Contract

## Overview

Make the Board and Graph summary numbers explicitly scoped to the view they sit
beside, then carry the same scope vocabulary into the #56 contract redesign.
The first sprint is UI-only: it corrects the client-side view model while the
full contract remains available. The second sprint changes the versioned
contract so server-provided aggregates and windowed item delivery can share the
same semantics instead of reintroducing implicit totals.

## Read First

- Primary source: docs/plans/2026-06-08-view-scope-aggregates/2026-06-08-view-scope-aggregates-discussion-source.md
- Source type: discussion-to-implementation-doc
- Related issue: https://github.com/sympoies/symphony-board/issues/56
- Open questions carried into execution: none

## Scope

- In scope:
  - Define a shared UI `ViewScope` / scoped-stats model for `global`,
    `boardWindow`, `graphWindow`, and `focus`.
  - Make Board summary stats follow the Board item-local active-since window.
  - Make Graph overview summary stats follow the Graph relationship window, and
    keep focus counts visibly separate from overview totals.
  - Update UI tests, render smoke, and docs for the scoped summaries.
  - Extend the contract schema/types/docs/version so issue #56 can provide
    full and windowed aggregates aligned to the same scope vocabulary.
  - Update the contract producer and UI consumer once the schema is settled.
- Out of scope:
  - Provider API changes.
  - External write actions from the UI.
  - SQLite schema changes unless the aggregate producer proves they are
    necessary.
  - Virtualized list or load-more behavior unless required by the final #56
    item-window design.
  - Live provider calls in automated tests.

## Assumptions

1. The current full contract remains small enough to support a client-side
   scoped-stats refactor before #56 changes the payload shape.
2. Board and Graph should keep distinct window semantics: Board filters items by
   `updated_at`; Graph keeps edges when a tracked endpoint is updated in the
   window.
3. Contract aggregates can be added as a minor version change if the existing
   fields remain compatible and the schema/types make the new fields optional
   for old readers.
4. Settings source/repo visibility and transient search/facet filters remain
   client-owned display filters; contract aggregates describe emitted contract
   totals, not each viewer's localStorage-hidden subset.

## Sprint 1: UI View-Scoped Stats

**Goal**: Remove the implicit shared App-level stats bar and make page summaries
match the active Board or Graph window.

**PR grouping intent**: `per-sprint`
**Execution Profile**: serial

**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: Board and Graph summaries change independently when their
  active-since presets change.

### Task 1.1: Define scoped stats primitives

- **Location**:
  - `packages/ui/src/model.ts`
  - `packages/ui/test/model.test.ts`
- **Description**: Add explicit scoped-stats helpers that name the counting
  scope instead of relying on the App-level `computeStats` call. Keep the
  existing full-filter stats available as `global`, then add helpers for
  Board item-window stats and Graph relationship-window stats.
- **Dependencies**:
  - none
- **Complexity**: 3
- **Acceptance criteria**:
  - `ViewScope` or equivalent types make `global`, `boardWindow`,
    `graphWindow`, and `focus` explicit in the UI model.
  - Board stats count windowed items and only the relationships relevant to
    those windowed items.
  - Graph stats can be derived from the same edge/window inputs that build the
    overview graph.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`

### Task 1.2: Wire Board summary to the Board window

- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/components/FullBoard.tsx`
  - `packages/ui/src/components/StatsBar.tsx`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Move or pass the summary so the Board displays counts for
  `boardItems` after the active-since cutoff is applied. The visible label must
  make the scope clear enough that "showing X of Y" and the stats pills cannot
  be mistaken for unrelated totals.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 3
- **Acceptance criteria**:
  - Changing Board `active since` changes the Board summary counts.
  - The Board still preserves intrinsic status derivation from the full visible
    edge set so `In Progress` and `Trailing` classifications do not weaken.
  - The old App-level stats bar is not shown above Board as if it were
    Board-window scoped.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 1.3: Wire Graph summary to the Graph overview window

- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/components/GraphPage.tsx`
  - `packages/ui/src/components/StatsBar.tsx`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Make Graph overview counts derive from the graph's effective
  `active since`, mention toggle, mention target, and search/facet-filtered edge
  inputs. Focus view keeps a focused subgraph count and must not imply it is the
  all-overview total.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 3
- **Acceptance criteria**:
  - Changing Graph `active since` changes Graph overview counts.
  - Focus view visibly distinguishes focused subgraph counts from overview
    totals.
  - Board and Graph no longer show identical stats unless the selected scopes
    genuinely contain the same data.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 1.4: Update UI documentation

- **Location**:
  - `packages/ui/README.md`
  - `docs/DESIGN.md`
  - `docs/devlog/`
- **Description**: Document the scoped summary semantics and record a devlog
  entry only if the sprint ships a durable UI behavior change worth future
  lookup.
- **Dependencies**:
  - Task 1.2
  - Task 1.3
- **Complexity**: 2
- **Acceptance criteria**:
  - UI docs state that Board and Graph summaries are page/window scoped.
  - `docs/DESIGN.md` preserves the distinction between Board item windows and
    Graph relationship windows.
  - Devlog is updated only when warranted by the shipped outcome.
- **Validation**:
  - `pnpm run typecheck`

## Sprint 2: Contract Aggregate And Window Shape

**Goal**: Expand issue #56 from payload trimming into a versioned aggregate and
window contract that matches the UI view-scope vocabulary.

**PR grouping intent**: `per-sprint`
**Execution Profile**: serial

**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build`
- Verify: emitted/sample contracts validate and UI can render from
  contract-provided aggregates where available.

### Task 2.1: Specify aggregate scope in the contract

- **Location**:
  - `docs/CONTRACT.md`
  - `packages/contract/types.ts`
  - `packages/contract/contract.schema.json`
  - `packages/contract/README.md`
- **Description**: Add the aggregate/window schema and types for full totals and
  named window totals. The schema must state whether each aggregate is full
  contract, item-window, graph-window, or focus-local, and must preserve the
  raw-store/canonical/contract layer boundary.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 4
- **Acceptance criteria**:
  - Contract docs define aggregate scopes using the same vocabulary as the UI
    view model.
  - Schema and TypeScript types validate aggregate shape and remain semver
    compatible according to `docs/CONTRACT.md`.
  - Contract versioning requirements are explicit before producer output
    changes.
- **Validation**:
  - `pnpm test`
  - `pnpm run typecheck`

### Task 2.2: Emit contract aggregates and window metadata

- **Location**:
  - `src/contract/build.ts`
  - `src/cli/emit-contract.ts`
  - `test/contract.test.ts`
  - `test/validate.test.ts`
  - `packages/ui/public/contract.json`
- **Description**: Teach the producer to emit the new aggregate/window fields
  from canonical rows without exposing SQLite schema as the contract. Update
  validation and sample contract fixtures.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 4
- **Acceptance criteria**:
  - Emitted contracts validate against the updated schema.
  - Tests cover full aggregates and at least one windowed aggregate.
  - Sample UI contract includes representative aggregate/window data.
- **Validation**:
  - `pnpm test`
  - `pnpm run typecheck`

### Task 2.3: Consume contract aggregates in the UI

- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/model.ts`
  - `packages/ui/src/components/FullBoard.tsx`
  - `packages/ui/src/components/GraphPage.tsx`
  - `packages/ui/test/model.test.ts`
- **Description**: Use contract-provided aggregates where they match the active
  scope and keep client-computed fallbacks only where local viewer filters make
  server totals insufficient. The UI must not mix full aggregates beside
  windowed item sets without a clear label.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 4
- **Acceptance criteria**:
  - UI uses contract aggregates for compatible scopes and computes local
    overrides only after viewer-local filters.
  - Full totals and window totals are labelled distinctly.
  - Old sample/fixture assumptions that stats are always client-computed are
    removed or narrowed.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run build`

### Task 2.4: Close issue #56 or mark its supersession

- **Location**:
  - `README.md`
  - `docs/DESIGN.md`
  - `docs/devlog/`
- **Description**: Update user-facing and maintainer-facing docs after the
  contract aggregate/window design lands. Close #56 only if the implemented
  contract actually ships windowed items plus aggregates; otherwise record what
  remains.
- **Dependencies**:
  - Task 2.3
- **Complexity**: 2
- **Acceptance criteria**:
  - Docs describe the implemented aggregate/window contract, not a future
    design.
  - #56 is closed, updated, or explicitly linked as still partially open based
    on shipped behavior.
  - Devlog records the durable contract milestone if it ships.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

## Testing Strategy

- Unit: scoped-stat helpers, Board item-window filtering, Graph edge-window
  filtering, contract aggregate shape, and validation fixtures.
- Integration: contract emit/validate tests and UI model tests consuming sample
  aggregate data.
- E2E/manual: UI render smoke covering Board/Graph active-since summary changes
  and focus-view count labelling.

## Risks & gotchas

- A single helper named generically, such as `windowStats`, can hide the
  Board/Graph semantic difference. Prefer names that include `board` or `graph`.
- Contract aggregates cannot represent viewer-local `localStorage` visibility
  choices directly. The UI must keep a local post-filter or clearly label
  server-side totals.
- Focus view can easily be mistaken for the Graph overview. Keep focused counts
  separate and avoid reusing overview labels.
- If #56 ships only a windowed item set with full aggregates, it will improve
  payload cost but not this maintainability issue.

## Rollback plan

- Sprint 1 rollback: restore the previous App-level stats bar and keep Board
  and Graph local summaries limited to their existing `showing X` labels.
- Sprint 2 rollback: keep the UI client-computed scoped stats and defer the
  aggregate/window fields to a later contract minor version; do not emit partial
  aggregate fields that validate but have ambiguous scope.
