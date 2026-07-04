# Contract Versioning

The contract is LAYER 3: the serialized projection consumed by the UI and any
external reader. It is not the SQLite schema and not the stored truth. It is
derived from raw/canonical data whenever `emit` runs.

Definition files:

- `packages/contract/contract.schema.json`: normative JSON Schema
- `packages/contract/types.ts`: TypeScript DTO mirror
- `src/contract/version.ts`: `CONTRACT_VERSION` and `GENERATOR`
- `src/contract/validate.ts`: dependency-free producer validator

Current emitted version: `4.6.0`.

The private workspace package version in `packages/contract/package.json` is
package metadata. Consumers must use the envelope's `contract_version`, not the
package version, to decide compatibility.

## Envelope

```jsonc
{
  "contract_version": "4.6.0",
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
- `items`: windowed normalized work items in contract v2.
- `edges`: typed relationships whose endpoints are resolved by the v2 item
  window whenever the endpoint belongs to a tracked item.
- `activities`: optional developer-significant event feed, added in `1.2.0`. As
  of `4.0.0` the static contract windows it to the last 30 days (see Activities).
- `activity_daily`: optional pre-computed per-day/per-kind activity counts, added
  in `4.0.0` (see Activity Daily). Emitted by both the static contract (over the
  full canonical history) and `/api/range` (over the in-range activities).
- `repos`: optional sparse per-repo display metadata, added in `1.1.0`.
- `aggregates`: optional scope/windowed totals, added in `1.3.0`.
- `item_window`: required v2 metadata describing the primary loaded item window.
- `repo_stats`: required v2 full repo counts, independent of loaded item rows.
- `repo_metrics`: optional window-scoped repo analytics rows, added in `2.2.0`.
- `range_query`: optional metadata on read-only range API responses, added in
  `2.1.0`.

The producer currently emits `activities`, `repos`, `aggregates`,
`item_window`, `repo_stats`, and `repo_metrics` every time, usually as empty
arrays when no rows apply. Consumers should still read older optional fields
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
  activity's target change request and current review-thread state. Missing
  means "primary" when reading old v1 payloads.

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

Edge type is an open string so providers can add relationship vocabulary without
changing the major version when the shape stays the same.

In contract v2, `edges[]` is emitted for relationships touching the primary item
window. The producer also includes tracked endpoint item rows for those edges so
the UI graph can resolve nodes instead of treating known items as untracked
refs. Relationships wholly outside the primary window are omitted from the
payload, while their full lifecycle counts remain available through
`aggregates[]`.

## Activities

`activities[]` is a newest-first feed of developer-significant records. It is
separate from `items[]`: an item is current state, while an activity row is
something that happened.

Important fields (note: `4.0.0` dropped the activity `id` and `summary` — see
below):

- `source_id` / `external_id`: stable source identity for the record. The
  composite ref `source_id|external_id` is the row's identity (the dropped `id`).
- `kind`: open string such as `issue`, `change_request`, `commit`, `branch`,
  `tag`, `repository`, or `review`.
- `action`: open string such as `opened`, `closed`, `merged`, `committed`,
  `pushed`, `force_pushed`, `created`, `deleted`, `approved`,
  `changes_requested`, or `reviewed`.
- `project_path`: mutable repo/project display path, when known.
- `target_kind`, `target_ref`, `target_iid`: optional target metadata. Only set
  `target_ref` when the producer can identify the tracked item by provider
  immutable id.
- `occurred_at`: provider event timestamp.
- `url`: optional primary provider link for the activity row. Current producers
  fill it only when the target is reliable: issue / change-request pages,
  commit pages, repository pages, branch/tag ref pages, or push compare /
  fallback commit destinations.
- `details`: provider-specific JSON object for debugging and later consumers.
  Commit rows may include `details.sha`, subject `details.message`, optional
  `details.body`, and optional `details.branch` / `details.ref` carrying the
  commit's primary branch (the default branch whenever the commit is on it). A
  commit reachable from more than one branch also carries the full membership
  as `details.branches` / `details.refs` (default branch first, side branches
  alphabetical).

Current sources derive item transition activities from canonical item timestamps
and fetch provider REST activity surfaces for comments, commits, and
repository/project events. The commit feed covers the default branch plus live
side branches: push events discover branches with new activity, each contributes
its branch-unique commits (a compare against the default branch), and the feeds
merge per sha into a single activity row.

Version `3.2.1` is a clarification release for the above: producers now fill
the previously reserved `details.branches` / `details.refs` membership lists,
and `details.branch` / `details.ref` are documented as the commit's primary
branch rather than always the default branch. `details` was already an open
object and the keys were already optional, so the row shape is unchanged.

Version `3.3.0` is additive: a new optional `item.review_threads`
(`{ open, total }` resolvable review threads for a `change_request`, else null)
and an optional `unresolved_review_threads` repo metric. Both are new fields old
consumers can ignore — no existing field changed — so the major stays `3`.

There is no separate `target_url` field. Consumers should use `activities[].url`
as the row's provider destination and treat `null` as intentionally unlinked.
GitHub comments link to their stable provider `html_url` anchors. GitLab
comments currently stay unlinked because their stable per-comment anchors are
not normalized. Push events link to a compare page when both endpoint SHAs are
usable; new refs link to the ref page and deleted refs link to the last known
commit when available.

Review activity (`kind: "review"`) is derived per provider and feeds the
`reviews` / `approvals` repo metrics (see Repo Metrics):

- GitHub: every submitted pull request review becomes one `review` activity,
  dated by the review's `submittedAt`. `action` reflects the review verdict:
  `approved`, `changes_requested`, `reviewed` (a plain review comment), or
  `dismissed`. Unsubmitted (`PENDING`) reviews are skipped.
- GitLab: GraphQL exposes no per-review event with a timestamp, so each current
  merge request approver (`MergeRequest.approvedBy`) becomes one
  `review` / `approved` activity, dated by the merge request's `merged_at` when
  merged, else its `updated_at`. This is an approximate event time, not a true
  per-approval timestamp. GitLab has no "changes requested" / "commented" review
  enum, so a GitLab `review` activity is always an `approved` one. We count
  `approvedBy` (the real approvers), **not** the `approved` boolean: a merge
  request with no approval rule reports `approved: true` with an empty
  `approvedBy`, so it contributes zero approvals — a trustworthy zero rather
  than a vacuous approval. (The `approved` boolean still drives the per-item
  `review_state` / `by_review_state`, which is a current-state signal, not an
  event count.)

Review threads (`item.review_threads`, `change_request` only) are the
"is this review resolved?" signal — a per-item, point-in-time count refreshed
each sync, distinct from the per-event `review` activity above:

- GitHub: `PullRequest.reviewThreads.isResolved`. `total` is the connection's
  `totalCount`; `open` counts unresolved threads in the fetched page (`first:50`,
  which covers every real PR — `open` is a lower bound only for the unseen
  >50-thread case).
- GitLab: `MergeRequest.resolvableDiscussionsCount` (=`total`) minus
  `resolvedDiscussionsCount` (=`open`), exact scalar aggregates with no
  node-walk. GitLab's `review` activity is approval-based, so this is the only
  thread-resolution signal on the GitLab side.

The window-scoped `unresolved_review_threads` repo metric sums `review_threads.open`
across active change_requests (see Repo Metrics).

Top-level `review_threads[]` (4.1.0+) carries current provider review-thread
detail rows for loaded change requests. This is the Review tab's thread inbox,
not a review-event feed. Each row is keyed by provider thread id, points back to
the owning change request via `target_ref`, includes current resolution/outdated
state, file/line metadata when the provider reports it, and a compact
`comments[]` preview. `comments_total` may be larger than `comments.length`
because producers cap the preview payload to the OLDEST comments — so for a long
thread the newest comment is absent from `comments[]`. `last_comment_at` (4.3.0+)
carries the thread's true newest-comment instant independent of that preview, so
recency consumers sort by it instead of scanning the (possibly stale) preview.

- GitHub: `PullRequest.reviewThreads` nodes supply `isResolved`, `isOutdated`,
  path/line metadata, `resolvedBy`, and the first review-thread comments.
- GitLab: the MR Discussions REST API supplies resolvable discussion notes,
  their `resolved` state, position metadata, and note bodies. Non-resolvable MR
  comments are not emitted as review threads.

The top-level detail list is filtered to the same loaded item projection as
`items[]`: the static contract includes threads for its item window, while
`GET /api/range` includes threads for that range projection.

Version `4.1.0` is additive: a new optional top-level `review_threads[]` detail
list for current provider review threads. The existing item-level
`review_threads {open,total}` summary and repo metric semantics are unchanged,
so old consumers can ignore the new list.

Version `4.2.0` is additive: each `review_threads[].comments[]` entry now carries
an `avatar_url` — the comment author's avatar URL when the provider reports it,
else `null`. The producer always emits the key, but the schema keeps it
**optional**-and-nullable (not in the comment object's `required` set), like any
additive minor-version field: a `4.1.0`-emitted contract whose comments predate
the key must still validate against the `4.2.0` schema. GitHub supplies it from the review comment `author.avatarUrl`
GraphQL field; GitLab from the discussion note `author.avatar_url`, resolved to an
absolute URL against the source host for self-hosted instances. It is persisted
inside the canonical `comments_json` blob (no schema migration), and the Reviews
UI renders it as the comment author's photo, falling back to initials.

Version `4.5.0` is additive: `items[]` rows may carry optional, nullable
`body`, the provider issue / PR / MR description text. GitHub supplies it from
the Issue/PullRequest GraphQL `body` field; GitLab supplies it from
Issue/MergeRequest `description`. It is persisted on an additive nullable
`item.body` column in every store driver and lets detail-oriented UI surfaces
show the provider body without jumping out to the provider page. The canonical
copy is bounded for payload and sync-write safety; when a source body exceeds
the cap, the producer appends a visible truncation marker and the provider URL
remains the full-text destination. Old payloads without the field remain valid;
consumers read it as `item.body ?? null`.

Version `4.6.0` is additive: `items[]` rows may carry optional, nullable
`comments`, currently shaped as `{ total }`, for the provider's native
discussion comment count. GitHub change requests use the pull request
`totalCommentsCount` field so the number can align with GitHub's PR-list comment
bubble; GitHub issues use the issue `comments.totalCount`; GitLab issues and
merge requests use `userNotesCount`. The field is persisted on an additive
nullable `item.comment_total` column in every store driver. Old payloads without
the field remain valid; consumers read it as `item.comments?.total ?? null`.
This does not replace `demand`, which remains a broader attention signal that
may include reactions/upvotes.

Version `4.4.0` is additive: range projections may include item rows with
`window_reasons: ["activity_target"]` plus optional
`item_window.activity_target_items`. These rows are outside the primary Board
item window and are present only to let an emitted in-range review activity
resolve its target change request's current `review_threads` summary. They are
not emitted edge endpoints; `edge_endpoint` remains reserved for rows needed by
emitted `edges[]`.

Version `4.3.0` is additive: each `review_threads[]` row now carries an optional,
nullable `last_comment_at` — the thread's TRUE newest-comment instant. The
`comments[]` preview holds only the OLDEST `comments_total` rows, so for a thread
with more comments than the preview holds it omits the newest comment; the Reviews
"Recent" sort then fell back to `last_seen_at` (a sync-observation time) and could
bury an actively-updated long thread. GitHub supplies it from a `comments(last:1)`
alias on the review thread; GitLab from the newest discussion-note activity (its
Discussions API already returns every note). It is persisted on its own
`review_thread.last_comment_at` column (an additive migration on both drivers —
the preview blob cannot carry it for a long thread). The producer always emits the
key; the schema keeps it **optional**-and-nullable (not in the row's `required`
set), so a pre-`4.3.0` payload — and a freshly migrated row not yet re-synced —
validates with the key absent or `null`. Consumers read it as
`thread.last_comment_at ?? null`, falling back to the `comments[]` preview, then
`last_seen_at`.

Version `4.0.0` **windows the static contract's `activities[]` to the last 30
days** (anchored to `generated_at`), down from the full ~16-month history. This
is a breaking narrowing of an emitted row collection — the same kind of change as
the `2.0.0` `items[]` windowing — so it is a major bump: a consumer can no longer
read full activity history or trailing-12-month activity stats from `activities[]`.
Two surfaces replace that:

- the new top-level `activity_daily` aggregate (below) for the trailing-12-month
  Activity Overview (heatmap, by-kind totals, busiest day, active days); and
- `GET /api/range`, which is **not** windowed and returns the full requested span
  of `activities[]` for any explicit date range.

`4.0.0` also **removes the activity `id` and `summary` fields**. `id` was always
`source_id|external_id` — a pure duplicate of two existing fields, so a consumer
reconstructs the composite ref when it needs one. `summary` was producer-authored
display prose; the UI already builds its row label from the structured fields
(`target_ref`/`target_iid`, `kind`, `action`, `title`, `details.sha`/`details.ref`),
so the field carried nothing a consumer cannot derive. Removing fields is breaking,
so it rides in this same `4.0.0` major rather than a later one.

## Activity Daily

Version `4.0.0` added the optional top-level `activity_daily` aggregate:
pre-computed per-day / per-kind activity counts spanning the **full** canonical
activity history. It exists so the Activity Overview (the fixed trailing-12-month
heatmap, by-kind totals, busiest day, active days) renders without the raw
`activities[]` feed, which `4.0.0` windows to 30 days.

Both the static `contract.json` and the `/api/range` projection emit it, but with
different scope: `contract.json` buckets the **full** canonical history (its
`total` reconciles with the full canonical count), while `/api/range` buckets the
**in-range** `activities[]` the response carries (its `total` reconciles with that
windowed set), so a windowed mobile board that loads a range response as its
primary env still renders the Activity Overview instead of a blank panel.

Fields:

- `timezone`: the IANA zone the days are bucketed in (equals the envelope
  `timezone`; `"UTC"` when unset).
- `from` / `to`: the earliest and latest covered calendar days as `YYYY-MM-DD`.
  `to` is the `generated_at` calendar day in `timezone`; `from` is the earliest
  day carrying activity (equal to `to` when there is no activity at all).
- `total`: total events across every bucket. It **reconciles with the full
  canonical activity count**, so the Overview numbers are unchanged by the
  raw-activity windowing.
- `by_kind`: aggregate per-`kind` totals across every bucket (open vocabulary;
  equals the sum of `days[].by_kind`).
- `days[]`: ascending by `date`, **sparse** — only days with at least one event
  appear, so a consumer fills gaps with zero. Each bucket carries `date`
  (`YYYY-MM-DD` in `timezone`), `count` (the day's total, equal to the sum of its
  `by_kind`), and `by_kind` (per-`kind` counts for that day).

A consumer aligns its trailing-window rendering to the contract `generated_at`
(via `to`), not the viewer's wall clock, so the buckets and the rendered window
agree.

### `GET /api/activity-daily`

The read-only API surface (the Docker `api` sidecar and the standalone
`app-server`) also serves the **full-history** `activity_daily` on its own:

```
GET /api/activity-daily  ->  { "activity_daily": ActivityDaily | null }
```

It reads the aggregate straight from the daemon-emitted `contract.json` (the same
file `/contract.json` serves), so the returned `activity_daily` always reconciles
with the FULL canonical history, never a window. It exists because a device with a
bounded **Board data** scope loads a `/api/range` projection as its primary
contract, whose embedded `activity_daily` covers only the requested window — which
would shrink the fixed trailing-12-month Activity Overview. The UI fetches this
route to keep the overview a true 12 months without downloading the whole contract;
`activity_daily` is `null` for a pre-`4.0.0` contract, and the route is `404` until
the first emit. It needs no store access (the aggregate is already computed at
emit), so it adds no query, driver, or schema surface.

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
visibility, search, facet filters, Graph mention toggles, and focus targets are
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
  every emitted relationship edge

Fields:

- `scope`: currently `boardWindow`.
- `window`: the same window descriptor shape used by aggregate rows.
- `primary_items`: number of loaded rows that belong to the primary window.
- `edge_endpoint_items`: number of loaded rows outside the primary window that
  exist to resolve emitted edge endpoints.
- `activity_target_items`: optional number of loaded rows outside the primary
  window that exist to resolve emitted review activity targets. When a row has
  both `edge_endpoint` and `activity_target`, the counts are per reason.
- `total_items`: full live canonical item count before windowing.
- `truncated`: true when at least one live item row is omitted from `items[]`.

Consumers should treat `items[]` as complete only for the primary window.
Choosing a different Board, Graph, Activity, or Commits date range requires
another payload such as `/api/range`; the static v2 contract cannot synthesize
missing historical cards or events. Consumers can still show true full totals
from `aggregates[]`.

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

The range response is a projection, not a second schema:

- primary Board items are selected by `items[].updated_at` inside
  `[from, to]`.
- edges are included when they touch a primary item or when a tracked endpoint
  was updated inside the range, so Graph can use the same selected range.
- tracked edge endpoints are included in `items[]` with
  `window_reasons: ["edge_endpoint"]` when they are outside the primary item
  set.
- in-range review activity targets are included in `items[]` with
  `window_reasons: ["activity_target"]` when they are outside the primary item
  set, so unresolved-review filters can read the target change request's current
  `review_threads` summary without treating the row as an edge endpoint.
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

Version `2.2.0` added optional `repo_metrics[]` for the Repo Analytics page and
external consumers that need per-repo trends. Each row is keyed by
`(source_id, project_path)`, matching `repo_stats[]`, but the semantics are
different:

- `repo_stats[]` is full inventory over the canonical live item set of the
  configured repos (see Config-Gated Projection).
- `repo_metrics[]` is scoped to one time window and must not be used as full
  inventory.

Each row contains:

- `repo_url`: optional nullable provider repo URL, added in `3.2.0`. It is
  emitted only for supported GitHub/GitLab source descriptors and valid provider
  project paths. Use it as a display/navigation convenience, not as identity.
- `window`: `active_since` for static emits or `time_range` for `/api/range`,
  always with `basis: "repo_activity"`, inclusive UTC `from` / `to`, and an
  explicit bucket width (`2h`, `4h`, `6h`, `day`, `week`, or `month`; the sub-day
  widths cover 1-3 day windows — see Version `3.5.0`).
- `totals`: selected-window counts for active/opened/closed items, opened /
  closed / merged change requests, activity event categories, activity score,
  edge lifecycle, and open-vocabulary breakdown maps.
- `series[]`: bucketed points using the same stats shape as `totals`.
- `top_actors[]`: bounded actor summaries. This is an aggregate list, not an
  unbounded user directory. See "Actor identity" below.
- `data_quality`: whether activity rows exist for the repo
  (`activity_available`), the earliest (`observed_since`) and latest
  (`last_activity_at`) observed activity timestamps, and notes for provider or
  coverage gaps. Both timestamps are the repo's all-time bounds (computed across
  every activity row, not just the window), so they can sit outside `window`;
  both are `null` when no activity row carries a parseable instant. The UI
  derives the Repo Analytics coverage badge from these against the window — see
  the `3.0.0` note below.

### Actor identity

`top_actors[]` groups by a canonical actor identity, not by raw display string,
so one human collapses to one row instead of duplicating across a provider
username (issues/PRs/MRs) and several commit author names (commits). Added in
`2.3.0`, each actor row carries:

- `actor_key`: the stable identity the row is grouped on. It is scheme-prefixed
  and **never contains a raw email**:
  - `provider-user:<source_id>:<username>` when the record carries a provider
    username (issue/PR/MR authors, pushes, and account-linked commits).
  - `email:<hash>` when only a commit email is available (account-less git
    authorship); the address is hashed, so it groups records that share an
    address without exposing the address.
  - `name:<normalized>` as a final fallback.
  - `person:<slug>` when a producer-side config identity map merged several of
    the above into one declared human (see below). Treat `actor_key` as an
    opaque, open-vocabulary string — match it, do not parse it.
  Username wins over email so a person's account-linked commits join their
  issues/PRs instead of splitting into a separate email-keyed row. Two records
  that share neither a username nor an email stay separate even when their
  display name matches — except where a config identity explicitly joins them.
- `display_name`: the deterministically chosen name for the identity — the
  config identity's declared name when one applies, otherwise the most frequently
  observed raw name, tie-broken case-insensitively then by code unit.
- `aliases`: the other distinct display names observed for the identity, sorted;
  omitted when there is only one.
- `actor`: a backward-compatibility display field equal to `display_name`, kept
  so pre-`2.3.0` consumers keep rendering. Render `display_name` and key React
  lists on `actor_key`.
- `profile_url`: the actor's canonical provider profile page, added in `3.4.0`.
  It is usually `https://<host>/<username>` on a supported GitHub/GitLab source;
  GitHub App bots may use the provider-reported `https://<host>/apps/<slug>` URL.
  It is emitted for a `provider-user:<source_id>:<username>` identity, and for a
  config-merged `person:<slug>` identity via the provider username **observed on
  this source** (a `person` row is per-source, so the absorbed provider-user
  sub-identity supplies it). It is **omitted** when no username was observed on
  this source — `email:<hash>` / `name:<normalized>` authorship — and for
  unsupported sources. A config identity's declared usernames are host-agnostic,
  so they are never guessed onto a source (that could link a wrong-host profile).
  Like `repo_url`, treat it as a display/navigation convenience, not identity.

