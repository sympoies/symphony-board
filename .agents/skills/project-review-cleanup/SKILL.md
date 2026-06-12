---
name: project-review-cleanup
description: >
  Find and disposition late or unresolved provider review threads for this board.
argument-hint: "[--pr <number>] [--json] [--disposition-file <path>] [--apply]"
allowed-tools: Bash, Read, Edit, Write
---

# Project Review Cleanup

Find bot review activity that lands late in the board, verify live provider
review-thread state, and carry each thread to an explicit disposition. Invoke
this when the Activity page shows a bot review after a PR has already merged, or
before closing out delivery work where provider review threads may have arrived
after checks and local review passed.

The default mode is read-only. It reports GitHub review candidates across every
GitHub repository in the board contract and verifies GitHub review threads live.
The live JSON includes review comment body text, diff hunks, paths, review URLs,
and author metadata so the agent can inspect the review directly.

The target workflow is agent-owned cleanup, not manual review. The agent should
read every unresolved thread, decide whether it is stale, fixed, tracked as a
follow-up, or accepted as a tradeoff, and do the necessary small repair or
follow-up issue/PR work before resolving the thread. Stop and ask the user only
for a major or high-risk finding, such as a security issue, possible data loss,
contract/schema break, destructive migration, cross-repo architecture decision,
or a finding the agent cannot verify safely.

`safe_to_resolve` means the provider mutation is mechanically safe, not that the
review is valueless. A safe thread still needs an agent disposition. Use
`--disposition-file` in `--apply` mode when a thread was fixed, converted to a
follow-up, accepted, or confirmed stale; the file supplies the provider-visible
note for each resolved thread.

## Contract

Prereqs:

- Run inside the `symphony-board` git work tree.
- Node 24 on PATH; the wrapper honors `.node-version` via `fnm` when present.
- `gh` is installed and authenticated for live GitHub verification.
- For contract discovery, an emitted board contract exists at
  `data/contract.json`, or pass `--contract <path>`.
- For live-only triage without a contract, pass `--pr <number>` and
  `--repo <owner/repo>`; when a contract is available, `--pr` searches matching
  GitHub repositories in that contract.

Inputs:

- Optional:
  - `--contract <path>` - contract to scan; default `data/contract.json`.
  - `--repo <owner/repo>` - GitHub repository to verify; default is every
    GitHub repository in the contract, falling back to `origin` for live-only
    `--pr` runs without a contract.
  - `--pr <number>` - focus a single PR and allow live-only verification.
  - `--days <n>` - contract lookback window; default `7`.
  - `--actor <login>` - allowlisted bot review actor; repeatable. Defaults to
    `chatgpt-codex-connector` plus `PROJECT_REVIEW_CLEANUP_ALLOW_ACTORS`.
  - `--all-actors` - report review candidates from every actor, but still never
    auto-resolve non-allowlisted threads.
  - `--limit <n>` - maximum contract candidates to report; default `20`.
  - `--no-live` - skip provider verification; incompatible with `--apply`.
  - `--apply` - resolve safe stale GitHub review threads.
  - `--disposition-file <path>` - JSON file of agent-inspected thread
    dispositions. In `--apply` mode, only listed safe threads are resolved and
    each uses its per-thread note. Without `--apply`, the file is loaded for
    dry-run verification and report annotation.
  - `--resolution-note <text>` - provider-visible reply posted before resolving
    each thread. Defaults to a stale-thread disposition note in `--apply` mode.
  - `--no-resolution-note` - resolve without posting a provider-visible reply.
  - `--json` - emit machine-readable JSON.

Outputs:

- A report of late or closed-PR GitHub review candidates from the board
  contract.
- Live GitHub review-thread status for candidate PRs or the focused `--pr`.
- In JSON mode, enriched unresolved-thread evidence:
  `comments[].bodyText`, `comments[].diffHunk`, comment URLs, review URLs,
  author logins, path/line, and the safety reason.
- In `--apply` mode only, optional `addPullRequestReviewThreadReply` notes plus
  safe `resolveReviewThread` mutations for allowlisted bot threads on
  closed/merged PRs. With `--disposition-file`, only dispositioned threads are
  resolved.

