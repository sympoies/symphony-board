# Plan: Activity Windowing + Aggregates + Range Model

## Overview

Shrink the per-load `contract.json` (currently ~17.5 MB local / ~19.5 MB on
private deployment host, 87% of it the full ~16-month activity history) and let the UI reach a full
year of data without a separate archive file. Window raw `activities[]` in the
static contract to 30 days, pre-compute the Activity Overview stats as a new
`activity_daily` aggregate, serve ranges that fit the static window locally
(zero round-trip for the common 1w/1mo views) and wider ranges through
`/api/range`, make `/api/range` date-bounded at the SQL layer, and gzip the
standalone `app-server`. This is single-lane **L2** because it spans a contract
major bump, build-side aggregation, a UI overview rewire, a UI range-model
change, a store/driver query change, and a server change.

## Read First

- Primary source: `docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope: window emitted `activities[]` to 30 days; new `activity_daily`
  contract aggregate; contract major version bump; Activity Overview rewire to
  read the aggregate; UI narrow-local / wide-fetch range threshold;
  `/api/range` SQL date-bounding for both drivers; standalone `app-server`
  gzip; docs/schema/tests.
- Out of scope: any separate archive / cold-pack artifact; changing the 90-day
  `items[]` window; provider sync / `normalize` changes; folding by-actor /
  per-repo analytics into `activity_daily` (stays in `repo_metrics[]`).

## Assumptions

1. The canonical store retains ≥12 months of activity rows (verified: ~16
   months, no age pruning).
2. `activity_daily` needs no DB schema change — it is computed at emit from
   existing activity rows.
3. Both real deployments (compose-pg, standalone app) expose `/api/range`, so
   wide-range views always have a live server.
4. 30 days is an acceptable single local threshold; per-data-type local logic is
   deferred.

## Sprint 1: Transport and query efficiency (no contract change)

**Goal**: make the standalone server compress the contract and make `/api/range`
stop scanning the full activity table — both independent of the contract reshape.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`, `pnpm run test:pg-e2e`,
  `pnpm run test:pg-compose`.
- Verify: standalone server returns `Content-Encoding: gzip`; `/api/range` runs
  a date-bounded query (planner shows no full activity scan).

### Task 1.1: gzip the standalone app-server contract response

- **Location**:
  - `src/cli/app-server.ts`
- **Description**: in `serveContract`, when the request sends
  `Accept-Encoding: gzip`, return a gzipped body with `Content-Encoding: gzip`;
  cache the compressed buffer keyed on the contract file mtime so it is
  recompressed only when a new contract is emitted. Plain clients still get the
  raw bytes.
- **Dependencies**:
  - none
- **Complexity**: 3
- **Acceptance criteria**:
  - `GET /contract.json` with `Accept-Encoding: gzip` returns
    `Content-Encoding: gzip` and a valid gzip body.
  - A request without `Accept-Encoding: gzip` still gets the uncompressed body.
  - The compressed buffer is cached and invalidated on contract file change, not
    recompressed per request.
- **Validation**:
  - `pnpm run typecheck && pnpm test`.
  - Manual: `curl -s -D - -H 'Accept-Encoding: gzip' <app-server>/contract.json`.

### Task 1.2: Date-bound the range activity query in both drivers

- **Location**:
  - `src/db/store.ts`
  - `src/db/sqlite.ts`
  - `src/db/postgres.ts`
  - `src/server/range.ts`
  - `schema/sqlite/`, `schema/postgres/` (only if an index is needed)
- **Description**: add a date-bounded activity read (e.g.
  `listActivitiesInRange(from, to)`) to the `Store` interface and both drivers,
  and use it from `src/server/range.ts` instead of `listActivities()` so a range
  request no longer reads every activity row. If the query planner shows a scan,
  add an additive `activity(occurred_at)` index migration to BOTH driver schemas.
- **Dependencies**:
  - none
- **Complexity**: 5
- **Acceptance criteria**:
  - `/api/range` returns the same rows as before for a given range (parity with
    the prior JS-side filter).
  - The activity read is bounded by `occurred_at` at the SQL layer; the planner
    shows no full-table activity scan for a bounded range.
  - Any added index is an additive migration present in both `schema/sqlite/`
    and `schema/postgres/`, with the driver-owned schema version bumped.
- **Validation**:
  - `pnpm run typecheck && pnpm test`.
  - `pnpm run test:pg-e2e && pnpm run test:pg-compose` (Docker).

## Sprint 2: Contract reshape (major bump)

