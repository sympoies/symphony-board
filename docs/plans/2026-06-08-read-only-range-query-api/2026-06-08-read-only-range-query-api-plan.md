# Plan: Read-Only Range Query API And Unified Time-Range UX

## Overview
Add a read-only historical range query path so Board, Graph, and Activity can
load explicit `from` / `to` windows instead of pretending the static v2
`contract.json` can answer all-time card queries. The static contract remains
the cheap default payload and keeps its 90-day primary item window. Historical
or custom ranges are fetched from a read-only API sidecar backed by the
canonical SQLite DB, while the Docker `board` daemon remains the only writer.

## Read First
- Primary source: docs/plans/2026-06-08-read-only-range-query-api/2026-06-08-read-only-range-query-api-discussion-source.md
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope
- In scope:
  - Replace the ambiguous Board/Graph `all` time control with an explicit
    shared time-range model.
  - Evaluate and implement Board, Graph, and Activity together so they do not
    grow separate or inconsistent date semantics.
  - Define request and response contracts for read-only range queries, including
    range metadata, stats, edge endpoint closure, and error behavior.
  - Add a read-only backend query surface over canonical SQLite data. It must
    use read-only DB access and must not become a second writer.
  - Extend Docker Compose so `web` can serve the UI and route `/api/...` to the
    read-only query surface while `board` continues to sync and emit
    `/contract.json`.
  - Update UI state, URL serialization, loading/error/empty states, tests,
    docs, and devlog.
- Out of scope:
  - Reverting `contract.json` to a full-history item payload.
  - Provider write actions from the UI.
  - Live provider fetches during automated tests.
  - A second syncing daemon or any DB writer besides `board`.
  - Changing provider source normalization unless query tests expose a missing
    canonical field.

## Assumptions
1. Canonical SQLite already contains enough live item, edge, label, repo, source,
   and activity data to answer custom date ranges without refetching providers.
2. The first useful range semantics are item `updated_at` for Board,
   edge-endpoint `updated_at` for Graph overview, and activity `occurred_at` for
   Activity.
3. A local read-only API sidecar is acceptable for Docker deployment because it
   reads the same mounted data and keeps the static web sidecar free of direct
   SQLite access.
4. The default page load should still work from `contract.json` without waiting
   on a custom range query.

## Sprint 1: Range Contract And Read-Only Query Surface
**Goal**: Establish the shared time-range contract and backend read path before
rewiring UI pages.
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test`
- Verify: range query fixtures return complete Board, Graph, and Activity
  payloads for the requested windows without mutating the DB.

### Task 1.1: Define shared time-range request and response contracts
- **Location**:
  - `docs/CONTRACT.md`
  - `docs/DESIGN.md`
  - `packages/contract/types.ts`
  - `packages/contract/contract.schema.json`
  - `src/contract/build.ts`
- **Description**: Define a range DTO vocabulary for `from`, `to`, basis,
  scope, loaded row counts, stats, and edge endpoint closure. Clarify that
  `all` is not the replacement UX; explicit ranges are the supported historical
  query model.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - Range metadata can describe Board item windows, Graph edge windows, and
    Activity event windows without page-specific ad hoc fields.
  - The contract docs state that static v2 `items[]` remains bounded and that
    historical windows require the range query surface.
  - `all` is explicitly removed from Board/Graph time-control requirements.
- **Validation**:
  - `pnpm test`
  - `pnpm run typecheck`

### Task 1.2: Add read-only DB query helpers
- **Location**:
  - `src/db/open.ts`
  - `src/db/repo.ts`
  - `src/contract/build.ts`
  - `test/contract.test.ts`
  - `test/db.test.ts`
  - `test/range-query.test.ts`
- **Description**: Add read-only query helpers that select canonical rows for a
  requested time range, include labels, close edge endpoints required by the
  returned edges, and compute stats from the full canonical projection where
  needed.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Query helpers can open the DB in read-only mode and prove they do not run
    migrations or writes.
  - Board range queries select primary items by `updated_at` inside `from` /
    `to` and include tracked edge endpoints needed by returned edges.
  - Graph range queries use the graph window basis and document how mention
    filtering is applied.
  - Activity range queries select by `occurred_at` inside `from` / `to`.
- **Validation**:
  - `pnpm test`
  - Add tests that fail if the range path writes to a throwaway DB.

### Task 1.3: Expose the read-only HTTP API and Docker route
- **Location**:
  - `src/cli/range-api.ts`
  - `src/cli/emit-contract.ts`
  - `docker/compose.yaml`
  - `docker/ui-nginx.conf`
  - `docker/Dockerfile`
  - `README.md`
- **Description**: Add a small Node HTTP entrypoint for read-only range queries
  and route `/api/...` from the web sidecar to that service. The service must
  mount config/data read-only, open SQLite read-only, and never take over sync
  or contract emission.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 5
- **Acceptance criteria**:
  - Docker has exactly one writer service: `board`.
  - The API service rejects invalid ranges and returns stable JSON errors.
  - `/contract.json` remains served from the daemon-emitted file.
  - `/api/...` works in Docker without exposing provider tokens to the browser.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`
  - Docker smoke with a seeded or existing local DB.

