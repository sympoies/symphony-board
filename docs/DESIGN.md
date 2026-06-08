# symphony-board Design

This is the current design record for `symphony-board`. It records the stable
architecture and operating decisions after the baseline product path shipped:
GitHub/GitLab sources, canonical SQLite store, contract major v2, read-only UI,
and Docker writer/reader deployment.

Historical validation runs, PR numbers, and one-off investigation details live
in [docs/devlog](devlog). This file is the normative design summary.

## Goal

Aggregate issues and pull/merge requests from multiple providers into one
provider-agnostic model, persist the model locally, and expose a versioned JSON
contract that a read-only board UI and other consumers can read.

The first-class workflow concept is the issue <-> PR/MR relationship. A board
that cannot show whether an issue has linked work in flight, fulfilled, or
abandoned is not useful for this workflow.

## Pivot From GitHub Projects

The predecessor synced into GitHub Projects v2. That sink cannot faithfully hold
GitLab issues or merge requests because Projects items are GitHub Issues, GitHub
PullRequests, or DraftIssues. A GitLab item would become a frozen draft issue
with no live provider identity, no native repository/assignee fields, and no
reliable relationship model.

`symphony-board` replaces the sink with a local model plus a JSON contract. The
cost is that this repo owns the viewer. The gain is that provider identity,
relationships, and source-specific details can be modeled directly instead of
forced through GitHub Projects fields.

## Three Layers

The core boundary is:

```text
raw store -> canonical DB -> versioned contract
```

These are deliberately separate:

| Layer | Purpose | Location | Versioning |
| --- | --- | --- | --- |
| Raw store | Latest opaque provider payload per entity | `raw` table | tagged by `api_version` and `fetched_at` |
| Canonical DB | Provider-agnostic items, labels, edges, activity, sync state | `schema/*.sql`, `src/db/*` | SQLite migrations and `PRAGMA user_version` |
| Contract | Consumer-facing serialized projection | `packages/contract`, `src/contract/*` | semver `contract_version` |

`normalize` maps raw provider records into canonical items and edges. It must be
pure: no network and no DB writes. `buildContract` maps canonical rows into a
contract envelope. It is also pure.

Because raw payloads are retained, normalization and contract changes can be
replayed over stored data without re-fetching from providers.

## Identity

The stable identity is `(source_id, external_id)`.

- `source_id` identifies the configured provider instance, such as
  `github:github.com` or `gitlab:gitlab.com`.
- `external_id` is the provider's immutable global id, such as a GitHub node id
  or GitLab `gid://...`.

`project_path` and `iid` are human metadata. They are useful for display and
search, but they can change when repositories are renamed or transferred, so
they are never primary identity.

The contract encodes item references as:

```text
<source_id>|<external_id>
```

`source_id` must not contain `|`. Consumers split on the first `|` only.

## Relationship Edges

Edges are typed, directed, stateful links between item endpoints. For the
workflow-bearing `closes` edge:

- `from` is the change request.
- `to` is the issue.
- endpoint states are cached on the edge.
- lifecycle is derived centrally.

Lifecycle:

| Lifecycle | Meaning |
| --- | --- |
| `declared` | linked work is still in flight or not yet fulfilled |
| `fulfilled` | change request merged and target issue closed |
| `broken` | change request closed without merging |

Edges are reconciled by `(type, from, to)` because providers can report the same
relationship from either endpoint. GitHub can expose both PR-side and issue-side
closing references. GitLab exposes related merge requests from the issue side
only. Reconciliation deduplicates those reports and converges endpoint state.

Additional edge types are open vocabulary. Today the sources also populate:

- `mentions`: cross-reference events/notes that do not duplicate `closes`
- `relates`: GitLab issue links parsed from system notes

Non-`closes` edges have `lifecycle: null`.

## Activity Records

Activity records are timestamped events, not current state. They are stored in a
dedicated `activity` table and emitted as optional top-level `activities[]` in
the contract. This keeps the item/edge model focused on current workflow state
while still exposing developer-significant actions for a feed UI.

Current sources populate activity from two places:

- canonical item timestamps: opened, closed, and merged transitions
- provider REST activity surfaces: commits plus repository/project events such
  as pushes, branch/tag creation, and branch/tag deletion

Provider activity APIs are not identical. `kind`, `action`, and `details` are
open vocabulary; the stable contract is the row shape, not a closed event enum.
`target_ref` is set only when the producer has a provider immutable id for a
tracked item. Human fields such as `project_path`, `target_iid`, and `title`
are display metadata.

## Disappearance Handling

Persistent stores need a strict rule for disappeared entities. "Not fetched this
run" must not be interpreted as "deleted"; auth failures, rate limits, or
network boundaries can all make a source incomplete.

Rules:

- every observed item and edge gets `last_seen_at`
- only a full and complete sweep may set `deleted_at`
- partial, failed, and incremental runs never soft-delete
- re-seen items and edges are revived by the next upsert
- edge soft-delete is scoped to intra-source edges, because a single-source
  sweep cannot prove that a cross-source relationship disappeared

The loop daemon runs mostly incremental syncs for cost, with periodic full
sweeps so disappearance handling still occurs.

## Provider Mapping

The canonical model uses a lowest-common core plus nullable extension fields.
Provider raw state remains available in `state_raw`, and the full provider
payload remains in the raw store.

| Dimension | GitHub | GitLab | Canonical / contract |
| --- | --- | --- | --- |
| item kind | Issue / PullRequest | Issue / MergeRequest | `issue` / `change_request` |
| identity | GraphQL node id | GraphQL global id | `external_id` |
| state | `OPEN`, `CLOSED`, `MERGED` | `opened`, `closed`, `merged`, `locked` | `open`, `closed`, `merged` |
| closing edge | PR and issue endpoints | issue-side `relatedMergeRequests` | `closes` |
| cross-reference | `CrossReferencedEvent` | parsed system notes | `mentions` / `relates` |
| labels | flat names | scoped labels are meaningful | verbatim `name` plus parsed `scope` |
| review | `reviewDecision` | approval fields | nullable `review_state` |
| CI | `statusCheckRollup` | `headPipeline.status` | nullable `ci_state` |
| mergeability | `mergeable` | `detailedMergeStatus` | nullable `merge_state` |
| activity | commits + repository activity REST | commits + project events REST | `activities[]` |

GitLab caveat: `Issue.relatedMergeRequests` is a superset of strict closing MRs.
It is still modeled as `closes` because it provides the useful workflow signal
for the board. GitLab `mentions` and `relates` are parsed from system-note text,
which is inherently more brittle than structured GraphQL fields; unresolved
references to untracked projects are dropped rather than guessed.

## Contract

The contract is the product API. It is defined by:

- `packages/contract/contract.schema.json` (normative JSON Schema)
- `packages/contract/types.ts` (TypeScript DTO mirror)
- `src/contract/version.ts` (producer version and generator)
- `src/contract/validate.ts` (producer-side validator)

Current major: v2. Current emitted version: `2.2.0`.

Version `1.1.0` added display metadata:

- `sources[].color`
- sparse top-level `repos[]`

These fields are display-only. They are read from config at emit time and never
stored in SQLite. The producer validates colors as `#rgb` or `#rrggbb`; the UI
also validates before using colors in CSS sinks.

Version `1.2.0` added optional top-level `activities[]`.

Version `1.3.0` added optional top-level `aggregates[]`. These rows carry
server-computed totals for explicit `global`, `boardWindow`, and `graphWindow`
scopes. Board aggregate windows are based on item `updated_at`; Graph aggregate
windows are based on relationship endpoints and describe the default overview
edge filter (`no_mentions`). The schema also reserves `focus` as a scope, but
the backend does not emit focus aggregates because the focus target is
viewer-local.

Aggregates describe the emitted contract before local viewer state. Source/repo
visibility, search, facets, Graph mention toggles, and focus targets remain UI
display filters; the UI consumes a contract aggregate only when its scope,
window, and edge filter exactly match the visible view, otherwise it computes a
local scoped summary from `items[]` and `edges[]`.

Version `2.0.0` deliberately changes `items[]` semantics. The contract no
longer ships every live item row by default; it ships the primary 90-day
`boardWindow` item set plus older endpoint items needed to resolve emitted
relationship edges. `item_window` describes that primary window and whether the
payload is truncated. `items[].window_reasons` distinguishes primary Board rows
from edge-endpoint closure rows. Full canonical totals remain available through
`aggregates[]`, and full Settings repo counts move to `repo_stats[]` so the
Settings page is not forced to infer repo inventory from the windowed item set.

Version `2.1.0` added optional `range_query` metadata for read-only range API
responses. The static emitted contract usually omits it. The API response keeps
the same v2 envelope shape but projects items, edges, and activities to an
explicit UTC date range, with endpoint closure for relationships.

Version `2.2.0` added optional `repo_metrics[]`. These rows are grouped by
`(source_id, project_path)` for display and expose per-repo totals, bucketed
series, bounded top actors, and data-quality metadata for either the static
default active-since window or an explicit `/api/range` time window. They are
separate from `repo_stats[]`: `repo_stats[]` stays the full canonical repo
inventory/count surface, while `repo_metrics[]` is a selected analytics window.
The first implementation derives useful metrics from canonical item, edge,
label, and activity rows. Provider-specific fields that are not already
normalized remain represented as nullable signals, open count maps, or
data-quality notes rather than new stable raw-payload dependencies.

Contract rules:

- patch: clarification only
- minor: additive optional/nullable fields only
- major: breaking shape or semantics change

