# Plan: Repo Analytics Contract And Trends UI

## Overview
Add a per-repo analytics product surface that can show useful repo activity
totals and trends over the shared Board/Graph/Activity date range model. This
is an Option C implementation: define the data contract and canonical
analytics foundation first, then build the UI page against that contract.

The new UI page must not infer history from whatever rows are loaded in
`items[]`. Instead, the backend should emit range-scoped repo metrics for both
the static default window and explicit `/api/range` responses.

## Read First
- Primary source: docs/plans/2026-06-08-repo-analytics-contract-trends-ui/2026-06-08-repo-analytics-contract-trends-ui-discussion-source.md
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope
- In scope:
  - Define an additive repo analytics contract, tentatively `repo_metrics[]`,
    with totals, bucketed series, open-vocabulary breakdowns, bounded top-actor
    summaries, and data-quality metadata.
  - Add additive canonical storage or derivation support for provider fields
    needed by useful repo analytics across GitHub and GitLab.
  - Extend provider normalization for parity-safe fields such as assignees,
    reviewers, branches, issue planning metadata, CR size/commit counts, and
    review/comment/approval counts where available.
  - Compute per-repo metrics from canonical item, edge, label, and activity
    rows for default and explicit time ranges.
  - Include repo metrics in static contract output when compatible with the
    default window and in read-only `/api/range` responses for custom windows.
  - Add a Repo Analytics UI page that reuses the shared URL-backed time range
    controls and quick presets.
  - Update docs, fixtures, tests, sample contract, UI smoke, and devlog.
- Out of scope:
  - Provider write actions from the UI.
  - Live provider fetches from UI code or automated tests.
  - A second syncing daemon or any DB writer besides `board`.
  - Traffic/views/clones metrics in the first analytics contract.
  - Full body/comment/review text or full per-file diff lists in the stable
    contract.
  - Replacing existing `repo_stats[]`; it remains the full inventory count
    surface.

## Assumptions
1. Contract `2.2.0` can be additive: `repo_metrics[]` is optional and older
   consumers can ignore it.
2. Stored raw payloads can replay many new canonical derivations, but fields not
   fetched in historical raw snapshots require a later sync before they appear.
3. Bucketed repo analytics should default to daily buckets for short ranges and
   may use weekly or monthly buckets for wider ranges if the contract records
   the bucket choice explicitly.
4. The first UI can render useful trends with lightweight SVG/CSS and the
   existing React stack; a chart dependency is not required up front.
5. Provider gaps are expected. Null fields and `data_quality.notes` are the
   correct representation when one provider cannot supply a signal.

