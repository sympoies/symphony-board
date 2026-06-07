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
| 3. Contract | versioned projection serialized for consumers | `packages/contract/` (`contract.schema.json` + `types.ts`) | semver `contract_version` (see `CONTRACT.md`) |

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
  - every observed item and edge gets `last_seen_at`;
  - only a **full + complete** sweep may soft-delete (`deleted_at`) items —
    and, symmetrically, intra-source edges — it did not see; a partial/failed
    fetch never deletes (`FetchResult.complete` gates it, recorded per run in
    `sync_run`);
  - a re-seen item/edge revives (tombstone cleared). Unit-tested in
    `test/db.test.ts`.

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
2. **Full sweep is the default for a one-shot `sync`; the loop daemon runs a
   mostly-incremental cadence.** A bare `sync` (and `SYNC_MODE=once`) is a full
   sweep. The loop daemon runs `--incremental` (watermark-bounded) most
   iterations and a full sweep every `FULL_EVERY` (default 12 ≈ hourly) — the
   full sweep is what keeps the soft-delete correct, and incremental never
   tombstones. Force always-full with `FULL_EVERY=1`.
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

### Still deferred (wired, intentionally not built)

Raw history (one snapshot per entity) and the UI.

Shipped after the initial v1 cut:
- **CI contract-validator** — `emit` validates the envelope against the schema
  before writing and refuses to ship an invalid one; the dependency-free
  validator (`src/contract/validate.ts`) runs in CI via `test/validate.test.ts`.
  See `docs/CONTRACT.md`.
- **Edge soft-delete** — a full + complete sweep now tombstones unseen edges,
  symmetric to items (`softDeleteUnseenEdges`, gated identically). Scoped to
  intra-source edges (both endpoints in the swept source); a cross-source edge
  is left untouched because a single-source sweep cannot prove the other side
  stopped asserting it.
- **Incremental sync (loop cadence)** — the loop daemon runs `--incremental`
  most iterations and a full sweep every `FULL_EVERY` (default 12), so the
  soft-delete sweep stays correct while routine runs stay cheap. The
  watermark gating (full → ignore it; incremental → stop at the first record
  older than it) is covered by `test/sources.test.ts`, and the "incremental
  never tombstones" guarantee by `test/sync-engine.test.ts`.

## Contract package (done) & where the UI lives (open)

**LAYER 3 is extracted into `packages/contract` (done).** The repo is now a pnpm
workspace; `@symphony-board/contract` holds `contract.schema.json` (normative) +
`types.ts` (the mirror DTOs and the shared enum vocabularies). The three-layer
boundary is now *structural*: a consumer depends on this package and **cannot
reach past it** into `src/db` / `src/sources`.

Two decisions taken while extracting:
- **The coupling was resolved by moving the enums into the package.** The shared
  unions (`ItemState`, `ReviewState`, `CiState`, `MergeState`, `EdgeLifecycle`)
  and `Ref` now live in `@symphony-board/contract`; `src/model/types.ts` (LAYER 2)
  imports + re-exports them, so there is one definition, and the package drags no
  LAYER 2 along with it. `ItemKind` / `EdgeType` stay LAYER-2-local (the contract
  carries them as open `string`s).
- **Producer constants stayed in the backend, against the original sketch** (which
  put `version.ts` in the package). The package is deliberately **type-only at
  runtime**: it has no runtime values, so the backend — which runs `.ts` directly
  under Node's type-stripping with **no `node_modules` in the Docker image** —
  never has to *resolve* the package at runtime (the `import type`s erase). Node
  refuses to strip types from files under `node_modules`, so a runtime value
  imported from a workspace package would have forced a build step; keeping
  `CONTRACT_VERSION` / `GENERATOR` and the validator (`src/contract/`) on the
  producer side avoids that and preserves the no-build, zero-third-party-dep
  posture. The validator reads `contract.schema.json` as a file (copied into the
  image), not via a bare-specifier import.

**Open — where the UI lives.** The UI (a later phase, heavy deps + a build step)
should be a sibling `packages/ui` that depends on `@symphony-board/contract` and
nothing else; the contract package already isolates it, so adding it stays cheap.
A separate repo only earns its overhead once there are third-party consumers, or
the UI's release cadence / visibility diverges.

## Validation status

- `pnpm run typecheck` — clean (covers the backend + `packages/contract`).
- `pnpm test` — 33/33 pass (ref, labels, edge lifecycle/reconcile, contract
  build, contract schema validation, DB roundtrip incl. item + edge soft-delete,
  the sync engine incl. soft-delete gating, and the GitHub incremental filter).
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