An optional producer-side **config identity map** (`identities[]` in
`config/sources.json`) can declare that several of the keys above are one human —
the cross-facet case the automatic key can't bridge, such as a GitLab person
whose issues carry a username while their commits carry only an email. Matching
identities collapse into one `person:<slug>` row named by the config, with the
other observed names as `aliases`. This is producer/display config (read at emit
time, never stored, never exposing raw email); it changes which `actor_key`
values appear but not the contract shape, so it is not a version change. Identity
entries are global unless they include `source_ids[]`; a scoped entry only
matches actors while building repo metrics for those provider source ids. Scope
broad name aliases when the same commit display name may appear on another host
for a different account.

`top_actors[]` also omits CI/dependency **bots** as noise. The producer
auto-drops the unambiguous markers — a GitHub `[bot]` login suffix and GitLab
service-account usernames (`project_`/`group_<id>_bot_…`) — and an optional
config `exclude_actors[]` list drops unmarked ones (e.g. `dependabot`,
`github-code-quality`) by username or display-name match. Excluded actors are
hidden only from this bounded list; their activity still counts in `totals` and
`series`. Like the identity map, this is producer/display config and not a
contract shape or version change.

The producer currently derives repo metrics from canonical item, label, edge,
and activity rows. That means item lifecycle metrics are available even when a
provider has no activity rows, while commit/push/comment/review metrics depend
on the activity fetch surfaces and their retention/coverage. Consumers should
show `data_quality` rather than treating missing activity as true zero activity.

