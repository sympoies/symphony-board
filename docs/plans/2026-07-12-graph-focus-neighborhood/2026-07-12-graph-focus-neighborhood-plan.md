# Plan: Graph Focus Multi-Hop Neighborhood

## Overview

Add a bounded read-only Graph neighbourhood surface so focused issues and
change requests can render canonical live relationships through five hops,
independent of the selected date-range projection. Keep Graph overview
unchanged, expose depth in the URL and UI, and make every depth or safety
truncation visible.

## Read First

- Primary source: docs/plans/2026-07-12-graph-focus-neighborhood/2026-07-12-graph-focus-neighborhood-discussion-source.md
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope:
  - Pure deterministic breadth-first neighbourhood projection over configured
    canonical live items and edges.
  - A read-only API-sidecar and standalone-server route with depth `1..5`,
    node/edge caps, hop metadata, and explicit truncation state.
  - URL-backed focus depth, asynchronous fetch/fallback state, and multi-hop
    Graph rendering while focus ignores the selected date range.
  - Backend, UI-model, integration, render-smoke, coverage, documentation,
    independent review, PR delivery, and macOS app acceptance build.
- Out of scope:
  - Provider relationship pagination, tombstoned edge history, or provider
    write actions.
  - Graph overview range/mention semantics.
  - Store-interface or database-schema changes unless implementation evidence
    proves they are necessary.
  - Standalone macOS packaging.

## Assumptions

1. Existing `listLiveItems`, `listLabels`, and `listLiveEdges` reads are
   sufficient for the first bounded neighbourhood implementation.
2. "All prior relationships" means currently live relationships already
   observed in the configured canonical store.
3. A dedicated operational response avoids inflating every range payload and
   can remain separately schema-identified from `ContractEnvelope`.
4. The endpoint-unavailable fallback should preserve existing one-hop focus so
   static deployments remain usable.

## Sprint 1: Bounded Read-Only Neighbourhood Surface

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: Establish deterministic multi-hop selection and a read-only HTTP
surface before changing focused Graph rendering.

**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test`
- Verify: pure and HTTP tests return hops 0..5, deterministic caps, explicit
  continuation metadata, and no canonical writes.

### Task 1.1: Specify and test deterministic graph neighbourhood selection

- **Location**:
  - `src/server/`
  - `test/`
- **Description**: Add failing-first tests and then implement a pure projection
  from canonical items/labels/edges. Traverse edges as undirected for hop
  discovery, retain original edge semantics, prioritize nearer edges, enforce
  depth/node/edge limits, and expose completion metadata.
- **Dependencies**:
  - none
- **Complexity**: 6
- **Acceptance criteria**:
  - A six-hop chain returns only hops 0..5 at the default depth and signals a
    deeper frontier.
  - Cycles and reciprocal/multi-type edges do not duplicate nodes and produce
    stable output ordering.
  - Node and edge limits produce deterministic, explicitly truncated results.
- **Validation**:
  - Focused backend unit tests.
  - `pnpm run typecheck`.

### Task 1.2: Expose the read-only API route

- **Location**:
  - `src/server/`
  - `src/cli/range-api.ts`
  - `src/cli/app-server.ts`
  - `src/server/capabilities.ts`
  - `test/`
- **Description**: Parse `ref` and `depth`, open the configured store read-only,
  build the configured-repo neighbourhood, return stable JSON/errors, advertise
  capability, and close the store on every path.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 5
- **Acceptance criteria**:
  - API-sidecar and standalone routes return the same schema-identified
    response and reject missing/invalid query values consistently.
  - Config-removed sources/repos and tombstoned rows never appear.
  - No writer lease, migration, or mutation is attempted.
- **Validation**:
  - API handler/route tests.
  - `pnpm test`.

## Sprint 2: URL-Backed Multi-Hop Focus UX

**PR grouping intent**: `group`
**Execution Profile**: `serial`

**Goal**: Load and render the full bounded neighbourhood in focused Graph mode
without changing overview semantics or breaking static deployments.

**Demo/Validation**:
- Command(s): `pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: a deep-linked focus defaults to five hops, depth changes refetch, a
  second-hop node is drawn, and unavailable endpoints fall back to one hop.

### Task 2.1: Add focus-depth route state and neighbourhood loading

- **Location**:
  - `packages/ui/src/model.ts`
  - `packages/ui/src/contract.ts`
  - `packages/ui/src/App.tsx`
  - `packages/ui/test/`
- **Description**: Add validated `depth` hash state, a typed neighbourhood
  fetcher, stale-request protection, endpoint-unavailable fallback, and an
  expanded focus edge/item input separate from the range projection.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 6
- **Acceptance criteria**:
  - Focus routes default to depth 5 and preserve an explicit 1..5 value through
    reload, sharing, and focus navigation.
  - Late or aborted responses cannot replace the current focus/depth result.
  - Static/404/error cases retain the loaded one-hop graph with an explainable
    fallback state.
- **Validation**:
  - UI model and contract-loader tests.

### Task 2.2: Render depth, limits, and expanded focus graph

- **Location**:
  - `packages/ui/src/components/GraphPage.tsx`
  - `packages/ui/src/styles.css`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Add 1..5 hop controls and visible loading/truncation/fallback
  status, render the server-provided expanded neighbourhood in focus, keep the
  direct-related side list navigation, and preserve suspended range controls.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Second-hop and later nodes render and contribute to focus stats.
  - The selected depth and returned node/link counts are visible.
  - Depth, node, and edge boundaries are never presented as complete results.
  - Graph overview rendering and mention controls are unchanged.
- **Validation**:
  - UI tests, production build, and render smoke.

### Task 2.3: Document and validate the shipped boundary

- **Location**:
  - `README.md`
  - `docs/DESIGN.md`
  - `docs/CONTRACT.md`
  - `packages/ui/README.md`
  - `docs/devlog/`
- **Description**: Document the operational endpoint, live-observed history
  meaning, five-hop and safety boundaries, static fallback, and final validation
  evidence. Record a durable devlog entry after merge-ready validation.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 3
- **Acceptance criteria**:
  - Product docs distinguish range-scoped overview from canonical-history focus.
  - Docs state that provider fetch limits and tombstoned history remain outside
    the feature's completeness claim.
  - Devlog records the tracker, PR, limits, review outcome, and validation.
- **Validation**:
  - `git diff --check`.
  - Full root/UI/coverage/desktop gates.

## Testing Strategy

- Unit: traversal depth, cycle handling, induced edges, stable ordering,
  continuation detection, and safety caps.
- Integration: read-only handler validation, configured projection, store close
  behaviour, API-sidecar and app-server route dispatch.
- UI logic: route parse/build, depth clamp, fetch decoding/error classes, and
  stale-request protection.
- Render smoke: five-hop controls, expanded focus node, counts/truncation cue,
  fallback path, and zero browser console errors.
- Delivery: core tests, UI tests/build/smoke, coverage, pre-merge specialist
  review, and desktop build/rebuild/open.

## Risks & gotchas

- Depth can multiply into a whole component; safety caps and deterministic
  nearer-first ordering are required.
- Range-as-download cannot be reused as the source of complete multi-hop focus.
- Filters may remove some server-returned nodes; displayed counts must
  distinguish returned neighbourhood metadata from viewer-filtered Graph stats.
- Rich React Flow nodes make render cost more important than response byte size.
- Operational response compatibility needs its own schema identifier because it
  is not the semver contract envelope.

## Rollback plan

Keep existing one-hop focus derivation as the fallback. The client can stop
requesting the new endpoint while overview, range loading, and static/demo
deployments continue to work unchanged.
