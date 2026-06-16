---
name: project-review-cleanup
description: >
  Board-discovery adapter for review-thread cleanup: find this board's PRs that still need review attention, then sweep each through the shared review-thread-cleanup skill.
argument-hint: "[--pr <iid>] [--repo <owner/name>] [--days <n>] [--all-actors] [--limit <n>]"
allowed-tools: Bash, Read, Edit, Write
---

# Project Review Cleanup

Find change requests on this board that still need review attention, then carry
each unresolved provider review thread to an explicit disposition through the
shared, provider-agnostic `review-thread-cleanup` skill. Invoke this when the
Activity page shows a bot review after a PR has already merged, or before
closing out delivery work where provider review threads may have arrived after
checks and local review passed.

This skill is a thin **board-discovery adapter**. It owns one board-specific
job: deciding *which* PRs to sweep, computed from the board's own canonical
store/contract. The actual per-PR thread sweep — list, triage, resolve/reply —
is owned by the shared `review-thread-cleanup` skill (the `pr` plugin) over the
released `forge-cli pr review-threads` surfaces. Discovery lives in the board's
`review-candidates` CLI; the provider mechanics live in `forge-cli`; the
judgment lives in `core/policies/review-thread-convergence.md`. This skill no
longer carries its own discovery, live-read, or resolve/reply GraphQL.

## Contract

Prereqs:

- Run inside the `symphony-board` git work tree with dependencies installed
  (`pnpm install`); Node 24 on PATH (the repo `.node-version` via `fnm`).
- `forge-cli >= 1.9.1` is installed from the released nils-cli package and on
  `PATH` (the `pr review-threads list/resolve/reply` group). `gh` is
  authenticated for the GitHub repositories the board tracks.
- The shared `review-thread-cleanup` skill is installed in the active runtime
  (it ships from `agent-runtime-kit`). Read
  `core/policies/review-thread-convergence.md` (resolve with
  `agent-docs preflight --intent project-dev`) — it is the judgment contract.
- `review-candidates` reads the board's active store read-only through the
  repo config, the same source the contract/UI use; no contract file path is
  needed.

Inputs (all optional, forwarded to `review-candidates`):

- `--repo <owner/name>` — restrict discovery to one `project_path`.
- `--pr <iid>` — focus a single change request (relaxes the late/closed gate).
- `--days <n>` — `late_review` activity window (Pass 2 only); default `7`.
  Open-thread discovery (Pass 1) is not windowed.
- `--actor <login>` (repeatable) / `--all-actors` — widen the Pass 2 bot
  allowlist. Pass 1 open-thread discovery is already actor-agnostic.
- `--limit <n>` — maximum candidates; default `20`.

Outputs:

- A candidate set from `review-candidates`: GitHub change requests with open
  review threads (`open_review_threads`, the primary signal, leading the list),
  plus allowlisted-bot `late_review` / `review_on_closed_pr` candidates, each
  with `source_id`, `repo`, `pr`, `reasons`, and open/total thread counts.
- For each swept PR, the shared skill's outcome: every unresolved thread
  dispositioned (`fix` / `stale` / `follow_up` / `accepted`) and resolved or
  replied through `forge-cli`, or an explicit recorded stop.

Exit codes:

- `0`: success
- `1`: a command failed or a prerequisite is missing
- `2`: usage error or invalid inputs

Failure modes:

- The board store is unreachable or the repo config is missing, so
  `review-candidates` cannot build the contract envelope.
- A candidate's repository is not GitHub; `forge-cli pr review-threads`
  resolve/reply is GitHub-only in v1 and returns `provider_unsupported` on
  GitLab/Local. The contract also carries open-thread counts for GitLab MRs,
  but those are not auto-resolvable here; converge them through the provider
  surface.
- A major / high-risk finding (security, data loss, contract/schema break,
  destructive migration, cross-repo architecture) — stop and ask the user
  rather than self-dispositioning (per the convergence policy).

## Workflow

1. **Discover candidates** from the board's own store (read-only):

   ```bash
   pnpm review-candidates --json
   # focus one PR / repo, or widen the late-review window/actors:
   pnpm review-candidates --json --repo sympoies/symphony-board --pr 181
   pnpm review-candidates --json --all-actors --days 14
   ```

   Each candidate carries `repo` (`owner/name`) and `pr`. Lead with the
   `open_review_threads` candidates (most open threads first) — that is the
   complete "unresolved" set the board lens shows. `late_review` /
   `review_on_closed_pr` add review-timing context the point-in-time count
   cannot.

2. **Sweep each candidate PR through the shared `review-thread-cleanup`
   skill.** For each `{repo, pr}`, run that skill, which:
   - lists unresolved threads via
     `forge-cli --provider github --repo <repo> --format json pr review-threads list <pr>`
     (`data.unresolved == 0` is the convergence target);
   - triages each thread against `core/policies/review-thread-convergence.md`
     (`fix` / `stale` / `follow_up` / `accepted`; escalate major/high-risk);
   - resolves or replies through
     `forge-cli ... pr review-threads resolve <pr> --thread <PRRT_…> [--note …]`
     and `... reply <pr> --thread <PRRT_…> --body …`.

3. **Make any small repairs in this repo** the way the board normally does:
   edit, validate (`pnpm run typecheck`, `pnpm test`), and deliver via
   `semantic-commit` / `deliver-pr`. For other repos, use that repo's active
   delivery workflow, or open and link a follow-up issue. Then return to the
   shared skill to resolve the original thread with the fix/follow-up note.

4. **Re-discover after a sweep.** Re-run `pnpm review-candidates --json` (or
   the focused `forge-cli pr review-threads list <pr>`) and confirm the swept
   PRs no longer carry unresolved threads, or that the residual threads are
   recorded `follow_up` / `accepted` per the policy's stopping rule.

## Convergence

Fixing a thread opens a fix PR, and the async bot reviews that fix PR too, so a
mechanical "fix every new thread" sweep can recurse across generations on
principled-but-imperfect code (or stop early and leave a real bug). The shared
`review-thread-cleanup` skill applies the provider-agnostic convergence
discipline — canonical source: `agent-runtime-kit`
`core/policies/review-thread-convergence.md`. In short: fix genuine defects;
escalate major/high-risk; prefer one terminal/uniform rule when threads cluster
on a mechanism; pick the conservative branch once for inherently-ambiguous
keys; and once only preference or genuine-ambiguity threads on principled code
remain, resolve them as `accepted` with a recorded rationale and stop — never
`accepted` to silence an unread or unverified finding.

## Boundary

This is a project-local **adapter**. It owns only board discovery: invoking
`review-candidates` (read-only over the board's canonical store/contract) to
decide which PRs to sweep. It does not read or mutate provider review threads
itself — the shared `review-thread-cleanup` skill and `forge-cli` own the live
read and the resolve/reply mutations, and `core/policies/review-thread-convergence.md`
owns the triage/stopping judgment. `forge-cli` never learns about the board;
the board never learns about provider GraphQL.

The agent workflow may leave this adapter to make small source fixes, deliver
follow-up PRs, or open follow-up issues when a thread is actionable, using the
active repo delivery/issue skills and their normal validation gates, then
return to the shared skill to resolve the original thread.
