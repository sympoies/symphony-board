# symphony-board — design

This is the confirmation document for the first version. It captures the
reasoning behind the architecture, the decisions taken by default, and the open
items that need your confirmation. The code in this repo is the first cut of
this design; it type-checks, unit-tests, and has been smoke-tested end-to-end
against live GitHub and GitLab (see "Validation status").

## Goal

Aggregate issues and pull/merge requests from **multiple providers**
(GitHub and GitLab first, others later) into one **provider-agnostic model**,
persist it in a local **SQLite** store, and emit a **versioned JSON contract**
that a UI (built later) and other consumers read. The one workflow concept that
must be first-class is the **issue ↔ PR/MR relationship**.

## Why not "sync into a GitHub Projects board" (the pivot)

The predecessor (`graysurf/project-board-automation`) syncs into a GitHub
Projects v2 board. That board can only hold three item types — Issue,
PullRequest, DraftIssue — and a GitLab item is none of them, so it could only go
on as a *draft issue*: a frozen, text-only snapshot with no live link, no
Repository/Assignee auto-fields (breaking the repo-slice view), and a synthetic
identity hack. The hard constraint is the **sink**, not the providers.

Replacing the sink with a JSON contract removes that constraint entirely. The
cost moves to two places: **(a)** we now own the viewer (a UI is a later phase),
and **(b)** the hard problem becomes **designing one schema that faithfully
covers two non-congruent domain models**. This document is mostly about (b).

## The three layers

The single most important structural decision: **contract ≠ DB schema ≠ raw**.
Three layers, each versioned independently.

| Layer | What | Where | Versioned by |
|------|------|-------|--------------|
| 1. Raw store | provider payloads, opaque | `raw` table | not versioned; tagged `api_version` + `fetched_at` |
| 2. Canonical DB | normalized `item` / `edge` / `item_label` / `sync_*`, provider-agnostic, SQL-queryable | `schema/0001_init.sql` | `PRAGMA user_version` + migrations |
| 3. Contract | versioned projection serialized for consumers | `schema/contract.schema.json` | semver `contract_version` (see `CONTRACT.md`) |

`normalize` is the pure function raw → layer 2; `buildContract` is the pure
function layer 2 → layer 3. Both are replayable: **because we keep raw, a
contract or normalization change can be re-derived offline without re-fetching
from the providers.** This is what makes old records stay compatible (point 4).

## The spine: issue ↔ PR/MR edges (point 1)

Modeled as a typed, directed, stateful, many-to-many, possibly cross-source
**edge** (`edge` table, `src/model/edges.ts`):

- **Many-to-many, cross-repo**: a PR can close several issues; an issue can be
  closed by a PR in another repo. Endpoints are `(source_id, external_id)`
  pairs, so a link survives even when one endpoint is in an untracked project.
- **Reconciled, not just stored**: a `closes` link is reported by the PR
  (`closingIssuesReferences`) *and* by the issue (`closedByPullRequestsReferences`),
  possibly at different times. `reconcileEdges` merges by `(type, from, to)`,
  converges endpoint states, and records provenance (`from`/`to`/`both`).
- **Stateful lifecycle** (`deriveLifecycle`): `declared` (in flight) →
  `fulfilled` (PR merged AND issue closed) → `broken` (PR closed unmerged). This
  is exactly the "in-progress" / "tracking" signal a board wants, and it is
  computed once, centrally, from normalized endpoint states.
- `closes` is the workflow-bearing type; `relates`/`blocks`/`mentions`/`parent`/
  `child` are in the vocabulary for later but are not all populated in v1.

## Identity & the disappearance trap

- **Identity = the provider's immutable global id** (`external_id`: a GitHub node
  id, a GitLab `gid://…`). `project_path`/`iid` are mutable human metadata
  (repos rename/transfer) and are never keyed on.
