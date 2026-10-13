# symphony-board Design

This is the current design record for `symphony-board`. It records the stable
architecture and operating decisions of the shipped product: GitHub/GitLab
sources, canonical SQLite/Postgres store drivers, contract major v4, a UI that
is read-only toward providers (with writer-owned sync and config control
planes), and Docker writer/reader plus standalone single-machine deployments.

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
| Canonical DB | Provider-agnostic items, labels, edges, activity, sync state | `schema/sqlite/*.sql`, `schema/postgres/*.sql`, `src/db/*` | driver-owned migrations |
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
- `parent` / `blocks`: program structure read from a tracker issue's phase
  table (GitHub), described below

Non-`closes` edges have `lifecycle: null`.

### Program Tracker Edges

A program tracker is an issue whose body has a `## Phase table` section with at
least one valid row; the `workflow::tracking` label is not required. The row
grammar is owned by `agent-runtime-kit`
(`core/skills/issue/issue-follow-up/references/tracker-row-grammar.md`) and its
conformance corpus is vendored unchanged under
`test/fixtures/tracker-row-grammar/`. `src/model/tracker.ts` is a pure,
provider-neutral, lenient consumer of that grammar: it never throws, a malformed
row contributes nothing, and it reports no findings.

The tracker is the reporter of both edge types, in one canonical direction each
(never also `child` or `blocked_by`):

- `parent`: tracker -> each row's issue, once per issue.
- `blocks`: prerequisite row's issue -> dependent row's issue, per `· after`
  dependency. A row without a ref is a gate and is contracted: a dependency on a
  gate becomes a dependency on that gate's own prerequisites, transitively, with
  a guard against gate cycles. Unknown ids, self-edges (two rows of one issue
  included), and repeats are dropped; an id used twice means its first row.

A row names its issue as text (`owner/repo#N`, or `#N` for the tracker's own
repository), so the node id has to be looked up — and `normalize` must stay
pure. The GitHub `fetch` therefore resolves a tracker's refs with one aliased
GraphQL lookup per 50 refs, through the same client as the tracker's project,
and stores the result on the issue's raw payload as `__trackerRefs` (canonical
ref text -> node id and state); `normalize` reads only the body and that map,
so tracker edges replay from stored raw. This is the same split as GitLab's
note references (`__mentions` / `__relates`). Issue raw is written by one
fetch path (full and incremental alike; the by-number and CI-refresh paths are
pull-request only), so every stored tracker payload carries the map.

A tracker body is text that anyone who can write an issue in a tracked
repository controls, so what one body can make the sync do is bounded. Every
bound cuts in table order and silently; a ref or dependency beyond one is
unresolved, never a failed sweep.

| Bound | Value | Why |
| --- | --- | --- |
| Repositories a ref may be resolved into | this source's configured projects (case-insensitive), plus the tracker's own repository | The sync token usually reads more than the board tracks. Resolving whatever a row names would let a writer probe other repositories through it and publish the answer as an edge. A row into a repository the board does not track is never looked up and yields no edge. |
| Rows read per phase table | 500 | Gate contraction multiplies rows into edges. |
| Refs looked up per tracker | 200 distinct, applied after the repository rule | One body must not buy unbounded round trips from the token's rate budget on every sweep. |
| `blocks` edges per tracker | 1,000 | K rows, one gate after all of them, and D rows after the gate is K x D edges: over a million from one 64 KB body without the bound. |

Gate expansion also visits each prerequisite once per dependent and resolves
each row ref once, so dense gate structures stay linear in what they emit.

- A target that does not exist, or that the token cannot read (GraphQL
  `NOT_FOUND` / `FORBIDDEN`), is absent from the map and yields no edge. That
  is not a failed sweep.
- Any other failure of the lookup makes the source partial and keeps the
  watermark unchanged, so the next incremental re-reads the tracker. Edge
  soft-delete is per source, not per type: a tracker whose refs were not
  resolved re-emits none of its edges, so that sweep must not count as complete.
- A `blocks` edge is reported by an item that is neither of its endpoints.
  Reconciliation records that provenance as `neither`, never as a side, and
  endpoint states are still refined from the items seen in the same run. The
  `edge.discovered_from` column therefore holds one of `from`, `to`, `both`,
  or `neither`: which endpoints reported the edge this run, `neither` when only
  a third item did.

Endpoints use the tracker's `source_id` on both sides, so tracker edges are
intra-source and follow the disappearance rule below: a row removed from a
tracker loses its edges only at the next full and complete sweep.

## Activity Records

Activity records are timestamped events, not current state. They are stored in a
dedicated `activity` table and emitted as optional top-level `activities[]` in
the contract. This keeps the item/edge model focused on current workflow state
while still exposing developer-significant actions for a feed UI.

Current sources populate activity from two places:

- canonical item timestamps: opened, closed, and merged transitions
- provider REST activity surfaces: comments, commits (default branch plus live
  side-branch compare sets), and repository/project events such as pushes,
  branch/tag creation, and branch/tag deletion

Provider activity APIs are not identical. `kind`, `action`, and `details` are
open vocabulary; the stable contract is the row shape, not a closed event enum.
`target_ref` is set only when the producer has a provider immutable id for a
tracked item. Human fields such as `project_path`, `target_iid`, and `title`
are display metadata.

A comment row names the item it is on (4.9.1). GitLab's events API reports the
item's database id (`note.noteable_id`, or `target_id` on an issue or merge
request event), which is the number in the GraphQL global id the item row is
keyed on, so `normalize` builds the ref with no extra request. GitHub's REST
comments carry no node id for their issue or pull request, and one lookup per
comment is a different cost class, so `emit` resolves the row's repository,
kind and number against the live items and emits the found item's immutable
ref. That join is display resolution, not identity: the row keeps its own
`(source_id, external_id)`, and a miss (a renamed repository, a gone item, a
number two live items share) leaves `target_ref` null rather than guessing.
Comment text stays out of the contract; the UI shows a comment's words only
where `review_threads[]` already carries them.

Commit activities keep the title/subject as the first message line and may carry
the remaining message text in `details.body`. The commit feed covers the default
branch plus live side branches without enumerating the provider's branch list:
the push/project events fetched in the same sweep double as branch discovery,
and each discovered live branch contributes only its branch-unique commits via a
compare against the default branch (one or two extra calls per pushed branch per
sweep — affordable at the incremental cadence). Feeds merge per sha into one
activity row whose `details.branch` / `details.ref` carry the primary branch and
`details.branches` / `details.refs` the full membership (default branch first).
The row also names the repository's default branch (`details.default_branch`)
and marks a commit with more than one parent (`details.merge`); both are read
from the stored payload, not from a request of their own. It names the change
request the commit belongs to (`details.change_request`) when the provider can
say: GitHub answers inside the GraphQL batch that already reads line counts
(for any commit, short of one with more pull requests than it reads), while
GitLab links only the commits a merge request landed as, from one
merged-merge-request listing per project per sweep.
A deleted branch stops being discovered; rows it produced keep the labels they
earned. Per-source `commit_branches: "default"` restores the default-branch-only
feed as an escape hatch.

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
and it leaves automatic keying untouched for everyone not declared. The identity
map is global by default for backwards compatibility, but an entry can declare
`source_ids[]` to limit its username / email / name matches to specific provider
instances. Use that for broad commit display names that are safe on one host but
could belong to someone else on another host.

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

