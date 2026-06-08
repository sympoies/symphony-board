# Contract Versioning

The contract is LAYER 3: the serialized projection consumed by the UI and any
external reader. It is not the SQLite schema and not the stored truth. It is
derived from raw/canonical data whenever `emit` runs.

Definition files:

- `packages/contract/contract.schema.json`: normative JSON Schema
- `packages/contract/types.ts`: TypeScript DTO mirror
- `src/contract/version.ts`: `CONTRACT_VERSION` and `GENERATOR`
- `src/contract/validate.ts`: dependency-free producer validator

Current emitted version: `2.3.0`.

The private workspace package version in `packages/contract/package.json` is
package metadata. Consumers must use the envelope's `contract_version`, not the
package version, to decide compatibility.

## Envelope

```jsonc
{
  "contract_version": "2.3.0",
  "generated_at": "2026-06-08T00:00:00.000Z",
  "generator": "symphony-board/0.1.0",
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
      "state": "open",
      "state_raw": "OPEN",
      "state_reason": null,
      "is_draft": null,
      "author": "graysurf",
      "created_at": "2026-06-01T00:00:00.000Z",
      "updated_at": "2026-06-08T00:00:00.000Z",
      "closed_at": null,
      "merged_at": null,
      "labels": [],
      "review_state": null,
      "ci_state": null,
      "merge_state": null,
      "milestone": null,
      "demand": 3,
      "last_seen_at": "2026-06-08T00:00:00.000Z",
      "window_reasons": ["primary", "edge_endpoint"]
    }
  ],
  "edges": [],
  "activities": [],
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
          "actor": "graysurf",
          "actor_key": "provider-user:github:github.com:graysurf",
          "display_name": "graysurf",
          "aliases": ["Gray Surf"],
          "activities": 8,
          "commits": 3,
          "items_opened": 1,
          "change_requests_merged": 1
        }
      ],
      "data_quality": {
        "activity_available": true,
        "truncated": false,
        "observed_since": "2026-05-24T00:00:00.000Z",
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
- `sources`: source health and source display metadata.
- `items`: windowed normalized work items in contract v2.
- `edges`: typed relationships whose endpoints are resolved by the v2 item
  window whenever the endpoint belongs to a tracked item.
- `activities`: optional developer-significant event feed, added in `1.2.0`.
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

Known `kind` values are `issue` and `change_request`, but the contract keeps
`kind` as an open string.

Important fields:

- `id`: composite ref.
- `source_id` / `external_id`: immutable source identity.
- `project_path` / `iid`: mutable human metadata for display and search.
- `state`: normalized `open`, `closed`, or `merged`.
- `state_raw`: provider state string for debugging/escape hatch.
- `labels`: verbatim provider labels plus parsed `scope` for `scope::value`.
- `review_state`, `ci_state`, `merge_state`: nullable provider-derived signals.
- `demand`: comments plus reactions/upvotes.
- `last_seen_at`: latest successful observation in the canonical store.
- `window_reasons`: v2 inclusion reasons. `primary` means the item belongs to
  `item_window`; `edge_endpoint` means it is included to resolve an emitted edge
  endpoint. Missing means "primary" when reading old v1 payloads.

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

Important fields:

- `id`: composite ref for this activity record.
- `source_id` / `external_id`: stable source identity for the record.
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
- `summary`: producer-readable text for UI display.
- `details`: provider-specific JSON object for debugging and later consumers.

Current sources derive item transition activities from canonical item timestamps
and fetch provider REST activity surfaces for commits and repository/project
events.

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
  exist only to resolve emitted edge endpoints.
- `total_items`: full live canonical item count before windowing.
- `truncated`: true when at least one live item row is omitted from `items[]`.

Consumers should treat `items[]` as complete only for the primary window.
Choosing a different Board, Graph, or Activity date range requires another
payload such as `/api/range`; the static v2 contract cannot synthesize missing
historical cards. Consumers can still show true full totals from `aggregates[]`.

## Range Query

Version `2.1.0` added optional `range_query` metadata for read-only API
responses. The static `emit` path usually omits it. `GET /api/range` returns the
same contract envelope shape, with `range_query` set to:

- `kind: "time_range"`
- `timezone: "UTC"`
- `from`: inclusive UTC timestamp for the selected date's start
- `to`: inclusive UTC timestamp for the selected date's end

The range response is a projection, not a second schema:

- primary Board items are selected by `items[].updated_at` inside
  `[from, to]`.
- edges are included when they touch a primary item or when a tracked endpoint
  was updated inside the range, so Graph can use the same selected range.
- tracked edge endpoints are included in `items[]` with
  `window_reasons: ["edge_endpoint"]` when they are outside the primary item
  set.
- `activities[]` is filtered by `occurred_at` inside `[from, to]`.
- `aggregates[]` is empty in range responses; consumers compute scoped visible
  stats from the returned rows.
- `repo_stats[]` remains the full canonical repo inventory, not only loaded
  range rows.

The API validates the date query and opens SQLite read-only; it is not a writer
and does not mutate sync state.

## Repo Stats

Version `2.0.0` added required `repo_stats[]` because Settings repo inventory
cannot be derived from a windowed item payload.

Each row is keyed by `(source_id, project_path)` and contains:

- `items`: full live item count for that repo.
- `by_state`: full item counts by normalized state.
- `by_kind`: full item counts by kind.

## Repo Metrics

Version `2.2.0` added optional `repo_metrics[]` for the Repo Analytics page and
external consumers that need per-repo trends. Each row is keyed by
`(source_id, project_path)`, matching `repo_stats[]`, but the semantics are
different:

- `repo_stats[]` is full inventory over the canonical live item set.
- `repo_metrics[]` is scoped to one time window and must not be used as full
  inventory.

Each row contains:

- `window`: `active_since` for static emits or `time_range` for `/api/range`,
  always with `basis: "repo_activity"`, inclusive UTC `from` / `to`, and an
  explicit bucket width (`day`, `week`, or `month`).
- `totals`: selected-window counts for active/opened/closed items, opened /
  closed / merged change requests, activity event categories, edge lifecycle,
  and open-vocabulary breakdown maps.
- `series[]`: bucketed points using the same stats shape as `totals`.
- `top_actors[]`: bounded actor summaries. This is an aggregate list, not an
  unbounded user directory. See "Actor identity" below.
- `data_quality`: whether activity rows exist for the repo, whether the metric
  row is truncated, the earliest observed activity timestamp, and notes for
  provider or coverage gaps.

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
  Username wins over email so a person's account-linked commits join their
  issues/PRs instead of splitting into a separate email-keyed row. Two records
  that share neither a username nor an email stay separate even when their
  display name matches.
- `display_name`: the deterministically chosen name for the identity — the most
  frequently observed raw name, tie-broken case-insensitively then by code unit.
- `aliases`: the other distinct display names observed for the identity, sorted;
  omitted when there is only one.
- `actor`: a backward-compatibility display field equal to `display_name`, kept
  so pre-`2.3.0` consumers keep rendering. Render `display_name` and key React
  lists on `actor_key`.

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
v2 and warns on any other major.

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
