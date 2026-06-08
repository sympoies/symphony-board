# Repo Analytics Contract And Trends UI Source

- Status: decisions settled; ready for L2 plan tracking.
- Date: 2026-06-08
- Source: product/design discussion, current repo docs and code, and official
  GitHub/GitLab API docs checked on 2026-06-08.
- Intended next step: open an L2 plan-tracking issue from this bundle.

## Execution

- Recommended plan: docs/plans/2026-06-08-repo-analytics-contract-trends-ui/2026-06-08-repo-analytics-contract-trends-ui-plan.md
- Recommended execution state: docs/plans/2026-06-08-repo-analytics-contract-trends-ui/2026-06-08-repo-analytics-contract-trends-ui-execution-state.md
- Status: decisions settled; plan tracking is the next step.
- Next-task source: this document.

## Problem

The UI needs a new per-repo analytics page with the same shared time-range UX
used by Board, Graph, and Activity. The target is Option C: accurate per-repo
trend data over explicit windows, not a UI-only summary over whatever happens
to be loaded in the static contract.

The user is comfortable changing the contract because the repo is still under
active development, but does not want to revisit the contract every time the UI
adds a new chart. The implementation therefore needs a broad repo analytics
contract and canonical data plan before building the page.

## User Decisions

- [U1] Add a UI page for per-repo statistics, using the same date range controls
  and default quick-range buttons as the other pages.
- [U2] Target Option C: real per-repo trend analytics over selected ranges.
- [U3] Contract changes are acceptable now, but the design should avoid frequent
  follow-up contract churn.
- [U4] Option C should include the useful data foundation that Option B would
  need, but it should be delivered as part of the analytics plan rather than as
  a separate intermediate UI.
- [U5] Evaluate useful GitHub/GitLab fields up front so future UI charts do not
  require another data-contract redesign.

## Confirmed Repository Facts

- [F1] `README.md` describes the implemented baseline: GitHub/GitLab sources,
  raw and canonical SQLite storage, contract major v2, read-only UI, and Docker
  services where `board` is the sole writer.
- [F2] `docs/CONTRACT.md` says the current emitted version is `2.1.0`.
  Top-level `repo_stats[]` is required in v2 but only carries full repo counts
  by state and kind; it is not range-scoped trend data.
- [F3] `docs/DESIGN.md` keeps raw store, canonical DB, and versioned contract as
  separate layers. `normalize` and `buildContract` are pure mapping boundaries.
- [F4] `src/model/types.ts` currently models item identity, lifecycle
  timestamps, state, labels, review/CI/merge signals, milestone, demand, edges,
  and timestamped activity records.
- [F5] `schema/0001_init.sql` stores canonical item/edge/label/source/sync
  data. `schema/0002_activity.sql` stores open-vocabulary activity rows with
  provider-specific details in opaque JSON.
- [F6] `src/sources/github.ts` already fetches GitHub issue/PR fields covering
  identity, title, state, author, repository, labels, comment/reaction demand,
  closing references, mentions, PR draft/review/mergeability/CI, commits, and
  repository activity.
- [F7] `src/sources/gitlab.ts` already fetches GitLab issue/MR fields covering
  identity, title, state, author, labels, notes/upvotes demand, related MRs,
  parsed system-note mentions/relates, MR draft/approval/CI/merge status,
  commits, and project events.
- [F8] `packages/ui/src/model.ts` already defines shared `TIME_RANGE_PRESETS`
  of 1w, 2w, 1mo, and 3mo, a default 90-day range, URL-backed `from`/`to`
  parsing, and range filtering helpers.

## Official Provider References Checked

- [W1] GitHub GraphQL issue reference documents issue state, timestamps,
  comments, reactions, closing pull request references, state reasons, issue
  dependencies, parent/sub-issues, and milestone fields:
  https://docs.github.com/en/graphql/reference/issues
- [W2] GitHub GraphQL pull request/reference docs expose PR state, review
  decision/state, status check rollups, mergeability, closing issue references,
  commit connections, timeline items, and diff-related fields:
  https://docs.github.com/en/graphql/reference/pulls
- [W3] GitHub REST commit docs expose commit listing by repository with
  `since`, `until`, pagination, author/committer dates, SHA, message, URL, and
  signature verification metadata:
  https://docs.github.com/en/rest/commits/commits
- [W4] GitHub REST activity/event docs expose repository activity/event surfaces
  useful for push, branch/tag, and repository-level activity:
  https://docs.github.com/en/rest/activity/events