GitHub read requests use one bounded retry budget for network-level fetch
rejections and HTTP 502/503/504 responses: two retries after 250 and 500 ms,
with at most three attempts per request. This applies to full and incremental
sweeps and repeats the failed request rather than restarting project pagination.
Exhaustion still makes coverage partial; successful sibling records remain
available. Request timeouts and other provider/application errors retain their
existing behavior, as do GitLab requests.

GitHub pull-request discovery deliberately uses different query shapes for the
two sweep modes. A full sweep reads the rich paginated PR connection so it can
reconcile every item and relationship. An incremental sweep first pages only
PR identity, number, and `updatedAt`, stops at the stored watermark, and then
resolves the rich payload only for those fresh PRs. This keeps the fixed
per-repository reconciliation cost small without weakening the complete-sweep
proof required for disappearance handling. A failed rich resolve makes the
incremental source partial while preserving any sibling records that completed;
the source watermark stays unchanged so the next incremental retries the failed
row instead of deferring it until a full sweep.

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
| program structure | tracker phase table, refs resolved at fetch | not read yet | `parent` / `blocks` |
| labels | flat names | scoped labels are meaningful | verbatim `name` plus parsed `scope` |
| review | `reviewDecision` | approval fields | nullable `review_state` |
| CI | `statusCheckRollup` | `headPipeline.status` | nullable `ci_state` |
| mergeability | `mergeable` | `detailedMergeStatus` | nullable `merge_state` |
| activity | comments + commits + repository activity REST | commits + project events REST | `activities[]` |

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

Current major: v4. Current emitted version: `4.10.0`, declared by
[`CONTRACT_VERSION`](../src/contract/version.ts).

[CONTRACT.md](CONTRACT.md) owns the full version history and field-level contract.
Keep additions and compatibility notes there rather than maintaining a second
history in the architecture record.

Contract rules:

- patch: clarification only
- minor: additive optional/nullable fields only
- major: breaking shape or semantics change

Producers validate strictly. Consumers branch on major and ignore unknown fields
within a major.

## UI

The UI is a read-only consumer in `packages/ui`. It imports contract types,
fetches `./contract.json`, and never reaches into `src/db`, `src/sources`, the
provider APIs, or the configured store.

The same UI is packaged by two thin-client shells:

- `packages/desktop`: macOS Tauri shell. It keeps the existing local Docker
  default server URL (`http://localhost:8080/`) for same-machine use.
- `packages/android`: Android Tauri shell. It has no local data store, provider
  tokens, sync daemon, or backend sidecar, and it does not default to localhost;
  a build-time `VITE_SYMPHONY_BOARD_SERVER_URL` or Settings -> Server supplies
  the hosted URL.

Both shells use the Tauri HTTP plugin only as a client-side transport bridge for
HTTP(S) contract/API requests and the opener plugin for provider links. They do
not alter the provider-read-only boundary.

Pages:

- **Live**: opt-in realtime webhook event feed (off by default). It does not
  read the contract; it streams from the Live receiver (see "Live Event Stream
  (Realtime)"). The tab renders once enabled and hides only when the connection
  is definitely unavailable, so a slow snapshot seed can still be opened and
  retried. Its detail supports left/right swipes; Settings owns preview lines
  and hidden event types.
- **Board**: 5 columns, in order `Trackers`, `Open`, `Closed`, `Follow-up`,
  `Change requests`. `Open` and `Closed` are the status columns: status is the
  item's own state (open, or closed/merged), not derived from relationship
  edges. The other three are Spotlight lanes. `Trackers` leads the board with
  issues labeled `workflow::tracking`: open trackers first, closed ones folded
  behind a `Closed (N)` toggle. `Follow-up` keeps issues labeled
  `workflow::follow-up` in any state, and `Change requests` lists open change
  requests only. Spotlight lanes are cross-cuts, so their counts do not sum to
  the item total. A tracker card says how far its program is and what can start
  next: `done/total` over the tracker's children (the targets of its `parent`
  edges), up to three ready children by name then `+N`, and the in-review and
  blocked counts when non-zero. The rules live in `packages/ui/src/program.ts`,
  a pure, view-agnostic module: a child is done when closed or merged;
  otherwise blocked when a `blocks` edge into it comes from an item that is not
  done; otherwise in review when a `closes` edge into it comes from an open
  item; otherwise ready. An endpoint's state is its loaded item row's, falling
  back to the edge's state, and unknown counts as open. A tracker without
  children shows no progress. The lane stays label-selected: `parent` edges
  never add an issue to it, because anyone who can write an issue can write a
  phase table while only triagers set the label. An open tracker is listed
  whatever the date range: the producer pins open labeled trackers into every
  projection (window reason `program_tracker`, capped at the newest 100, see
  Contract), and the Trackers lane — only that
  lane — also takes those rows when they are outside the range. Item facets and
  source/repo visibility apply to them; the status columns, the summary stats,
  and the other lanes keep to primary-window items. Closed trackers appear only
  when in range. The Board uses the shared date range and filters primary
  cards by item `updated_at`. For the default static window it can consume a
  matching `boardWindow` aggregate when no viewer-local filters are active. For
  custom `/api/range` responses and viewer-local filters, it computes scoped
  summary stats locally from the returned window.
