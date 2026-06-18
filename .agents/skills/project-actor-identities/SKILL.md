---
name: project-actor-identities
description: >
  Scan canonical actors for split-identity people and likely bots, then update config/sources.json identities / exclude_actors.
argument-hint: "[--json]"
allowed-tools: Bash, Read, Edit
---

# Project Actor Identities

Keep Repo Analytics `top_actors[]` clean: one row per human, no CI/dependency
bots. Invoke this when the board shows the same person twice (a GitLab username
like `@dev-b` next to their commit name `Dev A`), when a new contributor
appears split, or when a bot shows up as noise. The skill runs a read-only scan
that proposes config changes; you review them and edit `config/sources.json`.

This is config-only maintenance — the identity-merge and bot-filter behavior
already ship in the contract producer (`src/contract/build.ts`, contract
`2.3.0`). `config/sources.json` is gitignored and bind-mounted into the Docker
loop, and the merge/filter is applied at emit time (never stored), so a config
edit needs **no code change, PR, or image rebuild** — the loop daemon picks it
up on its next emit.

## Contract

Prereqs:

- Run from the repo root, with the canonical store present at
  `data/symphony.db` (the loop daemon writes it) and `config/sources.json`.
- Node 24 on PATH (`node:sqlite`); the wrapper honors `.node-version` via fnm.

Inputs:

- Optional:
  - `--json` - emit the scan as JSON instead of text.
  - `--db <path>` / `--config <path>` - override the defaults.

Outputs:

- A read-only report of: NEW same-person candidates (ready-to-paste
  `identities` objects), likely bot candidates for `exclude_actors`, and
  uncertain pairs to review by hand. The skill itself writes nothing; you apply
  the confident suggestions to `config/sources.json`.

Exit codes:

- `0`: scan completed
- `1`: scan failed (e.g. missing DB, wrong Node)
- `2`: usage error

Failure modes:

- `data/symphony.db` missing or unreadable — run the loop/sync first.
- Node < 24 (no `node:sqlite`).

## Config shape

`config/sources.json` (gitignored) carries two optional, display-only lists:

```jsonc
"identities": [
  // Collapse one human's split facets into a single top_actors row. `usernames`
  // match the provider login; `names` match commit author display names, folded
  // by case and whitespace ONLY — so one entry covers "Dev D" / "Dev D
  // TUNG", but a variant that differs by more than case/space (punctuation, or a
  // localized / non-ASCII full name) needs its own entry. `name` is the canonical
  // board display; the convention here is the username (the first when several),
  // so rows read as consistent @handles — change it by hand for a different label.
  { "name": "dev-d", "usernames": ["dev-d"], "names": ["Dev D", "Dev D"] }
],
"exclude_actors": ["dependabot", "github-code-quality"]
// Drop CI/dependency bots from top_actors (they still count in totals). The
// board AUTO-drops a GitHub `[bot]` suffix and GitLab `project_/group_<id>_bot_…`
// service accounts, so list only the UNMARKED ones here. Username or display-name
// match, case-insensitive, `*` wildcard.
```

## Scripts

- `scripts/project-actor-identities.sh [--json]` — read-only scan + suggestions.
  Wraps `scripts/scan-actors.mjs` (reads display names only; commit emails are
  stored hashed and never read).

## Workflow

1. Run the scan from the repo root:
   `bash .agents/skills/project-actor-identities/scripts/project-actor-identities.sh`
2. **NEW same-person candidates** are high-confidence (the commit name
   normalizes exactly to an existing username). Paste each suggested object into
   `config/sources.json` → `identities[]`. The scan sets `name` to the username
   (so rows stay consistent `@handle`s); change it by hand only if you want a
   different display label.
3. **Likely bot candidates**: glance at each; add the real bots (not a human who
   merely has "bot" in their name) to `config/sources.json` → `exclude_actors[]`.
4. **Uncertain pairs**: a username only partially matches a commit name. Decide
   by hand — only add an identity if you're sure it's the same person. Never
   merge two different people (a wrong merge is worse than a split row).
5. Apply the edits to `config/sources.json` (Edit). Do not touch any other key.
6. Verify with a fresh emit, then confirm convergence:
   - one-off: `pnpm run emit --out data/contract.json` (or let the loop re-emit
     on its next `INTERVAL`); the served board at `http://localhost:8080`
     refreshes from `data/contract.json`.
   - re-run the scan — confident candidates should now be `0`, and the merged
     people should show as one `@<name>` row with the alternates in the
     hover/aliases.
7. If `data/symphony.db` is empty (fresh checkout, no sync yet), there is nothing
   to scan — run the sync/loop first.

## Boundary

This is a project-local skill. It reads the canonical store read-only and edits
only `config/sources.json` (`identities` / `exclude_actors`). It must not write
the SQLite store, emit or mutate the contract, change producer code, or touch
runtime-kit manifests, rendered product output, global runtime homes,
credentials, sessions, or cache state. Identity/bot judgments are the operator's;
the scan only proposes.
