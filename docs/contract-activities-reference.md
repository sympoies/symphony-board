# Contract activities reference

Field-level rules for the activity side of the emitted contract: `activities[]`, top-level `review_threads[]`, `actor_directory`, `commit_file_stats` and `activity_daily`, with the version notes that changed them. [CONTRACT.md](CONTRACT.md) owns the version index, the envelope, the compatibility rules and every other section, and its Activities, Commit File Stats and Activity Daily sections link here.

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
  immutable id. Comment rows carry it too from `4.9.1` (see below).
- `title`: optional display title. Rows about an issue or change request carry
  that item's title; a comment row whose producer stored none carries its
  target's title from `4.9.1`.
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
  alphabetical). A commit may also carry `details.additions` /
  `details.deletions`, its line counts as whole non-negative numbers. They are
  present as a PAIR or not at all, and are absent — never zero — whenever the
  producer could not read them, which consumers must render as "unknown"
  rather than "no change". They are also absent for every MERGE commit by
  design: a provider reports a merge's counts against its first parent, so a
  consumer summing a range would count the merged branch's work twice.
  A commit with more than one parent carries `details.merge: true`; the key is
  absent on every other commit, so it is what tells a merge from a commit whose
  counts could not be read. A commit row may also carry
  `details.default_branch`, the name of the repository's default branch as the
  sweep that stored the commit read it. `details.branch` alone cannot say this:
  a commit that lives only on a side branch reports that side branch there.
  A commit row may also carry `details.change_request`, the change request
  (PR/MR) the commit belongs to: `{ "ref": "<source_id>|<external_id>", "iid":
  <number> }` when the producer found one, `null` when it looked and there is
  none, and absent when it could not look. `ref` is the item's immutable
  identity, the same string as `items[].id`; `iid` is the mutable number for
  display. The item is not guaranteed to be in `items[]`.

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