- [W5] GitLab Issues API exposes labels, assignees, author, milestones,
  due-date filters, issue type, iteration, weight, health status, created and
  updated filters, and cross-reference/metadata surfaces:
  https://docs.gitlab.com/api/issues/
- [W6] GitLab Merge Requests API exposes assignees, reviewers, branches,
  state, draft status, label details, approvals, merge status, detailed merge
  status, conflict signals, timestamps, and merge metadata:
  https://docs.gitlab.com/api/merge_requests/
- [W7] GitLab Commits API exposes repository commits with `since`, `until`,
  `with_stats`, author/committer dates, SHA, title/message, trailers, and URL:
  https://docs.gitlab.com/api/commits/
- [W8] GitLab Events API exposes project events filtered by action, target type,
  `after`, `before`, and includes issue/MR/note/push data such as
  `action_name`, `target_iid`, `target_type`, `created_at`, and `push_data`:
  https://docs.gitlab.com/api/events/

## Decisions

- Treat this as an L2 plan because it touches provider fetchers, canonical DB,
  contract schema/types/versioning, range API behavior, and a new UI page.
- Add a broad optional repo analytics contract field, tentatively
  `repo_metrics[]`, instead of extending `repo_stats[]` into a larger shape.
  `repo_stats[]` should remain the full inventory/count surface.
- Keep the contract additive and minor-versioned if possible. The expected
  contract bump is `2.2.0`, with optional fields that consumers can ignore.
- Represent provider-specific vocabularies as open maps in metrics, not as new
  closed enums. Examples: `by_activity_kind`, `by_activity_action`,
  `by_label_scope`, `by_review_state`, `by_ci_state`, and `by_merge_state`.
- Group analytics by `(source_id, project_path)` for display, while continuing
  to use provider immutable ids for item and edge identity.
- Include explicit `data_quality` metadata for each repo metric row so the UI
  can distinguish zero activity from missing/truncated activity.
- Use canonical rows and stored raw payloads for backfill/replay where possible.
  Do not make the UI fetch providers or read SQLite directly.
- Defer provider traffic/views/clones, full body/comment/review text, full
  per-file diff lists, and arbitrary raw provider payload dependencies. Those
  have weaker provider parity, retention, permissions, or privacy tradeoffs.

## Provider Field Inventory To Support

The first implementation should design storage and contract aggregation so the
following fields can be supported without another contract redesign:

1. Repo identity and health:
   - `source_id`, provider kind, host, display name, source status.
   - `project_path`, display color, observed range, observed since.
2. Item lifecycle:
   - Item kind, normalized state, raw state, state reason.
   - Created, updated, closed, merged, last-seen timestamps.
   - Opened, active, closed, merged, reopened-style activity where available.
3. Issue planning metadata:
   - Labels and parsed label scopes.
   - Milestone/title where available.
   - Assignees, author, issue type, due date, weight/priority/health/iteration
     when available and safely nullable across providers.
4. Change request health:
   - Draft status, review state, CI state, merge state.
   - Source/base or source/target branch names.
   - Commit count, changed-file count, additions, deletions when available.
   - Review/comment/approval/discussion counts where available.
5. Relationship analytics:
   - Edge type and lifecycle counts.
   - `closes`, `mentions`, `relates`, and future dependency/parent-child edge
     counts using open edge-type vocabulary.
6. Activity analytics:
   - Activity kind/action counts.
   - Commits, pushes, branch/tag creation/deletion, comments, reviews,
     approvals, and CI/status events when provider surfaces allow them.
   - Actor/author summaries only as bounded top lists or aggregate counts, not
     unbounded per-user maps in the stable contract.
7. Data quality:
   - Activity availability, truncation/paging cap flags, bucket coverage,
     earliest observed activity, source errors, and notes about provider
     feature gaps.

## Proposed Contract Shape

The implementation may refine names, but the plan should preserve this shape:

```ts
interface RepoMetricDTO {
  source_id: string;
  project_path: string | null;
  window: {
    kind: "time_range" | "active_since";
    basis: "repo_activity";
    from: string;
    to: string;
    bucket: "day" | "week" | "month";
  };
  totals: RepoMetricStatsDTO;
  series: Array<{
    bucket_start: string;
    bucket_end: string;
    stats: RepoMetricStatsDTO;
  }>;
  top_actors?: Array<{
    actor: string;
    activities: number;
    commits: number;
    items_opened: number;
    change_requests_merged: number;
  }>;
  data_quality: {
    activity_available: boolean;
    truncated: boolean;
    observed_since: string | null;
    notes: string[];
  };
}

interface RepoMetricStatsDTO {
  items_active: number;
  items_opened: number;
  items_closed: number;
  change_requests_opened: number;
  change_requests_closed: number;
  change_requests_merged: number;
  activities: number;
  commits: number;
  pushes: number;
  comments: number;
  reviews: number;
  approvals: number;
  edge_declared: number;
  edge_fulfilled: number;
  edge_broken: number;
  by_item_state: Record<string, number>;
  by_item_kind: Record<string, number>;
  by_activity_kind: Record<string, number>;
  by_activity_action: Record<string, number>;
  by_edge_type: Record<string, number>;
  by_edge_lifecycle: Record<string, number>;
  by_review_state: Record<string, number>;
  by_ci_state: Record<string, number>;
  by_merge_state: Record<string, number>;
  by_label_scope: Record<string, number>;
}
```

## UI Requirements

- Add a top-level Repo Analytics page/tab alongside Board, Graph, Activity, and
  Settings.
- Reuse the same shared `TimeRangeControls`, URL-backed `from`/`to` state, and
  quick presets: 1w, 2w, 1mo, 3mo.
- For the default static contract window, render from static contract data when
  compatible. For custom ranges, use `/api/range` and the returned
  `repo_metrics[]`.
- Show a ranked repo table with at least active items, opened/closed items,
  merged change requests, commits, pushes, comments/reviews when present, and a
  data-quality indicator.
- Show trend charts for repo activity over time and lifecycle throughput. The
  first chart implementation can use lightweight SVG/CSS in the existing UI
  stack; do not add a charting dependency unless the implementation needs it.
- Keep provider gaps visible. A repo with no fetched activity should not look
  identical to a repo with fetched activity and true zero events.

## Non-Goals

- No provider write actions from the UI.
- No live provider fetches from the browser or automated tests.
- No second DB writer; Docker `board` remains the sole writer.
- No stable contract dependency on raw provider payloads.
- No full comment/review/body text in the analytics contract.
- No traffic/views/clones metrics in this first version.

## Acceptance Criteria

1. The contract has an optional repo analytics field that can represent totals,
   buckets, open-vocabulary breakdowns, top bounded actors, and data-quality
   metadata for each repo.
2. The canonical layer stores or derives the provider fields needed for useful
   repo analytics without exposing the SQLite schema as the contract.
3. GitHub and GitLab normalization include parity-safe fields where available
   and preserve provider gaps as nullable fields or data-quality notes.
4. Static contract and `/api/range` responses validate against the same schema
   family, with range responses carrying repo metrics for the selected window.
5. The UI adds a Repo Analytics page using the existing shared time-range UX and
   quick presets.
6. Tests cover provider normalization fixtures, DB migration/backfill behavior,
   contract validation, range metrics, UI model helpers, and render smoke.
7. Docs explain which metrics are reliable, which are provider-dependent, and
   why `repo_stats[]` remains separate from `repo_metrics[]`.

## Risks And Guardrails

- Provider parity is uneven. Prefer nullable fields, open maps, and
  `data_quality.notes` over pretending GitHub and GitLab expose identical
  signals.
- Some metrics are only known from the moment activity fetching began. Always
  expose `observed_since` and truncation flags.
- Large ranges can be expensive. Keep bucket size explicit and leave room for
  future pagination or maximum-range policy.
- Mutable repo paths are display keys. Do not use `project_path` as item
  identity.
- Backfilling from stored raw can reduce provider refetching, but new provider
  fields not present in raw snapshots require a later sync to appear.

## Read-First References

- `README.md`
- `docs/DESIGN.md`
- `docs/CONTRACT.md`
- `packages/contract/types.ts`
- `packages/contract/contract.schema.json`
- `src/contract/build.ts`
- `src/contract/version.ts`
- `src/model/types.ts`
- `schema/0001_init.sql`
- `schema/0002_activity.sql`
- `src/sources/github.ts`
- `src/sources/gitlab.ts`
- `src/db/repo.ts`
- `src/cli/range-api.ts`
- `packages/ui/src/model.ts`
- `packages/ui/src/App.tsx`
- `packages/ui/src/components/TimeRangeControls.tsx`

## Retention Intent

Retire this bundle through the plan-tracking closeout and archive flow after the
repo analytics contract, metrics builder, and UI page land and are validated.
