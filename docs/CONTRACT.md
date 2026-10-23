# Contract Versioning

The contract is LAYER 3: the serialized projection consumed by the UI and any
external reader. It is not the SQLite schema and not the stored truth. It is
derived from raw/canonical data whenever `emit` runs.

Definition files:

- `packages/contract/contract.schema.json`: normative JSON Schema
- `packages/contract/types.ts`: TypeScript DTO mirror
- `src/contract/version.ts`: `CONTRACT_VERSION` and `GENERATOR`
- `src/contract/validate.ts`: dependency-free producer validator

Current emitted version: `4.11.0`.

Major 4 version index (newest first). Each note lives beside the field it
changes; earlier majors are described inline where their fields are defined.

| Version | Kind | Change | Section |
| --- | --- | --- | --- |
| `4.11.0` | additive | optional `range_query.view`; opt-in slim `GET /api/range?view=commits` projection | Range Query |
| `4.10.0` | additive | optional `sync_run` checkpoint coverage for per-source publication | Sync Checkpoints |
| `4.9.1` | clarification | `target_ref` / `title` filled on comment rows; any in-range row's target is a range support row | [Activities](contract-activities-reference.md#activities) |
| `4.9.0` | additive | optional top-level `commit_file_stats` | [Commit File Stats](contract-activities-reference.md#commit-file-stats) |
| `4.8.2` | clarification | `details.change_request` on commit activity rows; in-range commits pull their change request into a range response | [Activities](contract-activities-reference.md#activities) |
| `4.8.1` | clarification | `details.merge` / `details.default_branch` on commit activity rows | [Activities](contract-activities-reference.md#activities) |
| `4.8.0` | additive | `items[].window_reasons` value `program_tracker`; open labeled program trackers are always emitted | Item Window |
| `4.7.3` | clarification | `parent` / `blocks` edges from program tracker phase tables | Edges |
| `4.7.2` | clarification | `details.actor_avatar_url` on supported activity rows | [Activities](contract-activities-reference.md#activities) |
| `4.7.1` | clarification | `details.additions` / `details.deletions` on commit activity rows | [Activities](contract-activities-reference.md#activities) |
| `4.7.0` | additive | optional top-level `actor_directory` | [Activities](contract-activities-reference.md#activities) |
| `4.6.0` | additive | optional `items[].comments` (`{ total }`) | [Activities](contract-activities-reference.md#activities) |
| `4.5.0` | additive | optional `items[].body` | [Activities](contract-activities-reference.md#activities) |
| `4.4.0` | additive | range `activity_target` item rows and `item_window.activity_target_items` | [Activities](contract-activities-reference.md#activities) |
| `4.3.0` | additive | `review_threads[].last_comment_at` | [Activities](contract-activities-reference.md#activities) |
| `4.2.1` | clarification | config is the source of truth for surfaced sources, repos, and rows | Config-Gated Projection |
| `4.2.0` | additive | `review_threads[].comments[].avatar_url` | [Activities](contract-activities-reference.md#activities) |
| `4.1.0` | additive | optional top-level `review_threads[]` | [Activities](contract-activities-reference.md#activities) |
| `4.0.0` | major | static `activities[]` windowed to 30 days; activity `id` / `summary` removed; `activity_daily` added | [Activities](contract-activities-reference.md#activities), [Activity Daily](contract-activities-reference.md#activity-daily) |

The private workspace package version in `packages/contract/package.json` is
package metadata. Consumers must use the envelope's `contract_version`, not the
package version, to decide compatibility.

## Envelope

```jsonc
{
  "contract_version": "4.10.0",
  "generated_at": "2026-06-08T00:00:00.000Z",
  "generator": "symphony-board/<app-version>", // <name>/<root package.json version>
  "timezone": "UTC",
  "sources": [
    {
      "source_id": "github:github.com",
      "kind": "github",
      "host": "github.com",
      "display_name": "GitHub",
      "last_success_at": "2026-06-08T00:00:00.000Z",
      "last_status": "ok",
      "color": "#1f6feb"
    }
  ],
  "items": [
    {
      "id": "github:github.com|ISSUE_1",
      "source_id": "github:github.com",
      "external_id": "ISSUE_1",
      "kind": "issue",
      "project_path": "sympoies/symphony-board",
      "iid": 56,
      "url": "https://github.com/sympoies/symphony-board/issues/56",
      "title": "Contract windowing",
      "body": "Provider issue or PR/MR body text.",
      "state": "open",
      "state_raw": "OPEN",
      "state_reason": null,
      "is_draft": null,
      "author": "dev-a",
      "created_at": "2026-06-01T00:00:00.000Z",
      "updated_at": "2026-06-08T00:00:00.000Z",
      "closed_at": null,
      "merged_at": null,
      "labels": [],
      "review_state": null,
      "ci_state": null,
      "merge_state": null,
      "review_threads": null,
      "milestone": null,
      "comments": { "total": 3 },
      "demand": 3,
      "last_seen_at": "2026-06-08T00:00:00.000Z",
      "window_reasons": ["primary", "edge_endpoint"]
    }
  ],
  "edges": [],
  "activities": [],
  "review_threads": [
    {
      "id": "github:github.com|PRRT_1",
      "source_id": "github:github.com",
      "external_id": "PRRT_1",
      "project_path": "sympoies/symphony-board",
      "target_ref": "github:github.com|PR_2",
      "target_iid": 2,
      "title": "Improve sync",
      "url": "https://github.com/sympoies/symphony-board/pull/2#discussion_r1",
      "is_resolved": false,
      "is_outdated": false,
      "resolved_by": null,
      "path": "src/sync.ts",
      "line": 42,
      "start_line": 40,
      "comments_total": 2,
      "comments": [
        {
          "id": "PRRC_1",
          "author": "reviewer",
          "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
          "body": "Please cover this branch.",
          "url": "https://github.com/sympoies/symphony-board/pull/2#discussion_r1",
          "created_at": "2026-06-08T01:00:00.000Z",
          "updated_at": "2026-06-08T01:10:00.000Z"
        }
      ],
      "last_comment_at": "2026-06-08T01:10:00.000Z",
      "last_seen_at": "2026-06-08T02:00:00.000Z"
    }
  ],
  "activity_daily": {
    "timezone": "UTC",
    "from": "2025-02-01",
    "to": "2026-06-08",
    "total": 13781,
    "by_kind": { "commit": 9200, "change_request": 1800, "review": 1400, "issue": 1381 },
    "days": [
      { "date": "2025-02-01", "count": 12, "by_kind": { "commit": 9, "review": 3 } }
    ]
  },
  "repos": [
    {
      "source_id": "github:github.com",
      "project_path": "sympoies/symphony-board",
      "color": "#e0af68"
    }
  ],
  "aggregates": [
    {
      "scope": "boardWindow",
      "window": {
        "kind": "active_since",
        "basis": "item_updated_at",
        "since": "2026-03-10T00:00:00.000Z",
        "days": 90,
        "edge_filter": null
      },
      "stats": {
        "items": 42,
        "by_state": { "open": 10, "closed": 32 },
        "by_kind": { "issue": 36, "change_request": 6 },
        "by_lifecycle": { "fulfilled": 5, "declared": 1 }
      }
    }
  ],
  "item_window": {
    "scope": "boardWindow",
    "window": {
      "kind": "active_since",
      "basis": "item_updated_at",
      "since": "2026-03-10T00:00:00.000Z",
      "days": 90,
      "edge_filter": null
    },
    "primary_items": 42,
    "edge_endpoint_items": 4,
    "activity_target_items": 0,
    "total_items": 1519,
    "truncated": true
  },
  "repo_stats": [
    {
      "source_id": "github:github.com",
      "project_path": "sympoies/symphony-board",
      "items": 100,
      "by_state": { "open": 12, "closed": 88 },
      "by_kind": { "issue": 90, "change_request": 10 }
    }
  ],
  "repo_metrics": [
    {
      "source_id": "github:github.com",
      "project_path": "sympoies/symphony-board",
      "repo_url": "https://github.com/sympoies/symphony-board",
      "window": {
        "kind": "time_range",
        "basis": "repo_activity",
        "from": "2026-06-01T00:00:00.000Z",
        "to": "2026-06-08T23:59:59.999Z",
        "bucket": "day"
      },
      "totals": {
        "items_active": 12,
        "items_opened": 3,
        "items_closed": 2,
        "change_requests_opened": 2,
        "change_requests_closed": 1,
        "change_requests_merged": 1,
        "activities": 24,
        "activity_score": 19,
        "commits": 7,
        "pushes": 3,
        "comments": 5,
        "reviews": 2,
        "approvals": 1,
        "edge_declared": 4,
        "edge_fulfilled": 2,
        "edge_broken": 1,
        "by_item_state": { "open": 7, "closed": 4, "merged": 1 },
        "by_item_kind": { "issue": 9, "change_request": 3 },
        "by_activity_kind": { "commit": 7, "push": 3 },
        "by_activity_action": { "committed": 7, "pushed": 3 },
        "by_edge_type": { "closes": 7 },
        "by_edge_lifecycle": { "declared": 4, "fulfilled": 2, "broken": 1 },
        "by_review_state": { "approved": 1 },
        "by_ci_state": { "passing": 1, "pending": 1 },
        "by_merge_state": { "mergeable": 1, "blocked": 1 },
        "by_label_scope": { "workflow": 2, "priority": 3 }
      },
      "series": [
        {
          "bucket_start": "2026-06-01T00:00:00.000Z",
          "bucket_end": "2026-06-01T23:59:59.999Z",
          "stats": { "...": "same shape as totals" }
        }
      ],
      "top_actors": [
        {
          "actor": "dev-a",
          "actor_key": "provider-user:github:github.com:dev-a",
          "display_name": "dev-a",
          "aliases": ["Gray Surf"],
          "profile_url": "https://github.com/dev-a",
          "activities": 8,
          "commits": 3,
          "items_opened": 1,
          "change_requests_merged": 1
        }
      ],
      "data_quality": {
        "activity_available": true,
        "observed_since": "2026-05-24T00:00:00.000Z",
        "last_activity_at": "2026-06-07T08:50:00.000Z",
        "notes": []
      }
    }
  ],
  "range_query": {
    "kind": "time_range",
    "timezone": "UTC",
    "from": "2026-06-01T00:00:00.000Z",
    "to": "2026-06-08T23:59:59.999Z"
  }
}
```

Top-level fields:

- `contract_version`: semver. Consumers branch on major.
- `generated_at`: emit time.
- `generator`: producer name and version.
- `timezone`: optional IANA timezone the producer buckets calendar days in
  (from config; `"UTC"` when unset), added in `3.1.0`.
- `sources`: source health and source display metadata.
- `sync_run`: optional current-run source coverage, added in `4.10.0` (see Sync Checkpoints).
- `items`: windowed normalized work items in contract v2.
- `edges`: typed relationships whose endpoints are resolved by the v2 item
  window whenever the endpoint belongs to a tracked item.
- `activities`: optional developer-significant event feed, added in `1.2.0`. As
  of `4.0.0` the static contract windows it to the last 30 days (see Activities).
- `review_threads`: optional current provider review-thread detail rows, added
  in `4.1.0` (see Activities).
- `activity_daily`: optional pre-computed per-day/per-kind activity counts, added
  in `4.0.0` (see Activity Daily). Emitted by both the static contract (over the
  full canonical history) and `/api/range` (over the in-range activities).
- `actor_directory`: optional identity and bot directory over the distinct
  `activities[].actor` strings, added in `4.7.0` (see Activities).
- `commit_file_stats`: optional per-repository aggregate of the files and
  directories the emitted commit rows changed most, added in `4.9.0` (see
  Commit File Stats).
- `repos`: optional sparse per-repo display metadata, added in `1.1.0`.
- `aggregates`: optional scope/windowed totals, added in `1.3.0`.
- `item_window`: required v2 metadata describing the primary loaded item window.
- `repo_stats`: required v2 full repo counts, independent of loaded item rows.
- `repo_metrics`: optional window-scoped repo analytics rows, added in `2.2.0`.
- `range_query`: optional metadata on read-only range API responses, added in
  `2.1.0`.

The producer currently emits `timezone`, `activities`, `review_threads`,
`activity_daily`, `actor_directory`, `repos`, `aggregates`, `item_window`,
`repo_stats`, and `repo_metrics` every time; array fields are empty when no
rows apply. `commit_file_stats` is emitted only by a producer that collects
per-commit files (see Commit File Stats). Consumers should still read older optional fields
defensively as `env.activities ?? []`, `env.repos ?? []`,
`env.aggregates ?? []`, and `env.repo_metrics ?? []`.

## Refs

Item and edge endpoints use a composite ref:

```text
<source_id>|<external_id>
```

Rules:

- `source_id` must not contain `|`.
- split on the first `|` only.
- do not parse `external_id`; GitLab ids contain characters such as `:` and `/`.

## Items

In contract v1, `items[]` contained every live provider-agnostic item row.
Contract v2 intentionally changes that semantic: `items[]` is a bounded payload
complete for `item_window` plus any older tracked item endpoints needed by
emitted edges. This is a major-version change because consumers must no longer
derive full totals, full repo inventory, or full historical Board cards from
`items[]`.

Consumers that need a full current open-work queue should use the operational
`GET /api/actionable` surface instead of deriving it from `items[]`. That route
reads the canonical store through the read-only API sidecar and is not part of
this semver contract.

Known `kind` values are `issue` and `change_request`, but the contract keeps
`kind` as an open string.

Important fields:

- `id`: composite ref.
- `source_id` / `external_id`: immutable source identity.
- `project_path` / `iid`: mutable human metadata for display and search.
- `body`: optional provider issue / PR/MR body text for detail views (4.5.0+).
  Producers may cap very large bodies and append a visible truncation marker;
  consumers should treat it as display text, not as an archival full-text copy.
- `state`: normalized `open`, `closed`, or `merged`.
- `state_raw`: provider state string for debugging/escape hatch.
- `labels`: verbatim provider labels plus parsed `scope` for `scope::value`.
- `review_state`, `ci_state`, `merge_state`: nullable provider-derived signals.
- `review_threads`: for a `change_request`, `{ open, total }` resolvable review
  threads (3.3.0+); `null` for issues and when a provider did not report it. A
  point-in-time snapshot as of the item's last sync — like `ci_state`, NOT the
  state at any one review event. See the review derivation note below.
- `comments`: optional, nullable provider discussion comment count (4.6.0+).
  GitHub change requests use `PullRequest.totalCommentsCount`, GitHub issues use
  `Issue.comments.totalCount`, and GitLab items use `userNotesCount`.
- `demand`: broader attention score; comments plus reactions/upvotes where the
  provider supplies those signals. Use `comments.total` for provider-aligned
  comment bubbles and `demand` for demand/attention ranking.
- `last_seen_at`: latest successful observation in the canonical store.
- `window_reasons`: v2 inclusion reasons. `primary` means the item belongs to
  `item_window`; `edge_endpoint` means it is included to resolve an emitted edge
  endpoint; `activity_target` means it is included to resolve an emitted review
  activity's target change request and current review-thread state, or (4.8.2+)
  the change request an emitted commit row names in `details.change_request`,
  or (4.9.1+) the item any other emitted activity row names in `target_ref`;
  `program_tracker` (4.8.0+) means it is an open program tracker labeled
  `workflow::tracking`, which is emitted whatever the window (see Item Window).
  A row can carry several reasons. Missing means "primary" when reading old v1
  payloads.

The TypeScript DTOs describe what the producer emits. The JSON Schema is the
normative validation surface.

## Edges

`edges[]` contains typed relationships. For `closes`:

- `from`: change request ref.
- `to`: issue ref.
- `from_state` and `to_state`: endpoint states observed/reconciled by sync.
- `lifecycle`: `declared`, `fulfilled`, or `broken`.

Non-`closes` edge types, such as `mentions` and `relates`, have
`lifecycle: null`.

A program tracker — an issue whose body has a `## Phase table` section with at
least one valid row — reports the program's structure as two more types:

- `parent`: `from` is the tracker issue, `to` is an issue named by a
  phase-table row. Two rows that name the same issue give one edge.
- `blocks`: `from` is the prerequisite issue, `to` is the issue that waits on
  it, one edge per `· after` dependency between two rows. A row without an
  issue ref is a gate (a release, a deploy, a decision): it is not an item, so a
  dependency on a gate is emitted as a dependency on that gate's own
  prerequisites, transitively.

Both have `lifecycle: null`, and each relationship is emitted in that one
direction only: the producer never also emits the inverse `child` or
`blocked_by`. `from_state` / `to_state` are the endpoint states observed when
the tracker was last synced; read an endpoint's current state from its
`items[]` row. `from` is the source endpoint of the relationship, not
necessarily the item that declared it: the tracker declares a `blocks` edge and
is neither of its endpoints.

A row produces no edge when the producer does not resolve its ref: the target
does not exist, the sync token cannot read it, or it is in a repository the
board does not track — only refs into the source's configured repositories are
resolved. The producer also bounds one tracker: the first 500 rows of its phase
table are read, its first 200 distinct refs are resolved, and it emits at most
1,000 `blocks` edges, all in table order; anything beyond a bound is left out.
A row removed from the tracker loses its edges at the next full sweep like any
other relationship that disappeared.

Edge type is an open string so providers can add relationship vocabulary without
changing the major version when the shape stays the same.

Version `4.7.3` is a clarification + producer-behavior patch: the GitHub
producer now emits `parent` and `blocks` edges from program tracker phase
tables. The shape is unchanged — edge `type` was already an open string — so v4
consumers need no change; a consumer that draws unknown edge types generically
starts showing them.

In contract v2, `edges[]` is emitted for relationships touching the primary item
window. The producer also includes tracked endpoint item rows for those edges so
the UI graph can resolve nodes instead of treating known items as untracked
refs. Relationships wholly outside the primary window are omitted from the
payload, while their full lifecycle counts remain available through
`aggregates[]`. The one exception is the program tracker pin (see Item Window):
a pinned tracker's `parent` edges, and the `blocks` edges whose two endpoints
are both children of pinned trackers, are always emitted.

## Activities

`activities[]` is a newest-first feed of developer-significant records, separate from `items[]`: an item is current state, an activity row is something that happened. The field list, how commit, review and comment rows are derived per provider, top-level `review_threads[]`, `actor_directory`, and the version notes for these fields (`3.2.1` to `4.9.1`) are in the [Activities reference](contract-activities-reference.md#activities).

## Commit File Stats

Version `4.9.0` is additive: the envelope may carry an optional `commit_file_stats`, which says per repository which files and directories the emitted commit rows changed most. The shape, the coverage fields, the `top_files` / `top_dirs` bounds and the commit-row rules are in [Commit File Stats](contract-activities-reference.md#commit-file-stats).

## Activity Daily

Version `4.0.0` added the optional top-level `activity_daily` aggregate: pre-computed per-day / per-kind activity counts spanning the **full** canonical activity history, because `4.0.0` windows the static `activities[]` to 30 days. The static contract buckets the full history, `/api/range` buckets only its in-range `activities[]`, and `GET /api/activity-daily` returns the full-history aggregate on its own. Fields and route behavior: [Activity Daily](contract-activities-reference.md#activity-daily).

## Graph Neighborhood Query (operational, not contract)

`GET /api/graph-neighborhood?ref=<item-ref>&depth=<1..5>&mentions=<direct|all>&scope=<neighborhood|program>` is the focused Graph
view's canonical-history read. It is intentionally separate from
`ContractEnvelope`: range and static envelopes stay bounded for normal pages,
while a user can follow older relations wholly outside the loaded item window.
It therefore has its own operational schema,
`symphony-board-graph-neighborhood/1`, and does not carry or bump
`contract_version`.

The endpoint defaults to one hop and `mentions=all` for existing callers. The UI
requests `mentions=all` so depth expands through mentions. It returns current
live configured-repo data:

- `focus_ref`, `requested_depth`, and `reached_depth`;
- `nodes[]` with `ref`, shortest `hop`, and the resolved `ItemDTO` when tracked;
- original directed `edges[]` for the induced neighborhood. All edges expand
  through the requested depth in `all` mode; in `direct` mode, mentions incident
  to the focus are hop-one leaves and do not expand;
- `complete`, ordered `limit_reasons` (`depth`, `nodes`, `edges`), fixed limits,
  and returned node/edge counts.

Traversal treats edges as undirected only for neighborhood membership, retains
their original direction in the response, and uses stable ordering so cycles
and repeated reads are deterministic. The production bounds are depth 5, 200
nodes, and 500 edges. Invalid/missing query parameters return `400`; an unknown
focus returns `404`. Every request opens the configured canonical store
read-only and closes it. Static/local-file clients cannot use this route and
must clearly label their loaded one-hop fallback.

`scope=program` (default `neighborhood`) returns a program tracker's program in
the same response shape and under the same schema tag, so it adds a parameter
and no field. It uses neither `depth` nor `mentions`, but both are still
validated when present: `scope=program&depth=9` is `400`. The response holds:

- the focus at hop 0 and its children — the targets of its `parent` edges — at
  hop 1, with those `parent` edges;
- every `blocks` edge into a child. The prerequisite is usually another child;
  one outside the program is returned at hop 2, because it still decides
  whether the child is blocked;
- every `closes` edge into a child, with its change request at hop 2.

It is a fixed two-hop projection: `requested_depth` is always `2`, which is how
a client tells it from the answer of a server that does not know the parameter
and returned an ordinary one-hop neighborhood. That check is reliable only when
the caller omits `depth`: a server that ignores `scope` answers
`scope=program&depth=2` with an ordinary two-hop neighborhood, which also
reports `requested_depth: 2`. Mentions, relations, and the
edges a child has out of the program are not part of it. An item without
`parent` out-edges is returned alone (`200`, one node, no edges); an unknown
focus is still `404`, and any other `scope` value is `400`.

The 200-node / 500-edge bounds hold, and structure wins under them: children
beyond the node bound are cut in ref order (`limit_reasons` gains `nodes`), then
edges are kept as `parent`, `blocks` among children, `closes`, outside blockers
(`edges`). An item past the children is returned only with an edge that reaches
it. The read takes at most 2,000 edge rows per step (the tracker's, then its
children's) before it keeps the program edge types, so mentions on a program's
children cannot crowd out its structure; a step that hits that bound also
reports `edges`. A static/local-file client
derives the same scope from its loaded edges.

## Aggregates

Version `1.3.0` added optional `aggregates[]`. These rows provide
server-computed totals for named scopes and windows. In v2 they are the
authoritative way to read full totals because `items[]` and `edges[]` are
windowed.

Scopes use the same vocabulary as the UI:

| Scope | Meaning |
| --- | --- |
| `global` | full canonical live totals for all items and edges |
| `boardWindow` | Board item-window totals; items are selected by `updated_at` |
| `graphWindow` | Graph overview totals; edges are selected by endpoint activity, and item total means rendered graph nodes |
| `focus` | focus-local subgraph totals; schema-supported but not backend-emitted because focus target is viewer-local |

Each aggregate has:

- `scope`: one of the scope values above.
- `window.kind`: `full`, `active_since`, or `focus`.
- `window.basis`: the selection rule, such as `item_updated_at` for Board or
  `edge_endpoint_updated_at` for Graph.
- `window.since`: inclusive UTC cutoff for `active_since`, otherwise `null`.
- `window.days`: preset length used to derive `since` from `generated_at`, or
  `null` for full/custom rows.
- `window.edge_filter`: `no_mentions`, `all`, or `null` when no edge filter
  applies.
- `stats`: total plus open string-keyed count maps:
  `by_state`, `by_kind`, and `by_lifecycle`.

The backend currently emits aggregates over the full canonical live set before
v2 payload windowing:

- `global` full aggregate over all canonical live items and edges.
- `boardWindow` full plus `1w`, `2w`, `1mo`, and `3mo` active-since aggregates.
- `graphWindow` full plus `1w`, `2w`, `1mo`, and `3mo` active-since aggregates
  for the default overview edge filter (`edge_filter: "no_mentions"`).

Viewer-local choices are not represented by backend aggregates. Source/repo
visibility, search, facet filters, Graph relation type toggles, and focus targets are
client display state; consumers should use a contract aggregate only when its
scope/window/filter exactly matches the view. Local fallback computation from
`items[]` and `edges[]` is only complete for windows inside `item_window`.

## Item Window

Version `2.0.0` added required `item_window` metadata and changed the payload to
ship a bounded item set instead of every live item.

The backend currently emits:

- primary scope: `boardWindow`
- basis: `item_updated_at`
- preset: 90 days relative to `generated_at`
- included rows: every item in that primary window, plus tracked endpoints of
  every emitted relationship edge, plus the pinned program trackers (below)

Fields:

- `scope`: currently `boardWindow`.
- `window`: the same window descriptor shape used by aggregate rows.
- `primary_items`: number of loaded rows that belong to the primary window.
- `edge_endpoint_items`: number of loaded rows outside the primary window that
  exist to resolve emitted edge endpoints.
- `activity_target_items`: optional number of loaded rows outside the primary
  window that exist to resolve emitted review activity targets or (4.8.2+) the
  change requests emitted commit rows name. When a row has
  both `edge_endpoint` and `activity_target`, the counts are per reason.
- `total_items`: full live canonical item count before windowing.
- `truncated`: true when at least one live item row is omitted from `items[]`.

Consumers should treat `items[]` as complete only for the primary window.
Choosing a different Board, Graph, Activity, or Commits date range requires
another payload such as `/api/range`; the static v2 contract cannot synthesize
missing historical cards or events. Consumers can still show true full totals
from `aggregates[]`.

Version `4.8.0` added the program tracker pin, in the static contract and in
`/api/range` alike. A pinned tracker is an item that meets all three
conditions:

- its `state` is `open`;
- it carries the label `workflow::tracking` (exact name);
- it has at least one live outgoing `parent` edge.

The label is part of the rule, not a display convention. A `parent` edge comes
from a phase table, which is issue text that anyone who can open an issue in a
tracked repository controls, and the pin puts rows into every window and every
range response. Only a triager can set a label, so an issue author cannot
select what is pinned. An open issue with a phase table and no label still
reports its `parent` / `blocks` edges (see Edges); it is simply not pinned.

One projection pins at most 100 trackers: the 100 with the newest `updated_at`,
ties broken by ascending `id`. The cap is a guard on payload size, not an
expected limit; a tracker beyond it is emitted only under the ordinary window
rules.

A pinned tracker is always emitted, whatever the window or range:

- its row carries `program_tracker` in `window_reasons`, in addition to any
  other reason. Outside the window it has no `primary` reason, so it is not a
  primary Board item; being an edge endpoint it also carries `edge_endpoint`
  and counts in `edge_endpoint_items`.
- its `parent` edges, and the `blocks` edges whose two endpoints are both
  children of pinned trackers, are emitted with it. The children therefore
  arrive as `edge_endpoint` rows, exactly as they do for a tracker inside the
  window; a child that is a change request brings its `review_threads[]` rows
  like any other emitted change request.
- nothing else is pinned: a closed tracker appears only when the window selects
  it, and a `closes` edge into a child is emitted only under the ordinary
  window rules. A consumer deriving "a change request is open for this child"
  sees only the change requests the window loaded.
- `primary_items`, `aggregates[]`, `repo_stats[]`, and `repo_metrics[]` are
  unchanged by the pin: they are computed from the window or the full live set,
  never from the emitted support rows.

This is a **minor** bump: a new value on an existing array field, no field
added or removed. A consumer that only tests for `primary` keeps working and
simply does not list the pinned trackers. Consumers that branch on
`window_reasons` should ignore an unrecognized value rather than rejecting the
row or the payload.

## Range Query

Version `2.1.0` added optional `range_query` metadata for read-only API
responses. The static `emit` path usually omits it. `GET /api/range` returns the
same contract envelope shape, with `range_query` set to:

- `kind: "time_range"`
- `timezone`: the configured IANA zone (`"UTC"` when unset; equals the
  envelope-level `timezone`). Relaxed from the `"UTC"` literal in `3.1.0`.
- `from`: inclusive timestamp for the selected date's start, expanded at this
  zone's day boundary
- `to`: inclusive timestamp for the selected date's end, expanded at this zone's
  day boundary

Version `4.11.0` added an opt-in `view` query parameter. Omitted, the response
is the complete range shape described below, byte-for-byte what earlier
clients receive. `GET /api/range?from=…&to=…&view=commits` returns the same
envelope with a slimmer projection and `range_query.view: "commits"`:

- `activities[]` keeps only `kind: "commit"` rows.
- `items[]` keeps only the items those commit rows name in
  `details.change_request.ref`, without `body`; `item_window` and each item's
  `window_reasons` still describe the complete range projection.
- `edges[]` and `review_threads[]` are empty.
- Everything computed over the range (`activity_daily`, `actor_directory`,
  `commit_file_stats`, `repo_metrics[]`, `repo_stats[]`, `aggregates[]`) is
  derived from the complete in-range rows, so it reconciles with the default
  shape.

An unknown `view` value is a `400`. The Commits page requests this view because
the other activity kinds, items, and review threads dominate a long range's
payload and the page never reads them; a page that needs the complete shape
requests it without `view`.

The range response is a projection, not a second schema:

- primary Board items are selected by `items[].updated_at` inside
  `[from, to]`.
- edges are included when they touch a primary item or when a tracked endpoint
  was updated inside the range, so Graph can use the same selected range.
- tracked edge endpoints are included in `items[]` with
  `window_reasons: ["edge_endpoint"]` when they are outside the primary item
  set.
- pinned program trackers — open, labeled `workflow::tracking`, with a
  `parent` edge, at most 100 — are included whatever the range, with
  `program_tracker` in `window_reasons`, their `parent` edges, and the `blocks`
  edges whose two endpoints are both children of pinned trackers (4.8.0+; see
  Item Window).
- in-range review activity targets are included in `items[]` with
  `window_reasons: ["activity_target"]` when they are outside the primary item
  set, so unresolved-review filters can read the target change request's current
  `review_threads` summary without treating the row as an edge endpoint.
- the change requests in-range commit rows name in `details.change_request`
  (4.8.2+) are included the same way, so a consumer can show the change request
  a commit belongs to.
- the item any other in-range row names in `target_ref` (4.9.1+) is included
  the same way: a comment's issue or change request, or the item an
  `opened` / `closed` / `merged` row is about.
- `activities[]` is filtered by `occurred_at` inside `[from, to]`.
- `aggregates[]` is populated in range responses from the full live item/edge
  set (the same computation the static contract uses), so a windowed board keeps
  working stat bars; consumers may still compute scoped visible stats locally.
- `activity_daily` is populated in range responses, bucketing the in-range
  `activities[]` above (see Activity Daily).
- `repo_stats[]` remains the full canonical repo inventory (over configured
  repos; see Config-Gated Projection), not only loaded range rows.

The API validates the date query and opens SQLite read-only; it is not a writer
and does not mutate sync state.

## Timezone

Version `3.1.0` added the optional top-level `timezone` field and relaxed
`range_query.timezone` from the `"UTC"` literal to any string. The producer
reads `timezone` from config (`config/sources.json`); it defaults to `"UTC"`
when unset and accepts any IANA zone name (e.g. `"Asia/Taipei"`).

This is the zone the calendar-day boundaries are bucketed in:

- the UI's `today` / `this week` presets and the activity-heatmap day cells use
  it instead of UTC, so a viewer's local late-night activity lands in the
  expected day;
- `GET /api/range` expands the `from` / `to` date query at this zone's day
  boundaries (00:00 / 23:59:59.999 local), so server-side windowing matches the
  zoned preset the UI computed;
- `repo_metrics[].series` buckets align to this zone's calendar days (added in
  `3.1.1`): a `day`/`week`/`month` bucket starts at a local midnight, and the
  sub-day `2h`/`4h`/`6h` widths (added in `3.5.0`) start at the zone's local
  even-hour boundaries (00:00, 02:00, …), so intraday buckets follow the viewer's
  clock rather than straddling UTC hours.

`3.1.0` is a **minor** bump: `timezone` is a new optional top-level field old
consumers ignore, and the `range_query.timezone` relaxation breaks no consumer
(none constrains the value). A consumer reading a pre-`3.1.0` contract reads a
missing `timezone` as `"UTC"`. `3.1.1` is a **patch**: it only re-aligns the
`repo_metrics[].series` bucket boundaries to the already-declared `timezone`;
the shape is unchanged and the default-UTC bucketing is identical to before.
Absolute-instant fields (`generated_at`, `updated_at`, `occurred_at`, …) stay
UTC ISO-8601; only calendar-day bucketing honors the zone.

## Repo Stats

Version `2.0.0` added required `repo_stats[]` because Settings repo inventory
cannot be derived from a windowed item payload.

Each row is keyed by `(source_id, project_path)` and contains:

- `items`: full live item count for that repo.
- `by_state`: full item counts by normalized state.
- `by_kind`: full item counts by kind.

"Full" here means un-windowed (every live item, not just the board window), not
un-filtered: as of `4.2.1` `repo_stats[]` is the full live count over the
**configured** repos only (see Config-Gated Projection).

## Config-Gated Projection

Version `4.2.1` makes config the source of truth for *what the contract
surfaces*. The producer hands the builder the configured
`(source_id, project_path)` set from `config/sources.json`; any source, repo,
item, edge, or activity that config no longer declares is omitted from every
contract surface — `sources[]`, `repo_stats[]`, `repo_metrics[]`, `items[]`,
`edges[]`, and `activities[]` — on the static contract, `GET /api/range`, and
the review-candidates discovery surface.

This is a producer behavior change, not a schema change (no field is added,
removed, or repurposed), hence a **patch** bump like `3.1.1`: the shape is
identical and a consumer that reads the same envelope keeps working — it simply
sees fewer rows when config is narrowed. Two properties follow:

- It is computed at emit time and never persisted (like colors / identities).
  The canonical store keeps every row of a removed source/repo, so re-adding it
  to config makes its already-synced history reappear with no re-sync — there is
  still no purge (see DESIGN.md "Removal semantics").
- A disabled source (`"enabled": false`) stays declared in config and therefore
  keeps appearing; only ABSENCE from config hides a source or repo.

## Repo Metrics

Version `2.2.0` added optional `repo_metrics[]` for the Repo Analytics page and external consumers that need per-repo trends. Each row is keyed by `(source_id, project_path)` like `repo_stats[]`, but it is scoped to one time window and must not be used as full inventory; `repo_stats[]` is the full inventory over the configured repos (see Config-Gated Projection). A row carries `repo_url`, `window`, `totals`, `series[]`, `top_actors[]` and `data_quality`. Their definitions, the actor identity rules and the version notes are in the [Repo Metrics reference](contract-repo-metrics-reference.md#repo-metrics).

## Display Metadata

Version `1.1.0` added display colors:

- `sources[].color`: optional source-level highlight color or `null`.
- `repos[]`: sparse per-repo highlight colors keyed by
  `(source_id, project_path)`.

Colors are config-derived display metadata:

- accepted forms are `#rgb` and `#rrggbb`
- read by `emit` from `config/sources.json`
- not stored in SQLite
- safe to change by re-emitting the contract; no provider re-fetch is required

The UI resolves colors in this order:

```text
browser repo override -> repos[] color -> sources[].color -> no highlight
```

The UI validates colors again before using them in CSS.

Version `1.2.0` added optional top-level `activities[]`.

Version `2.2.1` is a clarification + producer-behavior patch: the producer now
ingests review activity (`kind: "review"`) from GitHub PR reviews and GitLab MR
approvers, and the `reviews` / `approvals` repo metrics are documented as
activity-event counts (see Activities and Repo Metrics). The shape is unchanged
— `review` is existing open `kind` vocabulary and `reviews` / `approvals` are
existing integer fields — so v2 consumers need no change.

## Sync Checkpoints

Version `4.10.0` adds optional `sync_run` to contracts emitted by the sync
runner. Each source leg publishes after its committed work; the last leg uses
the final run emit. A failed leg does not block committed data from another
source. A dry-run, refused writer lease, or all-failed run emits nothing.
Standalone `emit` and read-only range projections omit `sync_run`: absence
means current-run completeness is unknown, not that a full sync completed.

```json
{
  "mode": "full",
  "source_scope": null,
  "status": "running",
  "sources": [
    { "source_id": "github:github.com", "status": "ok" },
    { "source_id": "gitlab:gitlab.example", "status": "pending" }
  ]
}
```

`mode` is `full` or `incremental`. `source_scope` is null for an all-source
run, or the selected source id for a scoped run. The rows cover every source
selected for that run, including sources not yet present in the store.
Per-source `status` is `pending` until its leg commits, `ok` when complete,
`partial` when some fetch work is incomplete, `error` when the leg fails, or
`skipped` when disabled or without credentials. Unfinished legs retain their
previous stored data when available; pending never proves freshness.

The top-level run `status` is `running` at intermediate checkpoints, then the
worst completed outcome (`error` > `partial` > `ok`; skipped is neutral) at the
final checkpoint. A consumer requiring a completed full all-source sync must
require `mode: full`, `source_scope: null`, run `status: ok`, and every expected
source row present with `status: ok`. A gate for one source may accept that
source's `ok` full-leg checkpoint while siblings remain pending or fail.
Skipped sources do not prove coverage even when the run status is `ok`.

`sources[].last_status` and `last_success_at` remain historical stored health,
unchanged in meaning: they may describe an earlier run while `sync_run` says
pending. `generated_at` and file freshness indicate successful publication,
not full all-source completion. The container health signal uses the emitted
file's modification time, so each successful checkpoint refreshes it.

## Version Rules

- **patch** (`1.3.x`): clarification only; no shape or semantic change.
- **minor** (`1.x.0`): additive only. A new top-level field must be optional
  and/or nullable. A new field added to an **optional or newly-added** object
  MAY be `required` in the schema when the producer always emits it: old
  consumers never depend on that object and ignore unknown fields, so the
  tightening only guards the producer (e.g. `2.3.0` added `actor_key` /
  `display_name` to the optional `top_actors[]` rows). Old consumers must keep
  working.
- **major** (`x.0.0`): breaking shape or semantic change, including removed
  fields, renamed fields, repurposed fields, or tightening the required set of
  an object that existing consumers already depend on.

Hard rules:

1. Do not remove or repurpose a field within a major.
2. Consumers must ignore unknown fields within a supported major.
3. Producers validate strictly against the JSON Schema before emitting.

## Changing The Contract

1. Edit `packages/contract/contract.schema.json`.
2. Edit `packages/contract/types.ts` in the same commit.
3. Bump `CONTRACT_VERSION` in `src/contract/version.ts`.
4. Update `test/contract.test.ts`.
5. Update `test/validate.test.ts` if the schema uses a new validator feature.
6. Update UI model/loading behavior when the UI consumes the new field.
7. Run:

```sh
pnpm run typecheck
pnpm test
pnpm --filter @symphony-board/ui run build
pnpm --filter @symphony-board/ui run test
pnpm --filter @symphony-board/ui run smoke
pnpm run emit --out data/contract.json
pnpm run validate --in data/contract.json
```

For a major bump, plan a transition. The UI currently supports contract major
v4 and warns on any other major.

## Validation

`emit` validates the envelope before writing. It refuses to emit invalid JSON:

```sh
pnpm run emit --out data/contract.json
```

Validate an existing file:

```sh
pnpm run validate --in data/contract.json
```

`--no-validate` exists on `emit` as an emergency escape hatch for a validator
bug. It should not be used as a normal workflow.