- **Graph**: relationship view built from edge-connected items. It supports the
  shared date range, relation type toggles, side-list search, focus subgraphs,
  a program view for trackers, and
  board-card deep-links like `#/graph?focus=<ref>` (the `focus` ref alone drives
  the side-list focus view and the focus subgraph; the global search bar is a
  cross-tab filter and is never seeded by navigation). Focus is URL-backed both
  ways: side-list clicks, canvas node-body clicks (which focus the node — the
  node title is the anchor to the provider page), and focus exits all write
  `?focus=` back to the hash, so a focused view is shareable and the browser
  back button steps through focus changes. Search helps locate an item in the
  overview, but is visibly suspended in focus so a narrow lookup cannot erase
  the item's multi-hop neighborhood; the query stays URL-backed and resumes on
  focus exit. Explicit facets and persistent visibility choices remain active.
  In overview, the side list is the
  relationship inventory for the selected range before the mention canvas
  declutter is applied, so mention-only items remain discoverable without a
  redundant per-card canvas-visibility cue. The overview has one toggle per
  relation type present in the loaded edges — an unknown type gets one like any
  other — with every type on except `mentions`, which keeps its all / issues /
  change requests target filter; the toggles are page state, not route or
  stored state, and focus always draws every type. The five known types are
  distinguishable without colour: `closes` solid in its lifecycle colour,
  `blocks` heavy, `parent` dash-dotted, `mentions` short-dashed, `relates`
  long-dashed. A type the UI does not know draws with the default stroke, the
  `closes` line in the muted colour. The legend keys the types on the canvas.
  The side list names an item's strongest
  relation: `closes`, then `blocks`, `parent`, `mentions`, `relates`.
  Disconnected overview components
  are laid out independently and packed into a compact canvas; focus retains
  the roomier single-neighborhood layout. Graph overview summary stats
  are still scoped to the rendered canvas after the range, relation type
  toggles, search, and facets. Focus view uses a separate `focus` summary for the
  focused subgraph instead of reusing overview totals. Contract aggregates are
  used only for the default overview (every type on except mentions) when the
  static window exactly matches an emitted aggregate row; custom range responses
  compute from the returned edges.
  Overview remains range-windowed, but focus is a canonical-history inspection:
  the UI calls `GET /api/graph-neighborhood?ref=<ref>&depth=<1..5>&mentions=all`,
  defaults to one hop, and remembers an explicit depth across focus exit and
  re-entry during the app session. All edges, including mentions, are walked as
  undirected for membership while retaining their original direction. The
  projection is deterministic across cycles and caps a response
  at 200 nodes / 500 edges. It reports whether depth or a safety cap limited the
  result. A static/local
  file deployment cannot query the store, so it keeps the previous loaded
  one-hop fallback and labels that limitation in the focus view. The focused
  canvas card has a theme-aware target marker and outline; a Locate target
  control centers it at readable zoom when a deeper neighborhood is crowded.
  Focusing a program tracker — an item with outgoing `parent` edges in the focus
  data — opens its program view instead: the tracker is the header (title,
  state, `done/total`), its children are the nodes, and `parent` edges are
  implied rather than drawn. Children sit in columns left to right, each one
  column after its last prerequisite, in program order within a column, joined
  by the transitive reduction of the `blocks` edges among them (gate contraction
  makes the raw set dense; a cycle has no reduction, so then every edge is
  drawn and the header says so). Each child carries its status marker and its
  delivering change requests, attached underneath by `closes`; a child without
  an item row is an untracked node. Child order and status are the Board's
  (`packages/ui/src/program.ts`, rule stated under **Board** above), read from
  the same kind of edge set: persistent visibility applies, item facets and
  search do not, so a program reads the same on both pages. A `blocks` edge
  into a child from outside the program therefore blocks it without being
  drawn. The columns are laid out directly rather than by dagre, whose
  coordinate assignment spreads a layer that depends on a whole layer over
  several times its own height. A view toggle switches to the ordinary
  neighborhood and back; `scope=neighborhood` on the route records that choice,
  while its absence (every older focus link) means the program view, and a new
  focus always starts on its default. With a server the view loads
  `GET /api/graph-neighborhood?ref=<ref>&scope=program` — directly when the
  loaded window already shows the tracker's children (always, for a pinned open
  tracker), otherwise after the ordinary neighborhood response shows them; a
  static/local-file deployment reads the same scope from the loaded edges.
  Whether the focus is a tracker is one test over the edges the viewer can see,
  used both to load the program scope and to draw it, so a tracker whose
  children are all in hidden repos or sources loads and draws as an ordinary
  neighborhood, and a program response that shows no child is treated as a
  failed request. When the program request fails — a server that predates the
  scope answers it with a one-hop neighborhood, which the client rejects — the
  program is still drawn and the focus line says from what: the loaded edges
  when the loaded window showed the children, else the neighborhood response
  that did, which can lack the edges that decide a child's status.