`reviews` and `approvals` are activity-event counts, defined as:

- `reviews`: number of `review` activity events in the window (see Activities).
  On GitHub this counts every submitted PR review (approve / changes-requested /
  comment); on GitLab it counts current MR approvers (GitLab exposes no other
  review event). It is **not** the count of items currently carrying a
  `review_state` — that is `by_review_state`.
- `approvals`: the subset of those events whose `action` is `approved`. On
  GitLab every review event is an approval, so `approvals == reviews`; on GitHub
  `approvals <= reviews`.

Because GitHub and GitLab expose different review surfaces, treat `reviews` as
"available review signal per provider" and `approvals` as the cross-provider
comparable subset. A repo with `data_quality.activity_available: true` and
`reviews: 0` genuinely had no review activity in the window.

Version `3.0.0` **removed** `data_quality.truncated` from each repo metric row.
It was always `false`: repo metrics are derived from the full canonical item /
edge / activity store, never from the windowed `items[]` payload, so a per-repo
metric row is never truncated. The genuine truncation signal lives at the
top-level `item_window.truncated`. No replacement field is added — the producer
keeps emitting `activity_available`, `observed_since`, and `last_activity_at`,
and the Repo Analytics "Quality" badge now derives a coverage verdict from them
against the metric's window (no producer-side enum): `no activity` when
`activity_available` is false; `idle` when `last_activity_at` predates the
window (real dormancy, not a data gap); `partial` when `observed_since` falls
inside the window (earlier counts are missing, not zero); otherwise `active`.
This is a major bump because removing a field is breaking per the rules below.

