# symphony-board — design

This is the confirmation document for the first version. It captures the
reasoning behind the architecture, the decisions taken by default, and the open
items that need your confirmation. The code in this repo is the first cut of
this design; it type-checks, unit-tests, and has been smoke-tested end-to-end
against live GitHub (see "Validation status").

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
| closes link | both endpoints queryable | MR side (`closesIssues`); issue side not in our query | reconciled `closes` edge |
| labels | flat string | scoped `a::b` are **mutually exclusive** per scope | verbatim `name` + parsed `scope` |
| review | `reviewDecision` enum | derived from approvals + threads | `review_state` (lossy) |
| CI | `statusCheckRollup` | `headPipeline.status` (finer) | `ci_state` (lossy) |
| mergeability | `mergeable` | `detailedMergeStatus` (richer) | `merge_state` (lossy) |
| sub-issues / hierarchy | native sub-issues | Epics (Premium) / Work Items | `parent`/`child` edges (deferred) |

## Decisions taken by default (reversible)

1. **Repo is private.** A board that will reference an internal company GitLab
   should not be public by default. Flip with `gh repo edit --visibility public`.
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

## Open items — please confirm

1. **Which GitLab instance?** gitlab.com SaaS vs a VPN-only self-hosted
   (e.g. `gitlab.gamania.com`). The daemon must run where it can reach it — fine
   on your Mac inside the VPN; a future always-on server must also be on the VPN.
2. **GitLab GraphQL field validation.** The GitLab source is written from the
   schema as best understood and is **unvalidated against a live instance**.
   The fields most likely to need a one-line fix: `MergeRequest.closesIssues`
   (the spine), `detailedMergeStatus` enum, `headPipeline.status` casing,
   `approved`/`approvalsRequired`. If a name is wrong the fetch reports
   `partial` with the error and **does not corrupt or delete data** — safe to
   iterate. (GitHub is validated: smoke run fetched 180 items / 5 edges.)
3. **`node:sqlite` experimental** — accept, or switch to `better-sqlite3`
   (mature, native build)? Current choice: built-in.
4. **Fidelity bar** for the extension fields (review/CI/merge). v1 maps them
   lossily; confirm that's enough or name what must be exact.
5. **Deferred for v1** (wired but intentionally not built): edge soft-delete
   (only items are tombstoned today), raw history (one snapshot per entity),
   incremental sync (watermark stored, full-sweep default), the UI, and a
   contract validator step in CI.

## Validation status

- `npm run typecheck` — clean.
- `npm test` — 17/17 pass (ref, labels, edge lifecycle/reconcile, contract
  build, DB roundtrip incl. soft-delete).
- End-to-end smoke against live GitHub (two public repos): dry-run and real sync
  both `status=ok`, 180 items / 5 `closes` edges; contract `1.0.0` emitted; a
  sampled edge correctly derived `lifecycle: fulfilled` (merged PR → closed
  issue). GitLab path is structurally complete but unvalidated (item 2 above).