Exit codes:

- `0`: success
- `1`: command failed or a prerequisite is missing
- `2`: usage error or invalid inputs

Failure modes:

- The contract is missing and no live-only `--pr` was supplied.
- GitHub live verification fails; in dry-run this is reported as a failed live
  check, while `--apply` aborts before mutation.
- `--apply` finds human-authored, mixed-author, unknown-author, incomplete, or
  open-PR unresolved threads; those are reported as unsafe for automatic
  provider mutation and left untouched.
- `--apply --disposition-file` leaves any safe thread without an agent
  disposition unresolved and exits non-zero.
- A disposition references a thread that is not unresolved in the focused live
  PR set; apply reports the mismatch and exits non-zero.
- `--apply` aborts before provider mutation when any focused PR fails live
  verification.
- The repository is not a GitHub remote; the script currently verifies only
  GitHub review threads.

## Scripts

- `scripts/project-review-cleanup.sh [options]` - thin wrapper around
  `scripts/review-cleanup.mjs`.

## Workflow

1. Run a read-only enriched scan:
   `bash .agents/skills/project-review-cleanup/scripts/project-review-cleanup.sh --json`
2. Inspect every unresolved thread in the JSON. The default report may include
   multiple GitHub repositories from the board contract. A `late_review` means
   the submitted review timestamp is after the PR's `merged_at` / `closed_at`;
   a closed/merged PR with zero unresolved live threads needs no provider
   mutation.
3. For a specific PR, run:
   `bash .agents/skills/project-review-cleanup/scripts/project-review-cleanup.sh --pr 181 --json`
4. Classify each thread:
   - `stale`: the comment no longer applies to the merged code, is outdated, or
     is a false positive after inspecting the diff.
   - `fixed`: a small concrete repair was made by the agent in a follow-up
     commit/PR; include the PR URL in the disposition note.
   - `follow_up`: the finding is real but should not be fixed in this cleanup
     pass; open/link a provider issue and include the issue URL in the note.
   - `accepted`: the finding is intentionally not changed after verification;
     explain the tradeoff in the note.
   - major/high-risk: stop and ask the user before resolving.
5. For small repairs in this repo, edit and validate normally, then deliver via
   `semantic-commit` / `deliver-pr`. For other repos, use that repo's active
   workflow if available; otherwise open a follow-up issue and link it.
6. Write a disposition file for every safe unresolved thread that should be
   resolved:

   ```json
   {
     "threads": [
       {
         "threadId": "PRRT_...",
         "disposition": "follow_up",
         "follow_up_url": "https://github.com/sympoies/symphony-board/issues/200"
       },
       {
         "threadId": "PRRT_...",
         "disposition": "stale",
         "note": "Resolved as stale after checking the merged diff; current code already guards this path."
       }
     ]
   }
   ```

   Valid dispositions are `stale`, `fixed`, `follow_up`, and `accepted`.
   `fixed` and `follow_up` require either an explicit `note` or the matching
   URL field so the helper can generate a provider-visible note.
7. Apply only after the disposition file represents the agent's inspection:
   `bash .agents/skills/project-review-cleanup/scripts/project-review-cleanup.sh --apply --disposition-file <path>`
8. Re-run the scan after apply. The focused PR set should have no unresolved
   safe threads lacking disposition.

## Boundary

This is a project-local skill. The helper script reads `data/contract.json` and
live GitHub PR review-thread state. It mutates the provider only in explicit
`--apply` mode, and only by replying to and resolving safe allowlisted bot
review threads on closed/merged PRs. The helper script must not write the
SQLite store, emit or mutate the contract, edit source code, create provider
issues, merge PRs, mutate runtime-kit manifests, rendered product output,
global runtime homes, credentials, sessions, or cache state.

The agent workflow may leave the helper script to make small source fixes,
deliver follow-up PRs, or create follow-up issues when a thread is actionable.
Those actions must use the active repo delivery/issue skills and their normal
validation gates, then return to this helper with a disposition file to resolve
the original stale thread.
