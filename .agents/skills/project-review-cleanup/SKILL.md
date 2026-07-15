---
name: project-review-cleanup
description: >
  Discover this board's PRs that still need review attention, then carry every
  GitHub review thread through fresh forge-cli evidence, convergence triage,
  repair or disposition, reply/resolve, and final zero-unresolved verification.
argument-hint: "[--pr <iid>] [--repo <owner/name>] [--days <n>] [--all-actors] [--limit <n>]"
allowed-tools: Bash, Read, Edit, Write
---

# Project Review Cleanup

Use the board's canonical discovery surface to find change requests that still
need review attention, then own the complete per-PR cleanup loop. This project
skill coordinates board discovery, live provider reads, evidence-backed triage,
normal source delivery, provider reply/resolve mutations, and the final fresh
live convergence check.

## Contract

Prerequisites:

- Run inside the `symphony-board` git work tree with Node 24 and installed pnpm
  dependencies.
- Use the released `forge-cli pr review-threads list/resolve/reply` surfaces.
  Do not replace them with raw provider mutations.
- Read the active runtime's
  `core/policies/review-thread-convergence.md` before dispositioning threads.
  This policy owns `fix` / `stale` / `follow_up` / `accepted` judgment and its
  stopping rule; do not reconstruct a competing policy here.
- Target the active board endpoint. The default base URL is
  `http://127.0.0.1:18080`; override it with
  `SYMPHONY_BOARD_REVIEW_CANDIDATES_URL` or `SYMPHONY_BOARD_BASE_URL`.
  Never substitute an incidental local SQLite store for cleanup discovery.

Optional discovery arguments are forwarded to `review-candidates`:

- `--repo <owner/name>` restricts discovery to one project.
- `--pr <iid>` focuses one change request and relaxes the late/closed gate.
- `--days <n>` changes only the late-review activity window; default `7`.
- `--actor <login>` (repeatable) or `--all-actors` widens the late-review bot
  allowlist. Open-thread discovery is already actor-agnostic.
- `--limit <n>` caps the candidate set; default `20`.

Discovery may report GitLab MRs because the board tracks their open-thread
counts. Released reply/resolve mutations are GitHub-only in this workflow. When
`forge-cli` returns `provider_unsupported`, stop and report the provider route
that must be completed instead of claiming convergence.

## Workflow

### 1. Discover from the active board

Run the read-only owner command:

```bash
export SYMPHONY_BOARD_BASE_URL="${SYMPHONY_BOARD_BASE_URL:-http://127.0.0.1:18080}"
pnpm review-candidates --json
```

Forward requested filters, for example:

```bash
pnpm review-candidates --json --repo sympoies/symphony-board --pr 181
pnpm review-candidates --json --all-actors --days 14 --limit 40
```

Read each candidate's `source_id`, `repo`, `pr`, `reasons`, and thread counts.
Process `open_review_threads` first, ordered by open count. Treat
`late_review` and `review_on_closed_pr` as timing context, not proof that a live
thread is still unresolved.

### 2. Refresh live provider evidence

For every GitHub `{repo, pr}`, ignore the board's point-in-time thread count and
fetch the current provider state:

```bash
forge-cli --provider github --repo <repo> --format json pr review-threads list <pr>
```

Use only entries where `resolved == false`. If `data.unresolved == 0`, record
the candidate as already converged and move on. The board may continue showing
it until the next sync.

Before triage, inspect enough current evidence to understand the finding: the
thread body and URL, the current PR diff/head, the referenced source, tests, and
any replies that materially affect the claim. Use read-only provider tooling
when the normalized thread envelope does not carry enough context.

### 3. Triage every unresolved thread

Apply `core/policies/review-thread-convergence.md` and record one disposition:

- `fix`: a genuine in-scope defect.
- `stale`: the finding no longer applies to current code.
- `follow_up`: a real issue outside this pass, with a durable issue link.
- `accepted`: a verified preference or genuine ambiguity, with rationale.

Use `code-review-specialists` only when an independent read-only review would
materially improve uncertain correctness or risk judgment. Give it the actual
diff/evidence and use focused or follow-up mode. It must not edit source, post
provider comments, resolve threads, or make the final disposition.

Escalate security, data-loss, contract/schema, destructive-migration, and
cross-repository architecture findings before changing source or resolving the
thread. Never use `accepted` merely to end the sweep.

### 4. Deliver source fixes through the owner workflow

For `fix`, work in the repository that owns the defect and follow its preflight,
test-first, validation, review, and delivery requirements. Deliver the repair
through `pr:deliver-pr`; do not commit to `main`, bypass validation, or resolve
the original thread before the fix has a durable PR/MR result.

For `follow_up`, create or reuse the repository-owned issue through its active
issue workflow. Preserve the issue URL or reference for the provider note.

Return to the original `{repo, pr, thread}` after the fix or follow-up exists.

### 5. Reply and resolve through forge-cli

Prepare concise note/body files outside the repository when practical. Include
the disposition and its evidence: merged/follow-up link for `fix` or
`follow_up`, current-code evidence for `stale`, or the verified rationale for
`accepted`.

Reply without resolving only when another participant must answer first:

```bash
forge-cli --provider github --repo <repo> --format json \
  pr review-threads reply <pr> --thread <thread-id> --body-file <reply-file>
```

Resolve with the final disposition note when the thread is ready:

```bash
forge-cli --provider github --repo <repo> --format json \
  pr review-threads resolve <pr> --thread <thread-id> --note-file <note-file>
```

Do not resolve an unread finding, an undelivered repair, an uncreated follow-up,
or a high-risk finding awaiting user direction.

### 6. Prove live convergence

After all mutations for a PR, run a new provider read; do not reuse the earlier
JSON and do not use board rediscovery as the final gate:

```bash
forge-cli --provider github --repo <repo> --format json pr review-threads list <pr>
```

The PR is complete only when the fresh envelope proves
`data.unresolved == 0`. Repeat this final live check for every swept PR. Run
`pnpm review-candidates --json` again only after a board sync when starting a
new discovery pass; its cached count is not proof of provider convergence.

## Output

Report:

- discovery command and filters;
- each candidate `{repo, pr}`;
- every thread id, disposition, and evidence/reference;
- any optional `code-review-specialists` result;
- source-fix or follow-up PR/issue links;
- reply/resolve results; and
- the fresh final `data.unresolved` count for every PR.

Stop with an explicit blocker when discovery is unavailable, live provider
evidence is incomplete, provider writes are unsupported, a high-risk finding
needs user direction, a repair cannot pass its owner gates, or the final fresh
count is nonzero.

## Boundary

This project skill owns orchestration from board discovery through final live
verification. `review-candidates` owns candidate computation from the board's
canonical store, `forge-cli` owns provider thread reads and reply/resolve
mutations, `core/policies/review-thread-convergence.md` owns triage and stopping
judgment, `code-review-specialists` optionally supplies independent read-only
analysis, and `pr:deliver-pr` owns source-fix delivery. Keep those boundaries
separate and do not add bespoke GraphQL or provider mutation scripts here.
