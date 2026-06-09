# symphony-board Design

This is the current design record for `symphony-board`. It records the stable
architecture and operating decisions after the baseline product path shipped:
GitHub/GitLab sources, canonical SQLite store, contract major v3, read-only UI,
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

Commit activities keep the title/subject as the first message line and may carry
the remaining message text in `details.body`. REST commit feeds are annotated
with the provider default branch as `details.branch` / `details.ref` when the
repository/project metadata call succeeds; this is the low-cost branch selector
signal, not a complete multi-branch membership graph.

## Actor identity

`actor` is a raw display string and is not a reliable key: one human shows up as
a provider username on issues/PRs/MRs and as several git author names on commits.
So normalization also derives a stable `actor_key` (`src/model/actor.ts`,
persisted on the `activity` row), and Repo Analytics' `top_actors[]` groups on
that key, not on the display string.

The key precedence is **username, then email, then name**:

1. `provider-user:<source_id>:<username>` — a provider username/login. Issues,
   PRs/MRs, pushes, and account-linked commits all carry one, so this groups a
   person's whole footprint under one identity.
2. `email:<hash>` — a commit author email, for account-less git authorship. The
   address is hashed, so it collapses the many commit author-name variants for
   one address without the raw email ever entering the canonical store or the
   contract.
3. `name:<normalized>` — the lowercased, whitespace-collapsed display name, as a
   last resort.

Username is deliberately preferred over email: keying account-linked commits by
username merges them with that person's issues/PRs, where keying by email would
re-split the same human (issues carry no email). The derivation is pure and
deterministic, so it is replayable against stored raw exactly like `normalize`.
Items carry only a username, so their key is recomputed at contract-build time
rather than stored. Contract-facing rules live in docs/CONTRACT.md.

Some facets the automatic key cannot bridge: a GitLab person's issues/MRs carry a
username while their commits carry only an email, with no provider field linking
the two, so they stay separate identities. For those, an optional config identity
map (`identities[]` in `config/sources.json`, .mailmap in spirit) declares the
usernames / commit emails / commit names that are one human; at emit time
`buildRepoMetrics` collapses every matching identity into one canonical
`person:<slug>` actor named by the config. This is deterministic and explicit —
no fuzzy matching — so it never silently merges two different people. Like
colors, it is display-only config: read at emit time, never stored in the DB,
and it leaves automatic keying untouched for everyone not declared.

`top_actors[]` also filters CI/dependency bots as noise: the build auto-drops
unambiguous markers (a GitHub `[bot]` login suffix, GitLab service-account
usernames `project_`/`group_<id>_bot_…`) and an optional `exclude_actors[]`
config list drops the unmarked ones. Excluded actors still count in `totals`/
`series` — only the bounded actor list is trimmed.

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

Current major: v3. Current emitted version: `3.2.0`.

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
explicit date range, with endpoint closure for relationships. The range's day
boundaries are expanded in the configured `timezone` (default UTC; see
`range_query.timezone`, relaxed from the `"UTC"` literal in `3.1.0`).

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

Version `2.2.1` clarified review activity ingestion without changing the
contract shape. Review rows use the existing open `activities[].kind` vocabulary
(`review`), and `repo_metrics[].totals.reviews` / `approvals` are event counts,
not current item-state counts.

Version `2.3.0` added canonical actor identity to
`repo_metrics[].top_actors[]`. Actor rows group by stable non-PII `actor_key`
and render `display_name` / `aliases`, while the original `actor` field remains
a backward-compatible display value.

Version `2.4.0` added optional `activity_score` to the repo metric stats shape.
It is a weighted, range-scoped activity signal over commits, opened issues,
opened and merged change requests, comments, reviews, and approvals. It
deliberately excludes `items_active` because active items are inventory, not
in-window activity.

Version `2.5.0` added `data_quality.last_activity_at`, the most recent observed
activity instant per repo (the counterpart to the earliest `observed_since`).
Unlike the range-scoped `activity_score`, it is computed over every activity row
the repo carries, so it answers "when was this repo last touched" regardless of
the selected window. The Repo Analytics row renders it as "last active".

Version `3.0.0` removed the always-`false` `data_quality.truncated` field (repo
metrics derive from the full canonical store, so a metric row is never
truncated; the real signal is the top-level `item_window.truncated`). The UI now
derives the Repo Analytics coverage badge from the surviving
`activity_available` / `observed_since` / `last_activity_at` fields against the
metric window — see `repoCoverage` in `packages/ui/src/model.ts`. Removing a
field is breaking, hence the major bump.

