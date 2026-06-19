# Activity Windowing + Aggregates + Range Model — Implementation Handoff

- **Status:** ready for plan tracking (L2)
- **Date:** 2026-06-19
- **Source:** discussion-to-implementation-doc (converged design discussion)
- **Intended next step:** open an L2 plan-tracking issue; deliver in the PR
  sequence below.

## Purpose

`contract.json` is ~17.5 MB locally / ~19.5 MB on g14 because it inlines the
**full ~16-month activity history** on every page load. Shrink the per-load
contract and let the UI reach a full year of data **without** a separate archive
file, by: windowing raw activities in the static contract, pre-computing the
Activity Overview stats as an aggregate, serving narrow ranges locally and wide
ranges through `/api/range`, and making `/api/range` cheap at the SQL layer.

## Confirmed facts (with evidence)

- **Size:** `data/contract.json` 17.5 MB raw / ~1.6 MB gz local; **19.5 MB** on
  g14. `activities` is **87%** (~12.4 MB; `id`/`url`/`summary`/`details.body`
  are the heavy fields). Measured.
- **Windowing today:** `items[]` is windowed to **90 days** (contract v2.0.0,
  `CONTRACT_ITEM_WINDOW_DAYS=90` in `src/contract/build.ts`). `activities[]` is
  **NOT windowed** — the full ~16 months ships. Measured: emitted activities
  span 2025-02 → 2026-06.
- **Store retention:** the canonical store keeps everything (~16 months); the
  `activity` table has no `deleted_at` and is never age-pruned. Only items/edges
  are soft-deleted on a full sweep (`src/sync-engine.ts`).
- **`/api/range` works and is whole-site.** Measured on g14: a 180-day request
  returns the full envelope (items 2107, activities 12285, edges 2283),
  gzipped. Mounted on the standalone server (`src/cli/app-server.ts:117-129`)
  and proxied by nginx in compose (`docker/ui-nginx.conf`). It reads the full
  store via `store.listActivities()` (**no SQL date bound** — scans all rows,
  filters in JS) and returns `aggregates: []`.
- **nginx already gzips** `contract.json` and `/api/range` (measured
  `Content-Encoding: gzip`). The **standalone `app-server` serves raw**
  (`src/cli/app-server.ts:67`) — the only un-gzipped path.
- **UI range behavior (reproduced via headless Chrome on g14):**
  - `activeEnv = needsRangeEnv ? rangeEnv : env` (`App.tsx:398`);
    `customRange = activeRange !== staticRange` → the UI fetches `/api/range`
    **whenever the range differs from the 90-day static window, even when it is
    narrower** (the default `this-week` preset already round-trips).
  - Board responds to 6mo (286 → 2107 items); Activity feed responds (2171 →
    12291 in range). So long ranges already work site-wide.
  - The **Activity Overview "last 12 months" block + heatmap** is a **fixed
    trailing-12-month view, range-independent by design**, computed
    **client-side from the static `env.activities`** (`App.tsx:1117`,
    `buildActivityHeatmap`/`buildActivityTrend`). It reads **raw activities, not
    `aggregates`**. This is the only piece that breaks if raw activities are
    windowed.
- **Existing `aggregates[]`** carry **item dimensions only** (`by_state`,
  `by_kind`, `by_lifecycle`) at windows ≤90d (`ACTIVE_WINDOW_DAYS=[7,14,30,90]`).
  There are **no activity-dimension aggregates** today.
- **Contract version:** `3.5.0` (`src/contract/version.ts:10`). Change
  discipline: schema + types + version bump + test (`docs/CONTRACT.md`).

## Decisions

1. **Window raw `activities[]` in the static contract to 30 days** (items stay
   90 days, unchanged).
2. **Add a pre-computed `activity_daily` aggregate** covering **≥12 months**,
   per-day per-kind event counts, so the Activity Overview (12-month block,
   heatmap, by-kind totals, busiest day, active days) and the "selected range"
   chart (for ranges ≤12 months) **no longer depend on full raw activities**.
3. **UI range model — narrow = local, wide = fetch.** For a selected range that
   fits within the static contract's data, the UI **filters the already-loaded
   contract locally (zero round-trip)**; only a range **wider than the static
   window** fetches `/api/range`. Use the **minimum static window (30 days) as
   the single local threshold**: range ≤30d → local; >30d → `/api/range`. This
   makes the common **1w/1mo** views instant.
4. **Add SQL date-bounding to the range query** so `/api/range` no longer scans
   the entire `activity` table; bounded query implemented for **both** SQLite
   and Postgres drivers and used by `src/server/range.ts`.
5. **gzip the standalone `app-server`** contract response by `Accept-Encoding`,
   caching the compressed buffer keyed on the emitted file's mtime.
6. **No separate archive / cold-pack file** (the earlier "cold pack" option is
   rejected). All long-range data goes through `/api/range`.
7. **Contract major bump (→ `4.0.0`).** Narrowing `activities[]` is a breaking
   change to an emitted row collection, following the **v2.0.0** precedent that
   windowing `items[]` was a major bump (`docs/DESIGN.md` §269-276). The new
   `activity_daily` field is itself additive; it rides in the same major bump.
8. **Overview anchored to `generated_at`.** The trailing-12-month buckets and
   the heatmap must be anchored at the contract's `generated_at` (emit time),
   not the UI wall clock, so the aggregate and its rendering agree.

## Scope

- **Contract** (`packages/contract/`): new `activity_daily` DTO; narrow
  `activities[]` semantics; major version bump; update types,
  `contract.schema.json`, tests, `docs/CONTRACT.md`, and `docs/DESIGN.md`.