Producers validate strictly. Consumers branch on major and ignore unknown fields
within a major.

## UI

The UI is a read-only consumer in `packages/ui`. It imports contract types,
fetches `./contract.json`, and never reaches into `src/db`, `src/sources`, the
provider APIs, or SQLite.

Pages:

- **Board**: 7 columns. Four status columns (`Open`, `In Progress`, `Trailing`,
  `Closed`) plus three Spotlight lanes (`Follow-up`, `Plan-tracking`, `PR`).
  Status is derived from item state and relationship edges. Spotlight lanes are
  cross-cuts, so their counts do not sum to the item total. The Board uses the
  shared date range and filters primary cards by item `updated_at`. For the
  default static window it can consume a matching `boardWindow` aggregate when
  no viewer-local filters are active. For custom `/api/range` responses and
  viewer-local filters, it computes scoped summary stats locally from the
  returned window.
- **Graph**: relationship view built from edge-connected items. It supports an
  shared date range, mention toggles, side-list search, focus subgraphs, and
  board-card deep-links like `#/graph?focus=<ref>&q=<repo #iid>`. Graph overview
  summary stats are scoped to the rendered overview graph after the range,
  mention controls, search, and facets. Focus view uses a separate `focus`
  summary for the focused subgraph instead of reusing overview totals. Contract
  aggregates are used only for the default no-mentions overview when the static
  window exactly matches an emitted aggregate row; custom range responses compute
  from the returned edges.
- **Activity**: newest-first feed of commit, repository/project event, and
  item-transition records. It uses the same date range as Board and Graph. The
  range is applied before source/kind/search filters, and the page virtualizes
  matching rows so large activity histories remain scrollable without flooding
  the DOM.
- **Repo Analytics**: per-repo totals and trends from `repo_metrics[]`. It uses
  the shared date range and source/state/kind/search controls, ranks repos by
  activity, renders compact trend bars from contract series buckets, and shows
  data-quality badges so missing activity rows do not look like true zero
  activity.
- **Settings**: browser-local display preferences. It can hide repos or whole
  sources, set the default shared date range preset, and set per-repo color
  overrides in `localStorage`. These preferences are a pre-filter before Board,
  Graph, Activity, and Repo Analytics compute their views. They are view-only;
  the daemon keeps syncing every configured source. When the URL has no explicit
  `from` / `to`, new browsers default to `this week`, calculated from Monday in
  the contract's UTC date basis.

The UI supports contract major v2. It warns when a different major is loaded.

## Docker Operation

`docker/compose.yaml` has three services:

- `board`: backend loop daemon and sole writer
- `api`: read-only range query sidecar over the SQLite store
- `web`: read-only nginx sidecar serving the built UI and `/contract.json`

The daemon writes `data/contract.json`. The API sidecar mounts config and data
read-only, opens SQLite with `query_only`, and serves
`GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD`. The web sidecar mounts `data/`
read-only, serves `/contract.json` with `Cache-Control: no-store`, and proxies
`/api/` to the API sidecar. `web` depends on both `board` and `api` healthchecks
so it does not serve before the first contract and read-only API are ready.

There is intentionally no external cron and no second writer.

Default loop cadence:

- `INTERVAL=120`
- `FULL_EVERY=30`

That gives a full sweep on the first iteration and roughly hourly, with
incremental syncs about every 2 minutes between. Set `FULL_EVERY=1` for every
iteration to be full.

## Runtime Decisions

- **Node 24 with type stripping**: backend has no build step.
- **`node:sqlite`**: accepted despite its experimental warning in Node 24.
- **SQLite WAL**: lets readers inspect while the single writer runs.
- **pnpm workspace**: isolates the contract package and UI package while keeping
  the backend buildless.
- **Contract package remains type-first**: producer constants and validator stay
  in the backend so the backend Docker image does not need runtime package
  resolution.
- **Docker loop is the writer**: generated runtime contracts are daemon output,
  not hand-maintained artifacts.

## Deferred Or Explicit Non-Goals

- Raw history beyond the latest snapshot per entity. A future `raw_history`
  migration can add it without changing the current raw table.
- Additional provider kinds beyond GitHub and GitLab.
- External write actions from the UI. The UI is intentionally view-only.
- Splitting UI or contract into separate repos. The package boundary is enough
  until third-party consumers or release cadence require more.
- Historical pagination beyond explicit date ranges. The read-only range API
  can return a bounded contract for a selected range, but there is no cursor,
  infinite scroll, or provider write-back surface.

## Validation Baseline

The stable validation gates are:

- root typecheck and backend tests
- UI build, UI tests, and headless render-smoke
- combined logic-tier coverage with an 85% line floor in CI
- producer contract validation on emit
- source dry-runs for provider or sync-engine changes when credentials/network
  access are available

The devlog records the dated live-provider validations and PR check outcomes
that led to this baseline.