Version `3.5.0` added sub-day `repo_metrics[].window.bucket` widths (`2h`, `4h`,
`6h`) for short windows. A 1-, 2-, or 3-day range now tiles its `series[]` into
12 fixed-width points (12 × 2h / 4h / 6h) aligned to the zone's local clock,
instead of collapsing into 1-3 flat buckets, so the Repo Analytics TREND
sparkline shows an intraday shape (the UI caps the sparkline at 16 bars, so 12
fits without truncation). Windows of 4+ days are unchanged (`day`/`week`/`month`).
It is additive within contract major v3 — a new enum member on the existing
`bucket` field; the `series[]` shape is unchanged. Consumers that branch on
`bucket` should treat an unrecognized width as an opaque series point rather than
rejecting it.

Version `3.2.0` added optional nullable `repo_metrics[].repo_url` so consumers can
link a Repo Analytics row back to its provider repository without reconstructing
provider URL rules. It is additive within contract major v3. The row key remains
`(source_id, project_path)`, and `repo_url` may be `null` when the source kind,
host, or path cannot produce a safe provider URL.

Version `3.4.0` added optional `repo_metrics[].top_actors[].profile_url`, the
per-actor counterpart to `repo_url`: the actor's canonical provider profile page
(usually `https://<host>/<username>`, or a provider-reported GitHub App bot URL
such as `https://<host>/apps/<slug>`) so consumers can link a handle to its
GitHub/GitLab profile without reconstructing provider URL rules. It is additive
within contract major v3 and follows the same omit-when-absent rule as the
sibling `aliases` field. It is present for a
`provider-user:<source_id>:<username>` identity and for a config-merged
`person:<slug>` identity via the provider username observed
on this source; it is omitted for email/name authorship with no observed
username and for unsupported sources. See "Actor identity" above.