Version `3.1.0` added envelope-level `timezone` metadata for calendar-day
bucketing and relaxed `range_query.timezone` to the configured IANA timezone
instead of the old `"UTC"` literal. Version `3.1.1` then aligned repo metric day
/ week / month series buckets to that same timezone.

Version `3.2.0` adds optional nullable `repo_metrics[].repo_url`. Provider link
construction stays in the producer layer so Repo Analytics can link row labels
without duplicating GitHub/GitLab URL rules in the UI. Activity rows continue to
use the existing `activities[].url` field as the primary provider destination;
no separate `target_url` field is introduced.

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
  the DOM. Rows link to `activities[].url` only when the producer supplied a
  reliable provider destination.
- **Commits**: commit-only SCM log over `activities[]`, styled separately from
  Activity so it behaves like a provider-neutral commit history. It keeps repo
  and branch filters local to the page, links each message to the provider
  commit URL, exposes short SHAs with copy buttons, expands commit body text
  when available, and shows branch choices only when commit rows carry ref
  details. Provider-specific signals such as GitHub Verified badges or check
  counts are intentionally omitted until the contract has comparable GitHub and
  GitLab semantics.
- **Repo Analytics**: per-repo totals and trends from `repo_metrics[]`. It uses
  the shared date range and source/state/kind/search controls, ranks repos by
  contract `activity_score`, renders compact trend bars from contract series
  buckets, and shows a coverage badge (`active` / `partial` / `idle` /
  `no activity`) so a window with missing or merely dormant activity does not
  look like healthy in-range activity. Repo names link through
  `repo_metrics[].repo_url` when present; non-zero metric values deep-link to the
  source-aware Activity or Commits view for the same date range.
- **Settings**: browser-local display preferences. It can hide repos or whole
  sources, set the default shared date range preset, and set per-repo color
  overrides in `localStorage`. These preferences are a pre-filter before Board,
  Graph, Activity, and Repo Analytics compute their views. They are view-only;
  the daemon keeps syncing every configured source. When the URL has no explicit
  `from` / `to`, new browsers default to `this week`, calculated from Monday in
  the contract's configured `timezone` (default UTC).

The UI supports contract major v3. It warns when a different major is loaded.

## Docker Operation

`docker/compose.yaml` has three services:

- `board`: backend loop daemon and sole writer; also serves the writer-owned
  sync control surface (see below)
- `api`: read-only range query sidecar over the SQLite store
- `web`: read-only nginx sidecar serving the built UI and `/contract.json`

The daemon writes `data/contract.json`. The API sidecar mounts config and data
read-only, opens SQLite with `query_only`, and serves
`GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD`. The web sidecar mounts `data/`
read-only, serves `/contract.json` with `Cache-Control: no-store`, proxies
`/api/range` to the read-only API sidecar, and proxies the sync-control routes
(`/api/sync-control`, `/api/sync-runs`) to the `board` daemon's internal control
port. `web` depends on both `board` and `api` healthchecks so it does not serve
before the first contract and read-only API are ready.

There is intentionally no external cron and no second writer.

Default loop cadence:

- `INTERVAL=120`
- `FULL_EVERY=30`

That gives a full sweep on the first iteration and roughly hourly, with
incremental syncs about every 2 minutes between. Set `FULL_EVERY=1` for every
iteration to be full.

## UI-Triggered Sync Control Plane

A browser reload of the UI only reloads the latest emitted `contract.json`; it
never asks providers for newer data. "Sync now" — a real manual provider sync +
contract emit started from the UI — is a separate capability with a deliberate
boundary, because `board` must stay the only DB writer (`api` and `web` are
read-only sidecars).

**Writer-owned control plane.** In `SYNC_MODE=loop`, `board` runs a Node daemon
(`src/cli/sync-daemon.ts`) rather than a shell `while` loop. The daemon owns the
background cadence, a single in-process run lock, in-memory run status, and a
small HTTP control surface. There is still exactly one writer process and one
sync lock, so a manual run and a scheduled run can never overlap on SQLite.

**Shared runner.** Both the standalone `sync` CLI and the daemon go through
`src/sync-runner.ts`, which defines a run as "sync the selected sources, then
emit the contract unless this run is a dry-run or any source failed". `normalize`
and the engine stay pure; the runner only orchestrates and reports structured
per-source results for the UI.