## Sprint 1: Contract And Canonical Analytics Foundation
**Goal**: Freeze the analytics DTO and collect the canonical fields needed to
avoid repeat contract redesigns.
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test`
- Verify: contract fixtures validate as `2.2.0`, provider fixture
  normalization preserves new analytics inputs, and old contracts remain
  readable by the UI.

### Task 1.1: Define the repo analytics contract
- **Location**:
  - `docs/CONTRACT.md`
  - `docs/DESIGN.md`
  - `packages/contract/types.ts`
  - `packages/contract/contract.schema.json`
  - `src/contract/version.ts`
  - `test/contract.test.ts`
- **Description**: Add an optional top-level repo metrics DTO with range
  metadata, totals, bucketed series, open-vocabulary breakdown maps, bounded
  top actors, and data-quality metadata. Keep `repo_stats[]` unchanged as the
  full inventory count surface.
- **Dependencies**:
  - none
- **Complexity**: 5
- **Acceptance criteria**:
  - Contract docs distinguish `repo_stats[]` from `repo_metrics[]`.
  - Schema and TypeScript types validate totals, series buckets, and
    data-quality fields.
  - The contract version bump follows `docs/CONTRACT.md`.
  - Older consumers can ignore the new field without a major-version branch.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

### Task 1.2: Add canonical analytics input fields
- **Location**:
  - `schema/`
  - `src/model/types.ts`
  - `src/db/repo.ts`
  - `src/db/migrate.ts`
  - `test/db.test.ts`
  - `test/sources.test.ts`
- **Description**: Add additive canonical fields or side tables for
  analytics inputs that should not remain trapped in raw provider payloads:
  assignees/reviewers, branch names, issue planning metadata, CR size/commit
  counts, review/comment/approval counts, and provider coverage flags where
  needed.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 6
- **Acceptance criteria**:
  - Migration is additive and advances `PRAGMA user_version`.
  - Raw/canonical/contract boundaries remain separate.
  - Existing sample DB or fixtures migrate without data loss.
  - Fields that are not provider-parity-safe stay nullable or provider-noted.
- **Validation**:
  - `pnpm test`
  - Migration tests against a throwaway DB.

### Task 1.3: Extend GitHub and GitLab normalization
- **Location**:
  - `src/sources/github.ts`
  - `src/sources/gitlab.ts`
  - `src/model/types.ts`
  - `test/sources.test.ts`
- **Description**: Fetch and normalize the useful analytics input fields from
  GitHub and GitLab where available. Preserve provider gaps explicitly instead
  of inventing fake parity.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 7
- **Acceptance criteria**:
  - GitHub fixtures cover issue/PR metadata, closing references, review/CI/merge
    signals, commits, repository activity, and any newly selected fields.
  - GitLab fixtures cover issue/MR metadata, related MRs, parsed note
    relationships, approvals/CI/merge status, commits, events, and newly
    selected fields.
  - New fetch fields respect pagination and existing row caps.
  - Normalization remains pure and performs no IO.
- **Validation**:
  - `pnpm test`
  - Source-specific fixture tests.

## Sprint 2: Metrics Builder And Range API Integration
**Goal**: Produce repo metrics from canonical rows for default and custom
ranges.
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test`
- Verify: static contract output and `/api/range` responses include compatible
  repo metrics for the selected windows without writing to SQLite.

### Task 2.1: Implement repo metrics aggregation
- **Location**:
  - `src/contract/build.ts`
  - `src/db/repo.ts`
  - `src/cli/range-api.ts`
  - `test/repo-metrics.test.ts`
  - `test/range-query.test.ts`
- **Description**: Add pure aggregation helpers that compute per-repo totals,
  bucketed series, breakdown maps, bounded top actors, and data-quality metadata
  from canonical item, edge, label, and activity rows.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 7
- **Acceptance criteria**:
  - Metrics are grouped by `(source_id, project_path)` and do not use mutable
    project paths as item identity.
  - Board-style active counts use item activity/update semantics documented in
    the contract.
  - Activity metrics use `occurred_at` and distinguish missing/truncated
    activity from true zero activity.
  - Edge lifecycle and open-vocabulary breakdown maps are deterministic.
- **Validation**:
  - `pnpm test`
  - `pnpm run typecheck`

### Task 2.2: Emit metrics in static and range contracts
- **Location**:
  - `src/contract/build.ts`
  - `src/cli/emit-contract.ts`
  - `src/cli/range-api.ts`
  - `packages/ui/public/contract.json`
  - `test/contract.test.ts`
  - `test/range-query.test.ts`
- **Description**: Include `repo_metrics[]` in emitted contracts when a
  compatible default window is known, and include range-scoped metrics in
  `/api/range` responses for explicit `from` / `to` windows.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Static `contract.json` remains a cheap default payload and validates.
  - `/api/range` returns metrics whose `window.from` and `window.to` match the
    requested UTC range.
  - Invalid ranges return stable errors and do not mutate the DB.
  - Sample contract covers at least two repos with differing metric profiles.
- **Validation**:
  - `pnpm test`
  - `pnpm run validate --in packages/ui/public/contract.json`

### Task 2.3: Document analytics semantics and provider coverage
- **Location**:
  - `README.md`
  - `docs/DESIGN.md`
  - `docs/CONTRACT.md`
  - `packages/contract/README.md`
  - `packages/ui/README.md`
- **Description**: Document the repo metrics boundary, timestamp bases,
  provider coverage limits, data-quality flags, and the reason `repo_stats[]`
  stays separate from `repo_metrics[]`.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 3
- **Acceptance criteria**:
  - Docs explain which metrics are reliable, provider-dependent, or unavailable
    in v1 of the analytics page.
  - Docker docs still state that `board` is the sole writer and the API is
    read-only.
  - The contract docs include a concise example envelope.
- **Validation**:
  - `pnpm run typecheck`
  - `git diff --check`

