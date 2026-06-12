---
name: project-review-cleanup
description: >
  Find and disposition late or unresolved provider review threads for this board.
argument-hint: "[--pr <number>] [--apply]"
allowed-tools: Bash, Read
---

# Project Review Cleanup

Find bot review activity that lands late in the board, verify the live provider
review-thread state, and disposition safe stale threads. Invoke this when the
Activity page shows a bot review after a PR has already merged, or before
closing out delivery work where provider review threads may have arrived after
checks and local review passed.

The default mode is read-only. It reports candidate reviews from the board
contract and verifies GitHub review threads live. Use `--apply` only after
reviewing the report; apply mode resolves only closed/merged PR threads whose
thread comments are all authored by allowlisted bot accounts.

## Contract

Prereqs:

- Run inside the `symphony-board` git work tree.
- Node 24 on PATH; the wrapper honors `.node-version` via `fnm` when present.
- `gh` is installed and authenticated for live GitHub verification.
- For contract discovery, an emitted board contract exists at
  `data/contract.json`, or pass `--contract <path>`.
- For live-only triage, pass `--pr <number>` and `--repo <owner/repo>`.

Inputs:

- Optional:
  - `--contract <path>` - contract to scan; default `data/contract.json`.
  - `--repo <owner/repo>` - GitHub repository to verify; default from `origin`.
  - `--pr <number>` - focus a single PR and allow live-only verification.
  - `--days <n>` - contract lookback window; default `7`.
  - `--actor <login>` - allowlisted bot review actor; repeatable. Defaults to
    `chatgpt-codex-connector` plus `PROJECT_REVIEW_CLEANUP_ALLOW_ACTORS`.
  - `--all-actors` - report review candidates from every actor, but still never
    auto-resolve non-allowlisted threads.
  - `--limit <n>` - maximum contract candidates to report; default `20`.
  - `--no-live` - skip provider verification; incompatible with `--apply`.
  - `--apply` - resolve safe stale GitHub review threads.
  - `--json` - emit machine-readable JSON.

Outputs:

- A report of late or closed-PR review candidates from the board contract.
- Live GitHub review-thread status for candidate PRs or the focused `--pr`.
- In `--apply` mode only, safe `resolveReviewThread` mutations for stale
  allowlisted bot threads on closed/merged PRs.

Exit codes:

- `0`: success
- `1`: command failed or a prerequisite is missing
- `2`: usage error or invalid inputs

Failure modes:

- The contract is missing and no live-only `--pr` was supplied.
- GitHub live verification fails; in dry-run this is reported as a failed live
  check, while `--apply` aborts before mutation.
- `--apply` finds human-authored, mixed-author, or open-PR unresolved threads;
  those are reported for manual disposition and left untouched.
- The repository is not a GitHub remote; the script currently verifies only
  GitHub review threads.

## Scripts

- `scripts/project-review-cleanup.sh [options]` - thin wrapper around
  `scripts/review-cleanup.mjs`.

## Workflow

1. Run a read-only scan:
   `bash .agents/skills/project-review-cleanup/scripts/project-review-cleanup.sh`
2. Inspect every candidate. A `late_review` means the submitted review timestamp
   is after the PR's `merged_at` / `closed_at`; a closed/merged PR with zero
   unresolved live threads usually needs no provider mutation.
3. For a specific PR, run:
   `bash .agents/skills/project-review-cleanup/scripts/project-review-cleanup.sh --pr 181`
4. If the live report shows only stale allowlisted bot threads on a closed or
   merged PR, re-run with `--apply` to resolve them.
5. If a thread is human-authored, mixed-author, or points at a real product bug,
   do not auto-resolve it. Repair in a PR, reply and resolve as an accepted
   tradeoff, or open/link a follow-up issue.
6. Re-run the scan after apply; unresolved safe thread count should be `0`.

## Boundary

This is a project-local skill. It reads `data/contract.json` and live GitHub PR
review-thread state. It mutates the provider only in explicit `--apply` mode,
and only by resolving safe stale allowlisted bot review threads. It must not
write the SQLite store, emit or mutate the contract, edit source code, create
provider issues, merge PRs, mutate runtime-kit manifests, rendered product
output, global runtime homes, credentials, sessions, or cache state.