- **Emit** (`src/contract/build.ts`): compute `activity_daily` via group-by over
  the full activity rows at emit; apply the 30-day window to emitted
  `activities[]`.
- **UI** (`packages/ui/src/`): Overview heatmap/trend/tallies read
  `activity_daily` instead of raw `allActivities`; implement the
  narrow-local / wide-fetch threshold (change the `needsRangeEnv` gate from
  "differs from static" to "wider than the 30d threshold").
- **Server** (`src/cli/app-server.ts`): gzip the contract response.
- **Store + range** (`src/db/*`, `src/server/range.ts`): date-bounded activity
  query for both drivers.

## Non-scope

- No separate archive/cold-pack artifact.
- No change to the 90-day `items[]` window.
- No provider sync / `normalize` changes.
- by-actor / per-repo analytics stay in `repo_metrics[]` (already range-served);
  they are **not** folded into `activity_daily`.
- No DB schema change for the aggregate (computed at emit from existing rows).
  An additive `activity(occurred_at)` index **may** be needed for the bounded
  query to be efficient — see Risks; if so it is an additive migration to BOTH
  `schema/sqlite/` and `schema/postgres/`.

## Implementation boundaries

- `normalize` stays pure (no IO); aggregate computation is emit-side in
  `src/contract/build.ts`, reading already-loaded canonical activity rows.
- Keep the three layers separate; the contract stays Layer 3. The new aggregate
  follows additive-within-major rules; the breaking part justifying the major
  bump is the `activities[]` narrowing.
- E touches the `Store` seam → Postgres gates are required for that PR.

## Requirements / acceptance criteria

1. With raw activities windowed to 30d, the Activity Overview 12-month block,
   heatmap, by-kind totals, busiest day, and active-days render **correct
   numbers** (match the pre-change values measured on g14: ~13,781 events,
   busiest 510, 265/370 active days, commit/CR/review split) — sourced from
   `activity_daily`.
2. **1w and 1mo views perform NO `/api/range` round-trip** (served by local
   filter of the static contract). Verified by network capture.
3. **6mo / 1yr views fetch `/api/range`** and render full data.
4. `/api/range` is **date-bounded at the SQL layer** (no full-table activity
   scan). Verified by query plan / rows-read.
5. The standalone `app-server` returns `Content-Encoding: gzip` when the client
   sends `Accept-Encoding: gzip`.
6. Emitted `contract.json` is **materially smaller** (target ~5–6 MB raw /
   ~0.6 MB gz). Measured before/after.
7. `contract_version` major bumped; schema + types + tests updated; consumers
   branch on the new major.

## Validation plan

- `pnpm run typecheck && pnpm test`
- `pnpm --filter @symphony-board/ui run build` + UI tests + UI render-smoke
  (UI + contract + shared view-model touched).
- `pnpm run test:pg-e2e && pnpm run test:pg-compose` (E touches the `Store` seam
  / both drivers; Docker required).
- Emit a contract and run contract validation against the schema; record
  raw + gz size before/after.
- A `--dry-run` sync sanity check (engine untouched, but emit path changed).

## Risks and guardrails

- **Major bump breaks existing consumers.** `scripts/contract-summary.sh` counts
  items/edges/activities from the emitted contract and will now see 30d of
  activities. Guardrail: update that script; document the major in
  `docs/CONTRACT.md`; bump `CONTRACT_VERSION`.
- **Local threshold simplification.** Using 30d (the min window) as the single
  local threshold means 30–90d pure-item views also round-trip even though items
  exist locally for 90d. Accepted (not the common case); per-type local logic is
  deferred.
- **Aggregate anchoring.** `activity_daily` buckets and the heatmap must be
  anchored at `generated_at`, and the UI must render relative to it (today the
  UI uses `Date.now()`), or the 12-month window will drift between emit and view.
- **Query efficiency.** The date-bounded activity query may need an additive
  index on `activity(occurred_at)` in both drivers; confirm with the query
  planner during E.

## Execution

- Recommended plan: `docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-plan.md`
- Recommended execution state: `docs/plans/2026-06-19-activity-windowing-aggregates/activity-windowing-aggregates-execution-state.md`
- Status: ready for plan tracking
- **Suggested PR sequence (dependency-ordered):**
  1. **A** — gzip the standalone `app-server` (independent, no contract change).
  2. **E** — `/api/range` SQL date-bounding for both drivers (independent;
     Postgres gates).
  3. **C** — contract major bump: window `activities[]` to 30d + add
     `activity_daily` + rewire the Activity Overview to read it.
  4. **UI range model** — narrow-local / wide-fetch threshold.
  5. **B (optional rider)** — drop the redundant `id` (`= source_id|external_id`)
     and `summary` fields, reconstruct in `parseContract`; only if opted in, fold
     into the step-3 major bump.

## Retention intent

Plan-source for the L2 issue; cleanable after execution and devlog entry.
Promote any durable contract-shape rationale into `docs/CONTRACT.md` /
`docs/DESIGN.md` during step 3 rather than leaving it here.

## Read-first references

- `docs/CONTRACT.md` (versioning + change discipline)
- `docs/DESIGN.md` §255-267 (aggregates), §269-294 (v2.0.0 item windowing
  precedent + repo_metrics), §278-283 (`range_query` / `/api/range`)
- `src/contract/build.ts`, `src/contract/version.ts`
- `packages/ui/src/App.tsx:398,1117`, Overview components
- `src/server/range.ts`, `src/db/*`, `src/cli/app-server.ts:67,117-129`
- `docker/ui-nginx.conf`

## Recommended next artifact

L2 plan-tracking issue via `create-plan-tracking-issue`, linking this document
under `Read First`.