## Sprint 2: Unified UI Time-Range UX
**Goal**: Replace page-specific time controls with one consistent range model
across Board, Graph, and Activity.
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: custom ranges load consistently on Board, Graph, and Activity; `all`
  no longer appears as a Board/Graph control.

### Task 2.1: Build shared UI range state and controls
- **Location**:
  - `packages/ui/src/model.ts`
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/components/TimeRangeControls.tsx`
  - `packages/ui/src/components/FullBoard.tsx`
  - `packages/ui/src/components/GraphPage.tsx`
  - `packages/ui/src/components/ActivityPage.tsx`
  - `packages/ui/test/model.test.ts`
- **Description**: Introduce one shared `from` / `to` range state, URL
  serialization, validation, and control component used by Board, Graph, and
  Activity. Preserve quick presets only when they map to explicit ranges.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 4
- **Acceptance criteria**:
  - Board, Graph, and Activity read the same URL-backed range state.
  - Invalid or incomplete ranges render one shared validation state.
  - `all` is hidden or removed from Board and Graph in windowed/static mode.
  - Activity no longer owns an incompatible standalone range vocabulary.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`

### Task 2.2: Wire Board, Graph, and Activity to range loading
- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/contract.ts`
  - `packages/ui/src/components/FullBoard.tsx`
  - `packages/ui/src/components/GraphPage.tsx`
  - `packages/ui/src/components/ActivityPage.tsx`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Load custom ranges from the read-only API, keep the default
  static contract path fast, and apply consistent loading/error/empty behavior
  across all three pages.
- **Dependencies**:
  - Task 1.3
  - Task 2.1
- **Complexity**: 6
- **Acceptance criteria**:
  - Board cards and stats come from the selected Board range, not from missing
    rows in the static contract.
  - Graph overview and focus behavior remain correct when a selected range
    returns a different node/edge set.
  - Activity uses `occurred_at` range data from the same UX, not a separate
    page-only `all` mode.
  - Loading, retry, error, and empty states are shared in behavior and language.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 2.3: Update documentation, sample data, and devlog
- **Location**:
  - `README.md`
  - `docs/DESIGN.md`
  - `docs/CONTRACT.md`
  - `packages/ui/README.md`
  - `docs/devlog/`
- **Description**: Document the new query boundary, the unified time-range UX,
  and the Docker service responsibilities. Record a devlog entry because this
  changes the product's historical-query model.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 3
- **Acceptance criteria**:
  - Docs no longer describe `all` as the way to access historical Board/Graph
    cards under a windowed contract.
  - Docker docs state that `board` is the sole writer and the query service is
    read-only.
  - Devlog links the plan issue, implementation PR, and validation evidence.
- **Validation**:
  - `pnpm run typecheck`
  - `git diff --check`

## Testing Strategy
- Unit: backend range selection, read-only DB opening, contract response
  validation, UI range parsing, and page model helpers.
- Integration: API handler tests against a seeded SQLite fixture and contract
  producer tests for endpoint closure and stats.
- E2E/manual: UI render smoke across Board, Graph, and Activity, plus Docker
  smoke for `/`, `/contract.json`, and `/api/...`.

## Risks & gotchas
- SQLite read-only access in WAL mode needs deliberate handling so the query
  sidecar can read live data without creating writer artifacts.
- Board, Graph, and Activity use different timestamp bases. The shared UX must
  make the selected calendar range common while keeping each page's basis
  explicit in code and docs.
- If the API response shape drifts from the static contract shape, the UI may
  grow duplicate render paths. Prefer shared DTOs or a small adapter layer.
- Very broad ranges can still be large. The API should keep limits, metadata,
  and future pagination/load-more extension points explicit.

## Rollback plan
- Keep the existing static `contract.json` default path intact throughout the
  implementation. If range API rollout fails, disable or hide custom range mode
  while Board, Graph, and Activity continue to render the default v2 windowed
  contract.