**Goal**: window the emitted activities to 30 days, add the `activity_daily`
aggregate, and make the Activity Overview read it so the overview no longer
depends on the full raw activity history.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`,
  `pnpm --filter @symphony-board/ui run build` + UI tests + smoke, emit + schema
  validate, size measurement.
- Verify: Overview/heatmap numbers match pre-change values; emitted contract is
  materially smaller.

### Task 2.1: Add the `activity_daily` aggregate to the contract

- **Location**:
  - `packages/contract/types.ts`
  - `packages/contract/contract.schema.json`
  - `packages/contract/` tests
  - `docs/CONTRACT.md`
- **Description**: define an `activity_daily` top-level field — per-day,
  per-kind event counts spanning ≥12 months, anchored at `generated_at`. Add the
  DTO, schema entry, and contract tests. Document it in `docs/CONTRACT.md`.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - `activity_daily` is specified with per-day per-kind counts and a stated
    12-month coverage anchored to `generated_at`.
  - Schema and types agree; consumers can ignore it (additive within the new
    major).
- **Validation**:
  - `pnpm run typecheck && pnpm test`.

### Task 2.2: Compute `activity_daily` and window emitted activities at emit

- **Location**:
  - `src/contract/build.ts`
  - `src/contract/version.ts`
- **Description**: in `buildContract`, compute `activity_daily` by grouping the
  full canonical activity rows by day and kind, then window the emitted
  `activities[]` to the last 30 days. Bump `CONTRACT_VERSION` major (3.5.0 →
  4.0.0, per the v2.0.0 windowing precedent).
- **Dependencies**:
  - Task 2.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Emitted `activities[]` contains only the last 30 days (anchored to
    `generated_at`).
  - `activity_daily` totals reconcile with the full canonical activity set
    (sum of buckets == canonical count by kind).
  - `CONTRACT_VERSION` major is bumped; the range API envelope stays consistent.
  - Emitted `contract.json` is materially smaller (target ~5–6 MB raw).
- **Validation**:
  - `pnpm run typecheck && pnpm test`.
  - Emit a contract; validate against schema; record raw/gz size before/after.

### Task 2.3: Rewire the Activity Overview to read `activity_daily`

- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/model.ts`
  - Activity Overview components + tests
- **Description**: change `buildActivityHeatmap` / `buildActivityTrend` and the
  overview tallies to read `activity_daily` (anchored at the contract
  `generated_at`) instead of the full raw `allActivities`. The "selected range"
  chart derives from the same daily buckets for ranges ≤12 months.
- **Dependencies**:
  - Task 2.1
  - Task 2.2
- **Complexity**: 6
- **Acceptance criteria**:
  - The 12-month overview block, heatmap, busiest-day, active-days, and by-kind
    totals render correctly from `activity_daily` with raw activities windowed to
    30 days; numbers match the pre-change private deployment host values.
  - The overview no longer reads the full raw `activities[]`.
  - Rendering is anchored to the contract `generated_at`, not the UI clock.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm --filter @symphony-board/ui run build` + smoke.

### Task 2.4: Drop redundant `id` and `summary`

- **Location**:
  - `packages/contract/types.ts`
  - `packages/contract/contract.schema.json`
  - `src/contract/build.ts`
  - `packages/ui/src/contract.ts`
- **Description**: remove the activity `id` (`= source_id|external_id`) and
  `summary` fields and reconstruct them once in `parseContract`, folding the
  removal into this major bump.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 4
- **Acceptance criteria**:
  - `id`/`summary` are absent from the emitted contract and reconstructed once
    in `parseContract`; downstream consumers are unchanged.
  - Emitted `contract.json` drops a further ~1.3–1.8 MB.
- **Validation**:
  - `pnpm run typecheck && pnpm test` + UI tests.

## Sprint 3: UI range model

**Goal**: serve ranges that fit the static window locally (no round-trip) and
only fetch `/api/range` for wider ranges.

**Demo/Validation**:

- Command(s): `pnpm --filter @symphony-board/ui run test` + smoke, network
  capture on 1w / 1mo / 6mo.
- Verify: 1w/1mo do not hit `/api/range`; 6mo/1yr do.

### Task 3.1: Narrow-local / wide-fetch range threshold

- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/model.ts`
  - relevant UI tests
- **Description**: change the `needsRangeEnv` gate from "range differs from the
  static window" to "range is wider than the 30-day local threshold". For ranges
  within the threshold, filter the already-loaded static contract locally; only
  wider ranges fetch `/api/range`.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 5
- **Acceptance criteria**:
  - 1w and 1mo views perform no `/api/range` round-trip (local filter), verified
    by network capture.
  - 6mo and 1yr views fetch `/api/range` and render full data.
  - No regression in source/repo visibility, search, or facet filtering.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm --filter @symphony-board/ui run build` + smoke.