**Run serialization.** The daemon holds one lock. A manual `POST` while a run is
active returns the active run (HTTP 409) instead of starting a second writer. A
scheduled tick that lands while a manual run is active *skips* that tick (it does
not queue) and the next interval tries again. The cadence is unchanged from the
shell loop: the first iteration and every `FULL_EVERY`-th iteration are full
sweeps, the rest incremental.

**Control API** (served by `board`, proxied by `web`, never the read-only `api`):

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/sync-control` | GET | availability probe: `{enabled, sources[], current, last, interval_seconds, full_every}` |
| `/api/sync-runs/current` | GET | the active run status, or `null` |
| `/api/sync-runs/last` | GET | the last finished run status, or `null` |
| `/api/sync-runs` | POST | start a manual run |

The POST request body is `{mode?: "incremental"|"full", dry_run?: boolean,
source_id?: string|null}`. Defaults are incremental, write, all configured
sources. A run status carries `run_id`, `trigger` (`manual`/`scheduled`),
`mode`, `dry_run`, `source_scope`, `status` (`running`/`ok`/`partial`/`error`),
`started_at`, `finished_at`, `emitted`, per-source rows, and totals
(items/edges/activities/soft-deleted). The default UI action is an incremental
sync of all sources; full sweep, dry-run, and source-scoped runs are advanced
options.

**Re-entrancy.** A second manual request while a run is active is rejected with
the active run (HTTP 409); the daemon never queues unbounded runs.

**Dry-run.** `dry_run: true` exercises fetch/normalize but opens no write
transaction and emits no contract, so the UI can test provider connectivity
without mutating the store or presenting non-written state as fresh data.

**Safety model.** The mutating `POST /api/sync-runs` is enabled only when
`SYNC_CONTROL_ENABLED` is set, and it additionally requires a same-origin custom
header (`X-Symphony-Sync-Control`). A custom header cannot be set by a cross-site
simple form POST and forces a CORS preflight the daemon never answers, so a blind
cross-site POST is rejected without a shared secret. The control port
(`SYNC_CONTROL_PORT`, default 8080) is internal to the Compose network and is
never published to the host; `web` proxies the sync-control routes to it while
`/api/range` still targets the read-only `api` sidecar. Read-only status GETs and
`/healthz` are always served in loop mode; only the manual run is gated.

**UI behavior.** The UI probes `/api/sync-control` on load; when control is
unavailable or disabled it hides the affordance. A successful, non-dry, emitted
run triggers a reload of `./contract.json` (and the active `/api/range` response
for a custom range) while preserving the current route, search, filters, time
range, and display preferences. A dry-run or failed run is shown distinctly and
never reloads the data view as if it were fresh.

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
- **Configurable calendar-day timezone (3.1.0, 3.1.1)**: an optional `timezone`
  in `config/sources.json` (default `"UTC"`, any IANA name) is emitted onto the
  contract envelope. The UI buckets calendar days in that zone — `today` /
  `this week` presets, range filtering, the activity heatmap, and commit-day
  grouping — the range API expands `from` / `to` queries at the zone's day
  boundaries, and (3.1.1) the `repo_metrics[].series` day / week / month buckets
  align to the zone's calendar so one local day is one `day` bucket. Resolved
  with `Intl.DateTimeFormat` (DST-aware, dependency-free); the helper is
  duplicated in `src/lib/tz.ts` (producer) and `packages/ui/src/tz.ts`
  (consumer) because the contract package is type-only at runtime. Absolute
  instants (`generated_at`, `updated_at`, `occurred_at`) stay UTC ISO-8601 —
  only calendar-day bucketing honors the zone.
- **Provider links (3.2.0)**: the producer owns GitHub/GitLab URL construction
  for repo metrics and activity rows. Repo Analytics uses `repo_url` for external
  repo navigation and hash routes for internal drilldowns; Activity uses
  `activities[].url` directly and leaves rows unlinked when the provider cannot
  expose a reliable destination.

## Deferred Or Explicit Non-Goals

- Raw history beyond the latest snapshot per entity. A future `raw_history`
  migration can add it without changing the current raw table.
- Additional provider kinds beyond GitHub and GitLab.
- Provider write actions from the UI (editing issues, labels, PRs, or MRs). The
  UI can trigger a local provider-read sync through the writer-owned control
  plane, but it never writes back to a provider.
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