- **Activity**: newest-first feed of commit, repository/project event, and
  item-transition records. It uses the same date range as Board and Graph. The
  range is applied before its route-backed source/repo/kind/action facets and
  search, and the page virtualizes
  matching rows so large activity histories remain scrollable without flooding
  the DOM. Rows link to `activities[].url` only when the producer supplied a
  reliable provider destination.
  A row is two lines, like a commit row. The first holds the action, the item's
  number and title (or a commit's short sha and subject, or the branch), and on
  the right the item's current state or a commit's line counts. The second holds
  the repository, the actor, and chips: a review comment's file and line, or a
  push's from → to. Selecting a row opens a detail pane above the overview, with
  everything the event knows: the item as it is now (state, review, CI, labels,
  comment and review-thread counts, the start of its description), the event's
  own facts, and the other in-range events on the same item. A wide screen opens
  the pane on the newest row, pinned, so a reload never swaps the event being
  read; following the newest row is the viewer's choice, as on Commits. A pinned
  row a filter removes falls back to following on a wide screen and closes the
  reader on a phone. Below the split floor the pane is a
  route-backed reader (`activityDetail=1`) with previous / next and swipe, as
  on Commits. The pane quotes a comment's words only when the contract already
  carries them in `review_threads[]` (a GitHub review comment by node id, a
  GitLab note by its `#note_<id>` anchor); an issue comment shows no text.
  From 1400px the page takes the Commits pane tiers (`COMMITS_STACK_QUERY`,
  `COMMITS_PANES_QUERY`), and its layout is also a `.commits-split`, so the two
  pages share one set of tier rules. The middle column holds the detail above
  an overview of panes: summary tiles (events, people, repos, active and busiest
  days, comments, reviews, merges, opened items, pushes); the year's rhythm
  with its facts; events per day stacked by kind, action, repository or person;
  a day-by-hour grid; review verdicts; and the busiest issues and change
  requests, each of which opens its newest event. The rail holds Who (share,
  repositories, active days, per-day sparkline), Where (share, active days,
  sparkline), Branches, What and How. Where, What, How and a verdict toggle
  the route-backed facets. In the laptop tier a rail list cut at its eight rows
  ends in "Show all N" (or "Show top 50 of N"), which opens it in place. Every pane reads the rows the feed renders, except
  the rhythm, which reads `activity_daily`. Below 1400px the page keeps its two
  columns and the plain overview; the old who / where / when rail is gone.
- **Items**: newest-updated issue and PR/MR list over `items[]`, scoped by the
  shared date range and item lens. It is a lookup surface for cross-source,
  cross-repo work items, not a replacement for the Board's relationship/status
  workflow view. Rows link to provider items and preserve the shared Graph focus
  affordance for related items.
- **Commits**: commit-only SCM log over `activities[]`, styled separately from
  Activity so it behaves like a provider-neutral commit history. It keeps source,
  repo, branch, and author filters local to the page, links each message to the provider
  commit URL, exposes short SHAs with copy buttons, expands commit body text
  when available, and shows branch choices only when commit rows carry ref
  details. Detail selection is manual by default; a device-local Settings opt-in
  follows the newest visible commit and advances when newer data or a changed
  commit filter produces a new first row. The detail identifies that state as
  `Following latest`; selecting another row changes it to `Pinned`, and the
  in-pane `follow latest` action releases the pin. Provider-specific signals
  such as GitHub Verified badges or check counts are intentionally omitted
  until the contract has comparable GitHub and GitLab semantics.
  The phone reader open state is route-backed as `commitDetail=1`, like the
  Live, Reviews, and Items readers. Browser/Android Back closes the reader
  before leaving Commits; the selected commit and follow/pin mode remain local.
  On phone widths, tapping a commit opens a full-screen reading view with two
  panes: the selected commit detail and its changed-file list. Info and Files
  switch between separate scrolling content areas beneath a fixed control,
  matching the other phone detail views without covering scrolled text.
  The entire reader, including blank space, accepts the same left/right swipes
  as Live and Items: left moves to the older commit and right to the newer one
  in the filtered list, stopping at either end. Swiping pins the commit,
  preserves the active Info/Files pane, and resets detail/files scrolling.
  Newer/Older controls are hidden in desktop split views; in the phone reader
  they stay at the viewport bottom outside both scrolling panes. Short Info and
  Files cards fill the remaining reading area like Live; longer content scrolls
  without moving the footer.
  Links, controls, vertical gestures, and scrollable code retain their behavior.
  The tap fetches the files even when the desktop rail's file-stats setting is
  off. Back returns to the commit list. Following a newer commit does not open
  the reading view or fetch its files by itself.
  At 761–1211 CSS pixels, the list stays beside a scrollable detail/files
  column. Filters collapse behind a summary and expand inline; selecting a
  commit prioritizes its detail over the range overview and resets the right
  column to the top. The visible compact detail fetches files and keeps them
  synchronized while following latest, without changing the device setting. At 1212–1279px the overview and digest
  rail stack in one column beside the list; from 1280px Commits shows the list,
  overview, and rail as three columns.
  Up to 1399px the two supporting columns hold the plain digest and reach the
  bottom of the list by growing their charts. From 1400px
  (`COMMITS_STACK_MIN_WIDTH_PX`, the laptop tier) they carry the full set of
  panes described below, stacked one module per column at 36 / 32 / 32
  (40 / 30 / 30 from 1960px, where that keeps the list on one-line rows), and
  each column scrolls inside itself; every list in them stops at eight rows,
  Largest commits and Change requests scroll within 320px, and the author
  rows keep share, active days and the per-day line (lines and repos stay in
  the row's accessible name). A laptop screen has the height for these panes
  but not the width for two side by side. From 2480px
  (`COMMITS_PANES_MIN_WIDTH_PX`) they are two-up grids instead, the split is
  32 / 34 / 34, and spare height goes to lists rather than to marks: every
  chart keeps a designed height, and Largest commits, Top repos, and Top
  branches take what is left and scroll inside their pane. A ranked row's hover
  tip, on every page, shows only when it adds something: the whole name of a
  label the row cuts or shortens, and on a filter row what a click does. In
  the row layouts it sits over its own row from the name, and the count column
  never moves. In the three-column
  layouts the list's wrapping card puts the sha and its actions beside the
  subject only, so the repository, author and chips below it use the card's
  full width. The pane tiers add a stacked per-day chart (by type, repo, or
  author), lines changed per day, a day-by-hour grid in place of the hour
  strip, Largest commits (a row pins that commit), commit scopes, per-row
  facts on the ranked facets, a 12-month streak summary under the rhythm
  calendar, and a comparison with the preceding period on the commit count.
  The comparison reads `activity_daily`, which counts every commit, so it is
  shown only while no source, repo, branch, or author filter is active and no
  repository or source is hidden in Settings, only when the aggregate reaches
  back far enough to cover the earlier window, and only when the rows on screen
  account for the aggregate's own count for the selected range (within 2%) —
  which is what hides it when the feed is windowed shorter than the range.
  Every pane derives from the rows the list renders or from `activity_daily`;
  none needs a fetch of its own.
  A merge commit (`details.merge`) is tagged `merge` where its line counts
  would be, so it no longer reads as a commit whose counts are unknown, and a
  device-local toolbar toggle leaves merges out of the list and of every pane;
  the period comparison is withheld while it is on. The repository's default
  branch (`details.default_branch`) is drawn first and emphasized on a commit's
  branch chips. In the pane tiers the per-day chart can also be split by
  default branch vs. side branch or by merge vs. commit, a Merges tile appears
  when the range has any, and Top branches leads with the default branches and
  states the share of commits on one. A row from a producer that names no
  default branch is left out of that share rather than counted as a side branch.
  A commit that names its change request (`details.change_request`) shows the
  number as a chip on its row and a Change request row in its detail with the
  item's title, state, review and CI when the item is loaded. The chip opens
  the Items page narrowed to that item when it is one of that page's rows, and
  the provider page when it is loaded only as a support row. The pane tiers
  add a Change requests pane beside Largest commits (the range's commits
  regrouped by the change request they belong to: commits, lines, and how long
  a merged one was open) and a tile counting default-branch commits that landed
  without one. That tile counts only explicit "none" answers on non-merge
  commits, so a provider that cannot resolve every commit never inflates it.
  The pane tiers' last rail pane answers "where did the work land" three
  ways behind one switch: Hot files and Hot directories from the producer's
  file aggregate (`commit_file_stats`), and Commit scopes from the subjects.
  The file views state their coverage ("N of M scanned"), and a row narrows the
  list and every pane to the commits that touched that path; a chip in the
  toolbar clears it. The aggregate is per repository, so it is re-ranked
  exactly across the repositories on screen but cannot be re-ranked for one
  author's or one branch's commits: under either filter the pane shows scopes
  only, and the "files changed" tile is withheld.
  Selected content cards share a subtle theme-aware fill and border across
  Commits, Items, Live, Reviews, and the Graph list; selection paints the
  rounded card rather than virtual-row spacing. Keyboard focus remains visible.
- **Reviews**: current provider review-thread inbox over top-level
  `review_threads[]`, not a review-event feed. It uses the shared date range and
  item lens, lists each synced thread with current resolved/outdated state,
  file/line metadata, and compact comment previews, and shows repo-level
  thread breakdown/trends. Metrics' non-zero `Threads` cells deep-link
  here with source/repo/unresolved filters.
- **Metrics** (`#/repo-analytics`, formerly Repo Analytics): per-repo totals
  and trends from `repo_metrics[]`. It uses
  the shared date range and source/state/kind/search controls, ranks repos by
  contract `activity_score`, renders compact trend bars from contract series
  buckets, and shows a coverage badge (`active` / `partial` / `idle` /
  `no activity`) so a window with missing or merely dormant activity does not
  look like healthy in-range activity. Repo names link through
  `repo_metrics[].repo_url` when present; non-zero metric values deep-link to the
  source-aware Activity or Commits view for the same date range.
- **Settings**: browser-local display preferences, organized into expandable
  Connection & sync, Appearance, Navigation, Board & repositories, Commits,
  and Live groups. Appearance opens by default; an unconfigured client also
  opens Connection & sync. The writer-owned Sources editor remains separate.
  The default tab order is Live (when enabled), Commits, Activity, Metrics,
  Board, Graph, Items, Reviews. A device whose saved order is the old default
  gets the new default; any other saved order has Commits moved to the front of
  the content tabs once, and later custom orders persist. The default landing
  tab is Live, which falls back to Activity while the Live tab is off. It can
  hide repos or whole
  sources, set the default shared date range preset, and set per-repo color
  overrides in `localStorage`. It also stores the opt-in that keeps Commits
  detail on the newest visible row; the detail itself exposes the current
  following/pinned state and can resume following without returning to Settings.
  These preferences are a pre-filter or
  presentation choice before every contract-backed page (Board, Graph,
  Activity, Commits, Items, Reviews, Metrics) computes its view. They are view-only; the daemon keeps syncing every
  configured source. When the URL has no explicit `from` / `to`, new browsers
  default to `this week`, calculated from Sunday in the contract's configured
  `timezone` (default UTC).

The UI supports contract major v4. It warns when a different major is loaded.

## Docker Operation

The canonical store has one writer, `board`; `api` and `web` are read-only sidecars.
The Live receiver owns a separate `live.db` and never opens the canonical store.
SQLite and Postgres retain the same split. Deployment commands belong in
[Running Symphony Board](running.md#docker-continuous-runs); stack layouts,
ports, storage and cadence are in the
[runtime reference](runtime-control-reference.md#docker-operation).

## UI-Triggered Sync Control Plane

Manual and scheduled syncs share the writer daemon's run lock and runner; the UI
cannot become a second database writer. The capability and same-origin header
keep mutation separate from the read-only sidecars. See the
[operator path](running.md#manual-sync-from-the-ui) and
[control API reference](runtime-control-reference.md#ui-triggered-sync-control-plane)
for enablement, routes, run status and UI refresh behavior.

## Writer-Owned Config Control Plane

Config editing follows the same writer-owned boundary. Server-side validation is
authoritative, secret read routes return metadata only, and config changes apply
to the next run. Removing configuration changes the emitted projection while
retaining stored history; operational pause and purge are distinct. See
[operator setup](running.md#editing-sources-from-the-ui) and
[config API reference](runtime-control-reference.md#writer-owned-config-control-plane).

**Config stays JSON, not TOML.** Evaluated and rejected: TOML's human benefits
are comments and hand-formatting, but the UI write path would clobber both (no
mature comment-preserving TOML writer exists for JS), a parser/serializer would
add a runtime dependency solely for config, and after this control plane the
remaining hand-editors are the Docker path only. JSON is also exactly what a
machine-written, machine-validated document wants.

## Read-Only Diagnostics Surface

Operational diagnostics remain separate from the versioned work-item contract.
Store-backed diagnostics open the configured store read-only; logs belong to the
writer process's volatile ring buffer. See the
[diagnostic routes](runtime-control-reference.md#read-only-diagnostics-surface)
for capabilities, graph neighborhoods, store statistics, work discovery and logs.

## Commit File Stats

Commit rows carry their line TOTALS in the contract (`details.additions` /
`details.deletions`). The per-FILE breakdown is not on the row, and
deliberately so. It reaches a consumer two ways: on request for the one commit
a viewer opened, and as a per-repository aggregate the sync collects in the
background (see "The file pass" below).

**Why it is not a sweep field.** The totals are affordable on both providers:
GitHub answers up to 100 commits in one aliased GraphQL document, and GitLab
inlines them on the commit list feed (`with_stats`). Per-file counts have no
such batch. GitHub's GraphQL commit exposes no file list at all, so the only
source is one REST `repos/{o}/{n}/commits/{sha}` call per commit; GitLab serves
only a raw unified diff per commit, whose counts must be read off the hunks.
At the observed volume (~700 commits/week across ~25 repos) with a full sweep
every `FULL_EVERY` iterations, that is a different cost class from the sweep's
current one-call-per-100. Worse, it would not even be stable: an activity
upsert replaces `details` wholesale, so any sweep that skipped or capped the
enrichment would ERASE the breakdown an earlier sweep had stored.

**On request, for one commit.** `GET /api/commit-files?source_id&project_path&sha`
resolves ONE commit's per-file diffstat on request, served by the **writer**
(the `board` daemon or the standalone app server) because — like
`/api/token-rate-limits` — it needs config, token resolution, and outbound
provider access. nginx proxies it to `board` with one exact-match location. The
response is operational, not contract: it never enters raw, the canonical
store, or `contract.json`, so it carries no `contract_version` and needs no
bump.

| Route | Method | Served by | Purpose |
| --- | --- | --- | --- |
| `/api/commit-files` | GET | writer (`board` daemon / app server) | one commit's changed files with per-file `additions`/`deletions`, a total plus the `total_scope` it covers, and a `truncated` flag |

**Safety model.** The request names a source, a project path, and a sha. The
sha must be a FULL hex commit id (40 or 64 chars) because it reaches the
provider inside a URL path — and because an abbreviation would give one commit
dozens of distinct cache keys, each of them a real provider call. The project
must be one the deployment already tracks: the configured project list is the
allowlist, and it is checked on every request BEFORE the cache, so removing a
project or disabling a source stops the route answering for it immediately.
The project path reaches the provider inside a URL path as well, so it must be
plain segments: letters, digits, `_`, `.` and `-`. A segment never starts with
`-` and is never `.` or `..`, and there is no empty, encoded, query or
fragment part. A path that fails is a `400` before config is read. The provider
readers apply the same check, and GitHub's narrower owner rule, to any path
they are handed, a configured one included. A GitHub owner may hold `_`
(managed-user handles) but not `.`. They also encode every segment they send. Provider access stays read-only (GET).

One honest limit on that guarantee: GitHub resolves `commits/{sha}` within the
repository's whole fork network, so a caller who already knows such a sha can
read paths and counts for a commit the tracked repository itself never
contained. The allowlist bounds the repository *network* the route can reach,
not the exact commit set.

Every failure (unknown source, unconfigured project, no token, unsupported
provider, provider error, and a config the route could not load at all —
`config_error`) answers `200` with an `error` code from one exported union and
a message, so the block can say WHY the breakdown is missing; only a malformed
request is a `400`.

**Where it renders.** On wide screens the breakdown leads the Commits **digest
rail** as its first `rail-block`, not the detail pane (on phones it is the
reader's Files pane; at 761–1211px it renders alone in the compact
detail/files column): it is the only block there that
describes the ONE selected row rather than the whole range, and stacking a long
commit message and a long file list in one column pushed the files off the
bottom of the screen exactly when they were worth reading. The block reproduces
`git-scope commit` — the directory tree first (where the change landed), then
one row per file as `[M] path  +40 -0`, then the total.

**Cost and caching.** One provider call per commit the pane shows when the
viewer has turned the Settings toggle on
(`symphony-board:commit-file-stats`, OFF by default). An explicit phone or
compact detail also fetches that commit's files, including follow mode, without changing the
setting. With *Follow latest commit* and file stats both on, the pane follows a
newer head and asks for that commit too; both switches are off by default and
independent.

A commit's diff is immutable, so a SUCCESS is cached in the server process by
`(source, project, sha)` with a bounded size and no TTL. A provider FAILURE is
cached briefly (one minute) as well — otherwise a loop over distinct well-formed
shas converts one request into one provider call indefinitely — while
config-derived refusals are never cached, because config is what they are
recomputed from. Concurrent identical requests share one in-flight resolution
rather than racing to spend two calls.

GitHub caps its file list at 300 entries and GitLab's diff feed is paged; both
report `truncated: true`. Under truncation `total_scope` says what the total
covers: GitHub still reports the whole commit, GitLab only the listed files.

A deployment that does not serve the route answers either a `404` (an older
build, the read-only `api` sidecar) or, on a static SPA host, its `index.html`;
both are reported to the viewer as "this server does not serve per-file stats"
rather than as a malformed response.

### The file pass

A range of commits can only be aggregated from stored data, so the sync also
collects file lists — as its own pass, not as part of the sweep, which is what
the two objections above require.

- **Its own table.** `commit_files` (migration 0013 on both drivers) holds one
  row per commit activity the pass has an answer for, keyed by the activity's
  `(source_id, external_id)`. An activity upsert never touches it, so nothing a
  later sweep does can erase it. Rows enter the usual way: the source returns a
  `commit_files` raw record, `normalize` turns it into a canonical row, and the
  store keeps both. The raw record has an external id of its own
  (`commit_files:<activity id>`) and names the activity in its payload: `raw`
  holds one payload per `(source_id, external_id)` whatever the entity kind, so
  sharing the commit's id would replace the commit's own raw record.
- **A queue, not a sweep.** After each source's sweep commits, the engine asks
  the store for recent commit rows with no answer (`listCommitFileCandidates`:
  newest first, within a one-year lookback) and hands at most
  `commit_files_per_sweep` of them (default 50, `0` turns the pass off) to the
  source's `fetchCommitFiles`. New work is therefore covered first and history
  fills in over later sweeps; the cost per sweep is bounded by configuration,
  not by how much history there is.
- **Every queued commit gets an answer.** A file list (`ok`); a note that the
  commit cannot be read (`unavailable`: a 404 / 410 / 422, a repository that is
  no longer configured, or a commit that failed on its own — see the next
  point); or a note that the commit is a merge (`merge`, recorded without a
  request, because a merge's diff is against its first parent). Without the
  last two the same rows would come back every sweep and starve the rest. An
  answer is final: an `unavailable` commit is not asked for again.
- **One bad commit does not stall the queue.** A failed request is about the
  token (401, 429, or a rate-limit response), about that commit (a diff the
  provider cannot render, a repository the token may not read), or about the
  provider being down — and the last two look the same from one response. A
  token failure stops the pass at once. Any other failure sets the commit
  aside and the pass goes on; the commits set aside are answered `unavailable`
  only when the provider answered some other commit in the same pass (and a
  warning names how many). When
  nothing was answered, nothing is recorded, and the pass gives up after eight
  failures. Without this a commit that always fails would head the
  newest-first queue every sweep and keep every older commit of the source
  from being read.
- **Never the sweep's problem.** A stopped pass leaves the unanswered commits
  queued. It is reported on its own
  (`SyncReport.commitFiles` / `commitFilesError`, and a separate log line) and
  never changes the sweep's status: marking a sweep incomplete over a
  decoration would block the soft-delete pass that only a complete sweep may
  run. A dry run does not run it.
- **No patch text.** The readers (`src/sources/commit-files.ts`, shared with the
  on-demand route) keep path, status and line counts. GitLab's diff text is
  counted and dropped; GitHub's `patch` field is never read.

The contract projects these rows as `commit_file_stats` (4.9.0): per
repository, coverage plus the most-changed files and directories of the
emitted commit window, each with the sha prefixes of the commits that touched
it. It is an aggregate because per-commit file lists on `activities[]` would
multiply the payload; see `docs/CONTRACT.md`, Commit File Stats. The key is
left out when the deployment collects nothing — no enabled source runs the
pass and the store holds no file rows for the window — so a consumer can tell
"not collected" from "not reached yet".

## Live Event Stream (Realtime)

A second, **independent** pipeline provides realtime "Live" activity, parallel to
and separate from `raw → canonical DB → contract.json`:

    GitHub org webhook → signature-verified delivery → dedicated append-only
    live-event store → provider-neutral `live-event/1` record → snapshot + SSE
    → contract-independent Live UI page

It shares nothing with the canonical pipeline but the `source_id` vocabulary. It
does **not** touch `contract.json`, the contract schema, the canonical store, the
sync engine, or the Activity tab. The live feed is **freshness, not the system of
record**: the periodic full/incremental sync remains the authoritative
reconciliation/backstop, and because GitHub does not auto-retry failed deliveries
the feed may have gaps (receiver downtime). The UI labels it a best-effort live
feed and points to the board as the source of truth.

### Trust boundary change

This subsystem introduces the product's **first public-internet ingress**.
Previously every surface was tailnet-only (UI + read-only APIs behind `tailscale
serve`) and read-only toward providers. The Live receiver keeps the
read-only-toward-providers guarantee (it never writes issues/PRs back) but adds
exactly one inbound public route:

The split is enforced **in-app by two listeners** that share one store +
broadcaster but expose disjoint routes (`src/live/receiver.ts`), so the
public/tailnet boundary does not depend on out-of-repo proxy config alone:

- **Public HTTPS ingress — the webhook listener:** `POST /webhooks/<provider>`
  (+ `/healthz`) on its own port, authenticated by the provider HMAC over the raw
  bytes (constant-time compare, no permissive fallback, dual-secret rotation).
  This listener serves **no** read routes, so the compose `live` service publishes
  only this port to the host. The public ingress should target this listener
  directly, so even exposing the whole listener port cannot reach the event
  stream. Earlier drafts path-scoped a shared port; that was both a router
  trailing-slash footgun and a single-point reliance on proxy config, so the
  listener split supersedes it. The concrete public-ingress mechanism belongs
  in the deployment repo or operator runbook, not in this public app repo.
- **Private network only — the reads listener:** `GET /api/live` (SSE)
  and `GET /api/live-snapshot` (+ `/healthz`) on a separate port, reachable only
  by the `web` nginx sidecar over the compose network (`proxy_buffering off`). v1
  relies on the tailnet boundary for SSE authz, as the rest of the UI does. The
  default `web` host port is loopback-only; tailnet exposure is host-level
  `tailscale serve`. The webhook listener also applies request/headers timeouts
  and a connection cap to bound an unauthenticated POST flood, and the SSE
  broadcaster evicts a subscriber whose buffer backs up past a cap (so one slow
  reader cannot grow receiver memory without bound).
- **Read-side setup diagnostics:** `GET /api/capabilities` is served by the
  read-only API/app-server surface the UI already uses. In Docker it may probe
  the internal Live reads listener (`http://live:8090`) and return current
  `unsupported` / `unreachable` / `empty` / `ready` state, latest sequence/time,
  and optional deployment-provided webhook setup hints. It never proxies
  `/webhooks/*`, never talks to providers, and never returns secrets.

### Least-privilege receiver

The receiver (`live` service / `src/cli/live-receiver.ts`) holds **only** its own
`live.db` and the webhook secret (by env-var name). It has **no** canonical store
handle, **no** provider token, **no** config mount, and **no** Docker socket; it
never acquires the canonical writer lease, soft-deletes, or mutates canonical
data. It is the single writer of its own store, honoring "one writer per store"
without introducing a second writer to the *canonical* store. The container runs
with a read-only rootfs, all capabilities dropped, and bounded resources, and its
host port is loopback-only.

### Live-event store and retention

The live store is a dedicated SQLite database, independent of the canonical
store's driver — it is append-only, low value to replicate, and stays out of the
`Store` interface, the `store-conformance` suite, and the Postgres compose gates.
It dedupes on `(source_id, event_id, ordinal)` (so one delivery may yield
multiple rows — a GitHub `push` fans out to one row per commit — while a
redelivery is a no-op) and
assigns a monotonic `seq` used as the SSE `id:` / `Last-Event-ID` cursor. It
retains the full neutral record plus body, delivery metadata, and the raw payload
with secret-bearing fields scrubbed, bounded by a TTL (~30 days) and a row cap
that also bound the SSE replay backlog. The webhook secret is never persisted or
logged. The store also owns a small GitHub actor-profile metadata cache that
enriches Live rows with `avatar_url` / `profile_url` at read time. The cache
stores provider profile URLs and expiry/error metadata only; it does **not**
download or persist avatar image bytes, and it does not rewrite append-only
live-event rows. Post-ack profile enrichments are emitted as id-less
`event: live-update` SSE frames carrying a full `live-event/1` payload; clients
merge them by `seq` without advancing or regressing the `Last-Event-ID` cursor.

### Adapter interface

A pure, network-free `WebhookProvider` adapter per provider (mirroring the
pure-`normalize` discipline) keeps the receiver provider-agnostic and replayable
against captured payloads. Most events map one-to-one to a neutral record; a
`push` is the exception — it fans out to one `category: "commit"` record per
commit (`target.kind: "commit"`, `external_id` = the commit SHA, no issue/PR
number, attributed to the commit author), so commit-only repos surface in the
live feed and not just the periodic canonical sync. GitHub ships first; a GitLab adapter is designed
against the same interface but stubbed — enabling it is gated on company
clearance to mirror private GitLab content off-host, and would also revisit
per-client SSE authz / per-source visibility filtering. GitHub actor profile
lookups stay outside the pure adapter: the receiver observes already-appended
events, seeds the cache from webhook payload avatars, and performs bounded
best-effort public GitHub user lookups for missing avatars after the webhook has
been acknowledged.

### Live coverage (allowlist + webhook)

A repo's events reach the live feed only when **two independent gates** are both
satisfied:

- **Allowlisted.** The receiver takes an optional project allowlist
  (`projectAllowlist`). An empty allowlist accepts every delivery; a **non-empty
  one is fail-closed** — an event whose `target.project_path` is not listed is
  dropped before persist. This bounds a webhook that fans in many repos (an org
  or multi-repo hook) to the intended scope, and is expected to be derived from
  the same source-of-truth that defines the tracked repos, so the live scope and
  the canonical-sync scope stay aligned.
- **Delivering.** Something must actually POST that repo's events to the receiver
  with a valid signature — a per-repo, org, or App webhook — subscribed to the
  event types of interest (issue / PR / review / comment, plus `push` for
  commits).

The gates are independent, which makes the two failure modes explicit: an
allowlisted repo with no webhook is **silent in Live** (it still appears in the
periodic canonical sync / Activity), while a delivering repo that is not
allowlisted is **dropped**. Adding a repo to Live therefore means doing both —
allowlisting it and pointing a webhook at the receiver. The exact mechanics are
deployment-specific by design: the receiver reads only the webhook secret and the
allowlist, by env-var name, and never holds a provider token or config mount.

## Runtime Decisions

- **Node 24 with type stripping**: backend has no build step.
- **`node:sqlite`**: accepted despite its experimental warning in Node 24.
- **SQLite WAL**: lets readers inspect while the single writer runs.
- **Persistence behind an async `Store` interface** (`src/db/store.ts`): call
  sites never touch a database handle; the SQLite driver (`src/db/sqlite.ts`)
  owns its dialect SQL, DDL (`schema/sqlite/*.sql`), and migrations. Every
  method is async so a future driver (Postgres) drops in without changing the
  interface; `test/store-conformance.test.ts` — run against every registered
  driver — is the swap guarantee. Hand-rolled by design: the query surface is
  around two dozen statements and postgres.js has zero transitive dependencies,
  so an ORM or query builder would abstract the wrong layer. Activity ordering is by instant
  (occurred_at keeps provider-local UTC offsets), which each driver implements
  in its own SQL (SQLite: `julianday`).
- **Writer lease on the Store (#164)**: "exactly one sync writer per store" is
  a database-enforced invariant, not a deployment convention. The runner
  try-acquires `Store.acquireWriterLease()` before every non-dry run and skips
  the run (`status: "skipped"`, benign) when another live writer holds it; a
  dry-run runs leaseless. Each driver implements the lease with its engine's
  session-scoped locking so a dead holder auto-releases without TTL machinery —
  SQLite holds `BEGIN EXCLUSIVE` on a sibling `<db>-lease` lock database over a
  dedicated connection (cross-process via file locks, incl. container/host on a
  bind mount); a Postgres driver uses `pg_try_advisory_lock` on its own
  connection. The conformance suite makes lease exclusivity a per-driver
  obligation.
- **PgStore (#167)**: the Postgres driver (`src/db/postgres.ts`, postgres.js —
  zero transitive dependencies; DDL under `schema/postgres/`) implements the
  same `Store`, selected by config: `db_path` keeps meaning SQLite, an optional
  `db_url_env` (the NAME of an env var carrying a `postgres://` URL, matching
  the token-by-env-var-name rule) selects Postgres via `src/db/factory.ts`,
  which loads the driver lazily so SQLite deployments never resolve the
  dependency. The backend Docker image installs the root production dependency
  set so an opt-in pg compose deployment can resolve postgres.js at runtime.
  Driver-owned dialect: schema version in the `meta` table,
  order-by-instant via `::timestamptz`, real BOOLEANs, a GREATEST-monotonic
  watermark (an interleaved older run can never regress it), and the writer
  lease as `pg_try_advisory_lock` on a reserved connection keyed by
  `current_schema()`. Gate: the conformance suite with the pg driver
  registered plus a live e2e (`pnpm run test:pg-e2e` — Docker Postgres from
  zero through migrate → full sync → incremental → disappearance sweep →
  contract emit → lease refusal → crash auto-release; the CI `pg` job).
  `docker/compose.pg.yaml` is the deployment smoke surface for the same driver:
  it starts a real postgres/board/api/web stack and verifies the served contract
  plus `/api/stats` reporting `driver: "postgres"`. The read-only surfaces
  (#170) select the driver through `openConfiguredStoreReadOnly`: `range.ts` /
  `stats.ts` open whichever store the config means, and
  `openPostgresStoreReadOnly` pins the session read-only
  (`default_transaction_read_only = on`), never migrates, and refuses an
  older-than-expected schema — mirroring the SQLite read-only open.
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
  with `Intl.DateTimeFormat` (DST-aware, dependency-free); the implementation lives in
  dependency-free `shared/time.ts`, with adapters in `src/lib/tz.ts`
  (producer) and `packages/ui/src/tz.ts` (consumer). The contract package
  remains type-only at runtime; Docker and standalone resources include the
  neutral shared module. Absolute
  instants (`generated_at`, `updated_at`, `occurred_at`) stay UTC ISO-8601 —
  only calendar-day bucketing honors the zone.
- **Provider links**: `shared/provider-links.ts` owns pure GitHub/GitLab URL
  construction for the producer and UI, including configured self-hosted
  provider instances. Exact emitted permalinks take precedence over reconstructed
  URLs. The UI's shared `ExternalLink` / `EntityLink` components apply safe web
  URLs, new-tab attributes, consistent styling, and independent row selection;
  the existing Tauri runtime adapter opens web links in the external browser.
  Sources are resolved from the contract's configured `kind` and `host`; Live
  can use its explicit provider-instance `source_id` before a contract loads.
  Repo Analytics and other count controls keep hash routes for internal
  drilldowns. Aggregate names spanning multiple repositories or accounts offer
  qualified destinations. Missing identities and name-only commit authors stay
  unlinked rather than guessing a profile; reviews and comments require exact
  permalinks. No provider fetch or write is needed to build a link.
- **The selected range is what the client downloads (#488)**: the shared
  date-range control is the single source of truth for the primary contract the
  client fetches — picking a range loads `/api/range` for exactly that window AS
  the primary env (driving Diagnostics DECODED / TRANSFER / COMPRESSION), instead
  of a separate buried "Board data" scope deciding the download while the visible
  range only drove a display overlay. The static `./contract.json` is no longer a
  fixed 90-day "Full board" the range picker cannot escape; it becomes a
  **fast-path** for one specific range. Rationale and tradeoffs:
  - **The default download follows the displayed range.** The view opens on the
    viewer's default range preset (`this week` unless changed), and that small
    window is what the client fetches — so the common load is a small dynamic
    `/api/range`, NOT the 90-day contract. Narrowing or widening the range
    re-fetches the primary env for exactly that window; there is no longer a
    second, larger primary loaded behind the view.
  - **Static fast-path**: the static, pre-gzipped, mtime-cached `./contract.json`
    is loaded only when the selected range equals the emitted default window (the
    trailing `CONTRACT_ITEM_WINDOW_DAYS` = 90 days ending at ~now) — and on the
    static/demo deploy, and as the cold-start cache seed. It is no longer the
    common path. Measured, that static 90-day file is ~20% smaller and compresses
    better (≈10.3x vs ≈8.6x) than the dynamic 90-day `/api/range` projection
    (which carries extra graph-edge / endpoint-closure rows), so keeping the
    fast-path for the exact-90d case is still worthwhile.
  - **Device landing + hard ceiling** (the repurposed board scope, still
    device-local): the view opens on the device landing window (the viewer's
    preset on desktop/web; 7 days on the Android thin client) and the range picker
    is capped by a device ceiling — 1 year on desktop/web, **30 days** on Android.
    The Android cap is the weak-device guard: the e-ink tablet cannot
    gunzip + IPC-marshal + parse a multi-MB payload without OOM (the same reason
    `CONTRACT_REQUEST_TIMEOUT_MS_ANDROID` exists), so it must never be able to
    request a year of data.
  - **Cold-start paint**: because the default load is now a small dynamic
    `/api/range` rather than the cached 90-day file, the per-server cold-start
    cache keys its saved env by the loaded range, so a revisit still paints the
    last landing window instantly while it revalidates — preserving the
    instant-paint behavior (and the Android weak-link cold-start) the cached
    full contract used to provide.
  - **Bounded maximum**: the widest selectable range is 1 year (~19.5 MiB / ~2.3
    MiB gzip). There is no unbounded "all history" option, so the payload cannot
    grow without limit as history accumulates; 1 year is effectively all data
    (the 180d→365d byte delta is small).
  - **Wide context is preserved**: a `/api/range` envelope already carries
    board-wide `aggregates`, the full `repo_stats` inventory, and all `sources`
    (only `items` / `edges` / `activities` / `activity_daily` / `repo_metrics`
    are range-scoped), and the trailing-12-month Activity Overview reads the
    separate `/api/activity-daily` aggregate — so making the primary env
    range-scoped loses no cross-window context.
  - **Static / demo deploy**: a server-less deployment (the Pages demo) 404s
    `/api/range`, so the range picker is locked to the emitted snapshot and the
    bundled `./contract.json` is served as-is — the demo is a fixed snapshot.
  - **Transfer measurement (#488 / PR #489)**: `sendJsonMaybeGzip` advertises the
    exact compressed size via an `X-Encoded-Length` header (a custom header
    survives gzip decoding, unlike `Content-Length`), so Diagnostics TRANSFER /
    COMPRESSION are correct for the now-primary `/api/range` payload. No contract
    version bump: `range_query` already exists and `items` / `edges` /
    `activities` were already windowed.

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
