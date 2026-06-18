---
name: project-devlog
description: >
  Append a development-log entry to docs/devlog/<YYYY-MM>.md after a session
  produces a durable outcome (a shipped feature, validated milestone, decision,
  or external ref worth keeping). Skips trivial / transient / same-turn work.
argument-hint: "[entry title]"
allowed-tools: Bash, Read, Edit, Write
---

# Project Devlog

Append a single entry to the monthly development log when the current session
produced something worth looking up later. The log is **signal, not a
changelog** — most sessions do not earn an entry. This skill enforces the policy
in `docs/devlog/README.md`.

## Contract

Prereqs:

- Run inside the `symphony-board` git work tree, with `docs/devlog/` present.
- A durable outcome exists this session: a shipped feature, a validated
  milestone, a decision, or an external link/ref worth keeping. If not, do not
  write — say so and stop.

Inputs:

- Optional:
  - `[entry title]` - short title for the entry; otherwise derive one from the
    session's outcome.

Outputs:

- A new `## YYYY-MM-DD — <title>` entry inserted at the TOP of
  `docs/devlog/<YYYY-MM>.md` (the month file is created with a header if new).
- A standalone commit `docs(devlog): <YYYY-MM> — <subject>` via the
  semantic-commit skill.

Exit codes:

- `0`: an entry was written and committed.
- `1`: a prerequisite is missing or the write/commit failed.
- `2`: nothing worth logging — intentional no-op (the common case).

Failure modes:

- The outcome is trivial / transient / same-turn — skip; that is expected, not
  an error.
- The entry would only duplicate `docs/DESIGN.md` (decisions) or a commit
  message (what changed) without adding *why* / context / links — trim or skip.
- The entry leaks personal or private identifiers (real names, personal
  handles/emails, internal hostnames, machine/tailnet names, private IPs) — this
  is a public repo; anonymize with neutral placeholders before committing.

## Scripts

- Find prior entries before writing with `scripts/devlog-search.sh <term>`.

## Workflow

1. Decide whether an entry is warranted (a durable outcome worth future lookup).
   If not, stop with a one-line reason — not every session logs.
2. Resolve the month file: `docs/devlog/$(date +%Y-%m).md`. If it does not
   exist, create it with a `# Development log — YYYY-MM` header mirroring an
   existing month file, and add it to the "Months" list in
   `docs/devlog/README.md`.
3. Compose the entry from the template in `docs/devlog/README.md`:
   **Result / Why / Evidence / Links / Follow-ups**. Ground Evidence in real
   commands and numbers; put external URLs and commit SHAs in Links.
4. Insert the entry at the TOP of the month's entries (newest-first), just below
   the file header. Never rewrite existing entries — the log is append-only.
5. Keep it English. Capture the *why* and the *links*; do not restate the diff
   or the decision record.
6. **Public repo — no personal records.** This repository is public: never write
   personal identifiers (real names, personal usernames/handles, emails),
   internal hostnames (e.g. a company GitLab host), or personal deploy topology
   (specific machine names, Tailscale/tailnet names, private IPs) into an entry.
   Use neutral placeholders instead (`dev-a`, `gitlab.internal`, "a dedicated
   host", "the self-hosted GitLab") — keep the engineering signal, drop the
   personal specifics. Scan the drafted entry for these before committing.
7. Commit only the devlog file(s) on their own via the semantic-commit skill:
   `docs(devlog): <YYYY-MM> — <subject>`. Push per the repo's normal flow.

## Boundary

This is a project-local skill. It only appends to `docs/devlog/` (and the month
index in its README) and commits those files. It must not edit code,
`docs/DESIGN.md`, or other docs; rewrite existing devlog entries; or mutate
runtime-kit manifests, rendered product output, global runtime homes,
credentials, sessions, or cache state.
