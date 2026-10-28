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
rejections and HTTP 502/503/504 responses: two retries after 2 and 6 s
(`SYNC_TRANSIENT_RETRY_DELAYS_MS` overrides the delays but never adds retries),
with at most three attempts per request. GitHub GraphQL also gives a 2xx whose
body is not JSON (an error page or a truncated body) a retry from the same
three-attempt budget, shared with gateway statuses: that and a gateway
status are GitHub's symptoms of a query that timed out server-side, which an
immediate retry usually repeats. This applies to full and incremental sweeps and
repeats the failed request rather than restarting project pagination. In a full
sweep, an issue or pull-request page that still fails with one of those
heavy-query symptoms is retried once from the same cursor at half the page size,
and the rest of that repository continues at the smaller size. The sweep's
reach is bounded by records (4000 per connection), not pages, so the smaller
size covers the same items; a sweep stopped at that cap with pages left is
partial. Exhaustion still makes coverage partial; successful sibling records
remain available. Request timeouts, auth failures, rate limits and other
provider/application errors retain their existing behavior and never trigger
the half-size retry, as do GitLab requests.

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

Current major: v4. Current emitted version: `4.11.0`, declared by
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

Per-page behavior (Live, Board, Graph, Activity, Items, Commits, Reviews,
Metrics and Settings) lives in the [UI pages reference](ui-pages-reference.md).

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
multiply the payload; see [Commit File Stats](contract-activities-reference.md#commit-file-stats). The key is
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
  Stored rows carry the raw provider payload (tens of KB each), so the read
  routes are also bounded by bytes, not only row count (#851). A snapshot page
  stops at its row `limit` or a byte budget (8 MiB of stored row data; always at
  least one row, so a client makes progress) and reports `truncated` plus
  `next_before`, the `seq` of its oldest row when more matching rows exist.
  Pages stay newest-first; a client continues with `before=<next_before>` (also
  combinable with `since`), so a capped page is never mistaken for "no more
  rows". The UI's snapshot client folds those older pages under the original
  `since` before the poll cursor advances to `max_seq`, so no row newer than the
  cursor is skipped (a failed page fails the whole fetch and the next poll
  retries the same range). Row sizes are read from the record header
  (`octet_length` of the bare columns), not by loading payloads. A SSE resume
  whose backlog fits the row bound but not the replay byte budget (2 MiB) sends
  the in-order prefix through a short-lived registered subscriber (so response
  errors are handled like any other subscriber's) and closes; `EventSource`
  reconnects with `Last-Event-ID` and continues losslessly. `/api/live-status`
  reads only the newest `received_at`, never a full row.
- **Ingestion freshness:** the reads listener also serves
  `GET /api/live-status`. It returns raw, in-memory webhook stats: the last
  accepted and rejected delivery instants, the last rejected status and its
  class, and counts over a rolling one-hour window. It also returns the store's
  newest `received_at`, the receiver's `started_at`, and the `sources` its
  webhook routes are wired to; the stats reset when the receiver restarts. A
  non-2xx response counts as a rejected delivery only when the request carried
  the provider's delivery id. That header is caller-controlled and checked
  before the signature, so rejection counts are diagnostics only. The receiver cannot see the canonical store,
  so the lag comparison lives in the read-only API: `GET /api/ingest-freshness`
  measures how far the sync loop's newest polled GitHub activity runs ahead of
  Live's newest ingest. That activity is restricted to the receiver's declared
  `sources` (github.com when an older receiver declares none) and to the Live
  allowlist. The
  sync loop keeps polling when webhooks fail, so lag grows only while there is
  activity Live missed, and quiet hours stay healthy. The route always returns
  the raw values. With `?max_lag_seconds=<n>` it adds a verdict and answers
  `503` when Live is unreachable or the lag exceeds `n`. When the lag is
  exceeded and the window holds only rejected deliveries, it also reports
  `only_rejected_deliveries` as the likely cause. Rejections never decide
  health on their own, because unauthenticated requests can fabricate them. A
  status-code-only monitor can therefore probe the route while the threshold
  stays with the deployment.
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