- **Disappearance handling** (a trap the stateless predecessor didn't have):
  with a persistent store, "I couldn't fetch X this run" (VPN drop, lost auth,
  rate limit) must not look like "X was deleted." So:
  - every observed item gets `last_seen_at`;
  - only a **full + complete** sweep may soft-delete (`deleted_at`) items it did
    not see; a partial/failed fetch never deletes (`FetchResult.complete` gates
    it, recorded per run in `sync_run`);
  - a re-seen item revives (tombstone cleared). Unit-tested in `test/db.test.ts`.

## SQLite (point 5) — rationale and caveats

Good fit at this scale: single-file backup, transactional sync writes, SQL joins
over the edge table, JSON1 to query the raw blob, a natural home for incremental
watermarks. Driver: **Node's built-in `node:sqlite`** (`DatabaseSync`) — zero
native build, ships with Node 24, matching the "pin Node, no build step" stance.

Caveats handled / noted:
- `node:sqlite` is **experimental** in Node 24 (emits a warning; we silence it
  with `--disable-warning=ExperimentalWarning`). This is an accepted risk —
  flagged for your confirmation below.
- **WAL mode** is enabled so the future UI can read while the single daemon
  writes. Keep to **one writer** (the loop daemon is the sole writer by design).
- **Backups**: snapshot with `VACUUM INTO` / `sqlite3 .backup`, not `cp` of a
  live WAL DB.
- **Migrations**: additive columns are cheap; a column change uses the
  rebuild-table pattern (SQLite `ALTER` is limited). Tracked by `user_version`.

## Source extensibility (point 6)

A new source implements `src/sources/types.ts::Source` (`fetch` impure;
`normalize` pure) and is wired in `registry.ts`. The DB and contract don't
change shape — they were designed provider-agnostic (open vocabularies for
`kind` and edge `type`, no two-part `owner/name` assumption, raw stored verbatim
so a new source's payload is preserved even before it has a normalizer).

## Provider model mapping (the incompatibilities)

Normalized to a lowest-common core + nullable extension; the provider's raw
value is preserved alongside (`state_raw`). Key non-congruences:

| Dimension | GitHub | GitLab | Normalized |
|---|---|---|---|
| item kind | Issue / PullRequest | Issue / MergeRequest | `issue` / `change_request` |
| state | OPEN/CLOSED(+stateReason); PR adds MERGED | opened/closed; MR adds merged/locked | `open`/`closed`/`merged` (+`state_raw`) |
| closes link | both endpoints queryable (PR + issue) | **issue side only** (`Issue.relatedMergeRequests`, one issue at a time — no MR-side field exists); superset of strict "closes" | reconciled `closes` edge |
| labels | flat string | scoped `a::b` are **mutually exclusive** per scope | verbatim `name` + parsed `scope` |
| review | `reviewDecision` enum | derived from approvals + threads | `review_state` (lossy) |
| CI | `statusCheckRollup` | `headPipeline.status` (finer) | `ci_state` (lossy) |
| mergeability | `mergeable` | `detailedMergeStatus` (richer) | `merge_state` (lossy) |
| sub-issues / hierarchy | native sub-issues | Epics (Premium) / Work Items | `parent`/`child` edges (deferred) |

## Decisions taken by default (reversible)

1. **Repo is private.** Reversible with `gh repo edit --visibility public`.
2. **Full sweep is the default sync mode.** Incremental (`--incremental`, using
   the stored watermark) is wired and stored but off by default, so the
   soft-delete sweep is always correct in v1. Watermarks are persisted for when
   you turn incremental on.
3. **Loop interval 300s** in `docker/compose.yaml` (point 3: docker is the sole
   writer, no external cron). Tune via `INTERVAL`.
4. **Config is JSON** (`config/sources.json`, gitignored) to keep runtime deps
   at zero. Tokens are referenced by env-var name, never inlined.
5. **Contract starts at `1.0.0`.**
6. **Toolchain: fnm + pnpm.** Node version is pinned in `.node-version` (fnm
   auto-switches on `cd`); the package manager is pnpm, pinned via
   `packageManager` in `package.json`, lockfile `pnpm-lock.yaml`. CI uses
   `pnpm/action-setup` + `node-version-file: .node-version`.

## Decisions confirmed (2026-06-02)

1. **GitLab instance = gitlab.com** (SaaS, not VPN-bound). The `config` example
   targets `https://gitlab.com/api/graphql`; no VPN constraint on the daemon.
2. **GitLab GraphQL validated live against gitlab.com.** Findings + fixes:
   - `MergeRequest.closesIssues` **does not exist** — GitLab exposes the link
     only from the issue side via `Issue.relatedMergeRequests`, and that field
     can be requested for **one issue at a time** (rejected on an issue list).
     The source now bulk-fetches issues then resolves related MRs per issue
     (an N+1, bounded by issue count, mitigated by incremental sync).
   - `detailedMergeStatus`, `headPipeline.status` (`PipelineStatusEnum`),
     `draft`/`approved`/`approvalsRequired`, `userNotesCount`/`upvotes`, and
     `UPDATED_DESC` sort all confirmed; the `merge_state`/`ci_state` mappings now
     use the real enum members.
   - Live e2e (unauthenticated, `gitlab-org/cli`, `since` 5 days): `complete`,
     75 items, **37 `closes` edges** with correct from/to states.
   - Caveat carried forward: `relatedMergeRequests` is a superset of strict
     closing MRs, so a GitLab `closes` edge means "related MR" (good enough for
     the in-progress / fulfilled lifecycle).
3. **`node:sqlite`** (built-in, experimental) — accepted; not switching to
   better-sqlite3.
4. **Fidelity = normalize.** Keep the normalized `review_state` / `ci_state` /
   `merge_state` extension fields (with `state_raw` / raw payload preserved as
   the escape hatch), rather than dropping to raw-only.

### Still deferred for v1 (wired, intentionally not built)

Edge soft-delete (only items are tombstoned today), raw history (one snapshot
per entity), incremental sync (watermark stored, full-sweep default), the UI,
and a contract-validator step in CI.

## Open items (forward — UI phase)

1. **Where the UI lives, and extracting the contract into a package.** The UI
   (a later phase) adds a first-party consumer whose toolchain is the opposite
   of this backend's (heavy deps + a build step). Recommended direction: keep it
   in this repo as a **pnpm workspace**, but first extract LAYER 3 into its own
   package — `packages/contract` (`contract.schema.json` + the mirror `types.ts`
   + `version.ts`) — with the backend and the UI as sibling packages that may
   depend on `contract` and nothing else. This keeps the backend's zero-dep /
   no-build property contained to its own package and makes the three-layer
   boundary *structural*: the UI cannot reach past the contract into `src/db` /
   `src/sources`. A separate repo only earns its overhead once there are
   third-party consumers, or the UI's release cadence / visibility diverges —
   and extracting `packages/ui` later stays cheap precisely because the contract
   package already isolates it.

   The one real coupling to resolve when extracting: `src/contract/types.ts`
   imports the enum unions (`ItemState`, `ReviewState`, `CiState`, `MergeState`,
   `EdgeLifecycle`) from `src/model/types.ts` (LAYER 2). Decide whether those
   move into the contract package or are re-declared / re-exported there, so the
   contract package does not drag LAYER 2 along with it.

   Status: not started; intentionally deferred until the UI phase.

## Validation status

- `pnpm run typecheck` — clean.
- `pnpm test` — 17/17 pass (ref, labels, edge lifecycle/reconcile, contract
  build, DB roundtrip incl. soft-delete).
- **GitHub** e2e against live repos (incl. inside the Docker image on Alpine):
  dry-run + real sync `status=ok`, 180 items / 5 `closes` edges; contract
  `1.0.0` emitted; a sampled edge correctly derived `lifecycle: fulfilled`
  (merged PR → closed issue).
- **GitLab** validated live against gitlab.com in two stages. First the query
  shape: introspection + an unauthenticated e2e on `gitlab-org/cli` (`complete`,
  75 items, 37 `closes` edges); field corrections applied (see "Decisions
  confirmed" #2). Then **token-authenticated (2026-06-02)** against a private
  fixture project seeded to cover every state
  (`graysury/symphony-board-fixture`): `status=ok`, 10 items / 3 `closes` edges,
  with all three lifecycles derived (`fulfilled` / `declared` / `broken`),
  scoped labels parsed (`priority::*` → `scope=priority`), and `merge_state`
  meaningful (`blocked` on the draft MR). In this fixture `review_state` is null
  (no approval rules) and `ci_state` is `none` (no pipelines) — the null path is
  exercised, not a crash; one freshly-created MR transiently reported
  `merge_state=unknown` (GitLab's async mergeability — resolves on re-sync). The
  GitLab-side `relatedMergeRequests` N+1 path is exercised by this run.
- **Combined** (both providers, 2026-06-02): the full pipeline (`init-db` →
  `sync` → `emit`) ran end to end and emitted contract `1.0.0`, 255 items / 14
  edges.