## Sprint 3: Repo Analytics UI
**Goal**: Ship the new UI page against the repo metrics contract.
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: the Repo Analytics page uses the same range presets as Board, Graph,
  and Activity, and custom ranges load metrics through the read-only API.

### Task 3.1: Add route, tab, and shared range wiring
- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/model.ts`
  - `packages/ui/src/components/TimeRangeControls.tsx`
  - `packages/ui/test/model.test.ts`
- **Description**: Add a Repo Analytics route/tab that shares the existing
  URL-backed range state and quick presets with Board, Graph, and Activity.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 4
- **Acceptance criteria**:
  - Repo Analytics appears as a first-class page next to Board, Graph,
    Activity, and Settings.
  - The page reads and updates the same `from` / `to` hash route parameters.
  - Quick presets remain exactly 1w, 2w, 1mo, and 3mo unless the shared preset
    contract changes for every page.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`

### Task 3.2: Build repo summary table and trend charts
- **Location**:
  - `packages/ui/src/components/RepoAnalyticsPage.tsx`
  - `packages/ui/src/model.ts`
  - `packages/ui/src/App.css`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Render a ranked repo analytics page with summary cards,
  sortable repo table, activity/lifecycle trend charts, breakdowns, empty/error
  states, and data-quality indicators.
- **Dependencies**:
  - Task 3.1
- **Complexity**: 7
- **Acceptance criteria**:
  - Repo table shows active items, opened/closed items, merged CRs, commits,
    pushes, comments/reviews when present, and data-quality state.
  - Trend charts render from `repo_metrics[].series` and do not recompute
    missing historical rows from `items[]`.
  - The page handles zero repos, zero activity, missing metrics, API errors,
    loading, and custom range responses.
  - UI stays read-only and does not import backend or DB modules.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 3.3: Final docs, sample data, and devlog
- **Location**:
  - `README.md`
  - `docs/DESIGN.md`
  - `docs/CONTRACT.md`
  - `packages/ui/README.md`
  - `packages/ui/public/contract.json`
  - `docs/devlog/`
- **Description**: Update product docs and sample data for the new page, then
  record a devlog entry with the plan issue, implementation PR, and validation
  evidence.
- **Dependencies**:
  - Task 3.2
- **Complexity**: 3
- **Acceptance criteria**:
  - Docs show how Repo Analytics relates to Board/Graph/Activity and the range
    API.
  - Sample contract renders the page in local UI development and smoke tests.
  - Devlog records the shipped analytics contract and UI behavior.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm --filter @symphony-board/ui run build`
  - `pnpm --filter @symphony-board/ui run smoke`
  - `git diff --check`

## Testing Strategy
- Unit: contract schema/type validation, repo metric aggregation, bucket
  selection, data-quality flags, provider normalization, and UI model helpers.
- Integration: DB migration tests, range API tests against seeded SQLite
  fixtures, contract producer tests, and sample contract validation.
- UI: component/model tests for route/range behavior, table sorting, chart data
  shaping, empty/error states, and render smoke.
- Manual/Docker: smoke `/`, `/contract.json`, and `/api/range?...` through the
  Docker stack to prove `board` remains the sole writer and the UI can fetch
  custom-range metrics.

## Risks & Gotchas
- Provider API parity is uneven, especially around approvals, reviews,
  discussions, issue planning fields, and dependency/subissue relationships.
- Existing raw snapshots do not contain fields that were never fetched; new
  analytics fields may require one or more syncs before data-quality becomes
  good.
- Large custom ranges can be expensive if every repo returns daily buckets and
  top actors. Keep bucket choice and future limits explicit.
- `project_path` is mutable display metadata. Do not use it as item identity.
- Adding too many per-actor or per-label dimensions can make the contract large.
  Keep top actors bounded and leave detailed drill-down for future work.

## Rollback Plan
- Keep existing Board, Graph, Activity, Settings, `repo_stats[]`, and the
  existing `/api/range` response shape usable while adding `repo_metrics[]`.
- If metrics or UI rollout fails, omit or hide the Repo Analytics page and keep
  old consumers running against contract `2.1.0` semantics.
- Because the DB migration is additive, rollback can ignore new nullable fields
  while preserving existing item, edge, label, and activity behavior.