Version `2.5.0` added `data_quality.last_activity_at` to each repo metric row —
the most recent observed activity instant (max `occurred_at`), the counterpart to
the existing earliest `observed_since`. The producer always emits it (`null` when
no activity row has a parseable timestamp); the Repo Analytics page renders it as
"last active" instead of the earliest-observed instant.

Version `2.4.0` added optional `activity_score` to the repo metric stats shape.
The current producer emits it for every repo metric totals row and series point
as an **unweighted sum** of the in-window event counts:

```text
activity_score =
  commits +
  issues_opened +
  change_requests_opened +
  change_requests_merged +
  comments +
  reviews +
  approvals
```

`issues_opened` is `max(0, items_opened - change_requests_opened)` so a PR/MR is
not also counted as an issue. `items_active` and `pushes` are deliberately not
included: active items are inventory, while push events overlap with commits,
which already capture code activity. The producer emitted a weighted score
(commits ×0.25, issues ×2, change requests opened ×3 / merged ×4, comments ×0.5,
reviews / approvals ×1.5) through contract 4.x; it was simplified to the plain
sum above because the weighting was opaque and a flat event count is easier to
reason about. The field type is unchanged (`number`, `>= 0`), so this is a
producer recalibration, not a contract shape change: every value is now a whole
number, but consumers must keep treating it as an opaque sortable signal.

Open maps such as `by_activity_kind`, `by_activity_action`, `by_edge_type`,
`by_review_state`, `by_ci_state`, `by_merge_state`, and `by_label_scope` are
deliberately open vocabulary. Do not hard-fail on an unknown key.

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