Supported provider events may also carry `details.actor_avatar_url`, an absolute
HTTP(S) image URL reported for that event's actor. GitLab project events and
GitHub repository events supply it when their author account and activity actor
match; account-linked GitHub commits can supply it too. Older rows, anonymous
commits, and providers without an actor photo omit the key. The UI resolves the
photo through `actor_directory` for ranked Activity and Commits authors and
falls back to review-comment photos or initials. This optional detail key uses
the existing open `details` object and is documented in version `4.7.2`.

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
`reviews` / `approvals` repo metrics (see [Repo Metrics](contract-repo-metrics-reference.md#repo-metrics)):

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

- GitHub: `PullRequest.reviewThreads.isResolved`. The source paginates the
  connection to completion; `total` is its `totalCount` and `open` counts all
  unresolved thread nodes. A failed or safety-capped continuation keeps the
  source sweep partial instead of emitting a misleading count or tombstoning
  unseen threads.
- GitLab: `MergeRequest.resolvableDiscussionsCount` (=`total`) minus
  `resolvedDiscussionsCount` (=`open`), exact scalar aggregates with no
  node-walk. GitLab's `review` activity is approval-based, so this is the only
  thread-resolution signal on the GitLab side.

The window-scoped `unresolved_review_threads` repo metric sums `review_threads.open`
across active change_requests (see [Repo Metrics](contract-repo-metrics-reference.md#repo-metrics)).

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

Version `4.9.1` is a clarification + producer-behavior patch: comment rows now
name the issue or change request they are on, and a range response emits the
item every in-range row names. No field was added, and `target_ref` and `title`
were already nullable, so no shape changed.

- GitLab names the item in `normalize`, from the identity the events API
  reports: `note.noteable_id` for a comment, `target_id` for an issue or merge
  request event. That is the database id a GraphQL global id is built from, so
  the row's `target_ref` is `<source_id>|gid://gitlab/MergeRequest/<id>` (or
  `Issue`), the same string the item row carries. A commit comment and a push
  name no item. `target_kind` keeps its value (`comment` on a GitLab note).
  Rows stored before `gitlab/13` gain the ref when a sweep re-reads them.
- A GitHub REST comment carries no node id for the issue or pull request it is
  on. `emit` resolves a row that has no `target_ref` but a `target_kind` of
  `issue` or `change_request`, a repository, and a number against the live item
  with the same source, repository, kind and number, and emits that item's
  immutable ref. The number only finds the item; the emitted identity is still
  `source_id|external_id`. When the repository was renamed after the row was
  stored, the item is not live, or two live items share the number, the row
  keeps `null`. This applies to every stored row at once, since nothing is
  re-read.
- A row with a target and no stored title carries the target's title, the way
  review rows already carry their pull request's.
- `buildRangeContract` adds the item any in-range row names in `target_ref` to
  `items[]` with `window_reasons: ["activity_target"]`. Before `4.9.1` only a
  review's target was added, plus (4.8.2) a commit's change request.

No comment text enters the contract. A consumer that wants a comment's words
reads them where the contract already carries them: a GitHub review comment's
`details.node_id`, or the `#note_<id>` anchor of a GitLab comment's `url`,
matches a `review_threads[].comments[].id`.

Version `4.8.2` is a clarification + producer-behavior patch: commit activity
rows may now carry `details.change_request`, and a range response emits the
change requests its in-range commits name. `details` was already an open
object, the key is optional, and `activity_target` was already an
`items[].window_reasons` value, so no shape changed.

The key has three states on purpose. An object names the change request. `null`
means the producer looked the commit up and it belongs to none — a fact a
consumer can count ("landed without a change request"). Absent means the
producer has no answer: a row stored before `4.8.2`, a lookup that failed, or a
provider that cannot resolve that commit. A consumer must not read absent as
`null`.

What each provider can answer differs, and the difference is in the states
above rather than hidden:

- GitHub can answer for any commit. The association rides in the GraphQL
  document the sweep already sends for line counts, merges included, so it
  costs no extra request. Only a pull request of the commit's own repository is
  accepted; when several match, the one whose merge commit is this commit wins,
  then a merged one. A GitHub row whose lookup succeeded therefore carries an
  object or `null`; it carries nothing when the lookup failed, or when the
  commit has more pull requests than the three that are read and none of those
  read is the repository's own. Pull requests of other repositories in the
  fork network are not stored.
  GitHub's answer is about the repository as it is now: history imported from
  another repository reports `null` for commits whose pull requests lived there.
- GitLab has no batch that resolves a commit, and one request per commit is a
  different cost class. One merged-merge-request listing per project per sweep,
  bounded to a day before the oldest default-branch commit being stored, links
  the commits a merge request LANDED as: its merge commit, its squash commit,
  and its head. A GitLab row therefore carries an object or nothing, never
  `null`. A commit inside a merge-commit merge is unknown, not unlinked, and so
  is a commit landed by a merge request into another branch when it is older
  than that bound.

The lookup is best effort: a failure leaves the key absent and never marks the
sweep incomplete. An activity upsert replaces `details`, so a later sweep whose
lookup failed removes a link an earlier one stored until the commit is re-read.

`buildRangeContract` adds the change request items that in-range commit rows
name to `items[]` with `window_reasons: ["activity_target"]`, the same support
role a reviewed change request already has, and counts them in
`item_window.activity_target_items`. Like any emitted change request, these
rows bring their `review_threads[]` with them. The static contract is
unchanged: its 90-day item window already spans its 30-day activity window.

Version `4.8.1` is a clarification release: commit activity rows may now carry
`details.merge` and `details.default_branch`. `details` was already an open
object and every key in it was already optional, so no row shape changed and no
consumer breaks.

`details.merge` is `true` for a commit with more than one parent and absent
otherwise — never `false`. It exists because a merge carries no line counts by
design, which left it indistinguishable from a commit whose counts the producer
could not read; a consumer can now say "merge" instead of "unknown", count
merges, or leave them out.

`details.default_branch` is the repository's default branch name. A commit is
on the default branch when that name is in its branch membership
(`details.branch` / `details.branches`); when the key is absent the answer is
unknown, not "on a side branch". The value is the one the storing sweep read,
so a repository that renames its default branch reports the new name only on
rows a later sweep re-reads.

Both come from the stored raw payload, so neither costs a provider request.
There is no backfill: a row gains them when a sweep re-reads its commit. Until
then a row stored before `4.8.1` has neither key, so on such a row the absence
of `details.merge` does not prove a single-parent commit. Branch membership is
likewise as of the last sweep that read the commit: a side-branch commit later
merged into the default branch reports the default branch only once re-read.

Version `4.7.2` is a clarification release: supported activity rows may carry
`details.actor_avatar_url` for the matching provider account's photo. `details`
was already an open object, so the row shape and required fields are unchanged.

Version `4.7.1` is a clarification release: commit activity rows may now carry
`details.additions` / `details.deletions`, the commit's line counts. `details`
was already an open object and every key in it was already optional, so no row
shape changed and no consumer breaks.

They are emitted as a pair or not at all. Absent means the producer could not
read them — a provider call that failed, a commit stored before this existed,
or one past a per-sweep enrichment bound — which is NOT the same as a commit
that changed nothing, so a consumer must render an absent pair as unknown
rather than as `0`. There is no backfill: stored raw payloads predating this do
not contain the counts, and `normalize` is pure, so those rows gain them only
when a later full sweep re-reads the commit.

MERGE commits never carry them. Both providers report a merge's counts as the
diff against its FIRST parent, so a consumer summing a range would count the
merged branch's work twice — once in its own commits and again in the merge.
Producers skip the lookup for merges and drop the counts on replay even when a
stored payload has them.

Version `4.7.0` is additive: the envelope may carry an optional
`actor_directory`, which resolves every distinct non-empty `activities[].actor`
string to a canonical identity and flags CI/dependency accounts:

```jsonc
"actor_directory": {
  "identities": [
    { "name": "terrylin", "actors": ["Terry LIN", "Terry LIN 林品澄", "terrylin"], "bot": false },
    { "name": "dependabot[bot]", "actors": ["dependabot[bot]"], "bot": true }
  ]
}
```

It exists because the identity merge and bot filter described above were
reachable only through `repo_metrics[].top_actors`, which is keyed on the
DB-stored `actor_key` — a value that never reaches `ActivityDTO`. A consumer
ranking the raw activity feed (the Commits and Activity rails) therefore had no
way to apply either, and rendered one person as several rows with CI accounts
among them. The directory publishes that resolution against the only key a feed
consumer holds: the raw `actor` display string.

It is built from the same pieces `top_actors` uses — the stored `actor_key` as
the grouping, the config identity matchers, the deterministic display-name
choice, and the auto-bot / `exclude_actors[]` verdict — so the two surfaces
cannot drift into disagreeing about who someone is. Because the grouping is the
`actor_key` and not the display string, the ordinary case of one person whose
commits carry two spellings of their name merges here with **no config at all**:
both already share an `email:<hash>` key. Config `identities[]` remain what
bridges DIFFERENT keys — a provider username and an account-less commit email.

`bot` is `true` when the identity's key is an auto-detected service account (a
GitHub `[bot]` login suffix, a GitLab `project_`/`group_<id>_bot_…` username)
or an `exclude_actors[]` pattern matches it. A config identity is a declared
human, so a merged identity is a bot only when EVERY facet in it is bot-marked.
As in `top_actors`, a bot is hidden from rankings only; its rows still count in
any total computed over the feed.

`actors[]` is the identity's addressable set, not a closed set over the feed: it
is every raw `activities[].actor` value that resolves to the identity PLUS
`name` itself, and a config-supplied name may never appear in `activities[]`.
Every name published is a real display string — the producer only ever records
non-empty actor values, so an opaque `email:<hash>` / `provider-user:` key is
never emitted as a name.

One raw actor string resolves to **at most one** identity, because that string
is the only key a feed consumer holds. Grouping is the stored `actor_key`, and
two keys can surface the same string, so that does not come for free.

The producer does **not** guess that two keys are one person. A shared display
string is not evidence of identity: it is ambiguous between one account seen
twice and a string several people use — a build account, `root`, `Ubuntu`, a
default git author name — and no rule local to the producer separates them. So
an identity is joined only from what is already known:

- the stored `actor_key`, which is the grouping; and
- the config `identities[]` map, which is the operator saying explicitly that
  several keys are one human.

A string held by more than one identity after that is **contested** and is
published under none of them; a consumer ranks it on its own. The single
exception is a string that is exactly one declared identity's `name`, since
naming that person is an explicit operator statement. An identity whose every
string was contested has nothing a consumer could address it by and is not
published at all.

The cost is deliberate under-merging: a person whose facets the config does not
join appears once per facet, and the remedy is exact — add the address or
username to their `identities[]` entry, which merges the keys before any of
this runs. The alternative is worse and was tried twice: joining on any shared
string collapsed several declared people who each committed once as `root` into
one entry, and requiring nested name sets still swallowed whoever was seen only
under the shared string. Misattributing one person's commits to another is
invisible in the UI and unfixable by the operator; an unmerged row is neither.

Two config identities declared under the SAME `name`, each observed only under
that string, therefore publish neither: the string is contested between two
people the operator declared distinct, so it belongs to neither and neither has
anything left to be addressed by. Their rows rank under the raw string, which is
what makes the duplicate-name configuration visible.

One join is not a guess and is applied: a group whose key exists **only** because
its rows carried no stored `actor_key` (rows predating the column's backfill)
has no identity evidence of its own, so it folds into the single stored identity
carrying the same display string, contributing its bot marker. If several stored
identities carry that string, nothing is folded and the string is contested as
above. Without this, a service account's unmigrated rows sit beside their
migrated twin as a second, unflagged entry and the account ranks as a person.

Entries are sorted by name and each `actors[]` is sorted, so an unchanged data
set emits an identical directory. Old payloads without the field remain valid; a
consumer reads it as `env.actor_directory` and falls back to ranking raw
`actor` strings.

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

## Commit File Stats

Version `4.9.0` is additive: the envelope may carry an optional
`commit_file_stats`, which says per repository which files and directories the
emitted commit rows changed most.

```jsonc
"commit_file_stats": {
  "repos": [
    {
      "source_id": "github:github.com",
      "project_path": "acme/api",
      "commits": 120,      // non-merge commit rows of this repo in activities[]
      "scanned": 96,       // of those, how many have a file list
      "truncated": 1,      // scanned commits whose file list the provider capped
      "files": 210,        // distinct paths the scanned commits touched
      "top_files": [
        { "path": "src/sync-engine.ts", "commits": 12, "additions": 300, "deletions": 120,
          "authors": 3, "shas": ["0a1b2c3d4e5f", "…"] }
      ],
      "top_dirs": [
        { "path": "src/sources/", "commits": 31, "additions": 1900, "deletions": 640,
          "authors": 4, "shas": ["0a1b2c3d4e5f", "…"] }
      ]
    }
  ]
}
```

It is an aggregate rather than a file list on each `activities[]` row because
the row form would multiply the payload and the question a consumer asks of it
is "what changed most in this window". The window is the emitted
`activities[]`: the trailing 30 days for the static contract, the requested
range for `/api/range`.

- `repos[]` holds one entry per repository with at least one non-merge commit
  row in the window, sorted by `source_id` then `project_path`.
- `commits` and `scanned` are the coverage. File data is collected by a bounded
  pass that catches up over sweeps (see `docs/DESIGN.md`), so at any moment
  some commits have none; the rankings describe only the scanned ones, and a
  consumer should say so rather than present them as the whole window.
- `top_files` holds at most 20 files and `top_dirs` at most 12 directories, most
  commits first, then most lines changed, then path. A directory is a path's
  first two segments at most and ends in `/`; `./` is the repository root. A
  directory counts a commit once however many of its files the commit touched.
- `authors` counts distinct people by the producer's actor identity, the same
  one `repo_metrics[].top_actors` uses.
- `shas` lists the commits that touched the entry, newest first, as
  12-character prefixes of `activities[].details.sha`, so a consumer can narrow
  a commit list to one path. It holds at most 100; `commits` is the full count.
- `files` counts every distinct path the scanned commits touched, not only the
  listed ones.

Merge commits are never counted: a merge's diff is against its first parent,
so its files are the merged branch's work a second time. Only path and line
counts are aggregated; the producer never stores patch text.

The key is absent, not empty, from a producer that does not collect per-commit
files (and on any payload older than `4.9.0`): no enabled source runs the file
pass, and the store holds no file lists for the window. Present with
`scanned: 0` means the producer collects them and has not reached these
commits yet. File lists collected before the pass was turned off are still
reported, and a repository of a source that does not run the pass appears with
`scanned: 0` beside the repositories of one that does.

The top lists are per repository so a consumer can re-rank across the
repositories it shows: the top N of a union of per-repository top-N lists is
exact. They cannot be re-ranked for a subset of commits (one author, one
branch), because the counts are not per commit.

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
