# AGENTS.md

## Scope

Repo-local agent policy for `symphony-board`.

This repository owns a provider-agnostic work-item aggregator: it reads issues
and PR/MRs from multiple sources (GitHub, GitLab, …), stores them in a local
SQLite canonical model, emits a versioned JSON contract, and serves a read-only
UI from that contract.

## Boundaries

- Do not commit secrets, tokens, the SQLite store (`*.db`), `.env`,
  `config/sources.json`, or runtime-emitted contracts under `data/`. All are
  gitignored. `packages/ui/public/contract.json` is a tracked sample contract
  for local UI development and render-smoke tests.
- Tokens are referenced by env-var name in config and read from the environment
  — never inlined.
- Keep the three layers separate: raw store, canonical DB, versioned contract.
  Do not let the SQLite schema become the contract.
- `normalize` MUST stay pure (no network/IO) so it is replayable against stored
  raw. Network lives in `src/sources/*`; DB IO in `src/db/*`.
- Identity is the provider's immutable global id; never key on mutable
  `project_path` / `iid`.
- Disappearance rule: only a full + complete sweep may soft-delete unseen items
  or intra-source edges; a partial, failed, or incremental fetch must never
  delete.

## Development workflow

- Read `README.md`, `docs/DESIGN.md`, and `docs/CONTRACT.md` before changing
  behavior or the data model.
- Toolchain: Node via **fnm** (`.node-version`), package manager **pnpm**
  (`packageManager` in `package.json`). Backend TypeScript runs under Node 24
  stripping with no backend build step; the UI package (`packages/ui`) is the
  Vite + React build step.
- Validate before committing: `pnpm run typecheck && pnpm test`. Also run
  `pnpm --filter @symphony-board/ui run build`, UI tests, and UI smoke when the
  change touches UI, contract, shared view-model behavior, or docs that describe
  those paths. Run a `--dry-run` sync when touching a source or the engine.
- Contract changes follow `docs/CONTRACT.md` (schema + types + version bump +
  test). DB changes are additive migrations tracked by `PRAGMA user_version`.
- Prefer dry-run / recorded or throwaway fixtures over hitting live provider
  APIs in automated tests (rate limits; a self-hosted provider may be
  network-bound).

## Development log

- `docs/devlog/` is a time-ordered narrative of notable work: what shipped, why,
  the evidence, and external links worth keeping. It complements — never
  duplicates — commit messages (what changed) and `docs/DESIGN.md` (the
  normative decision record).
- **Write an entry when a session produces a durable outcome worth future
  lookup**: a shipped feature, a validated milestone, a decision, or an external
  ref you'll want again. Skip trivial / transient / same-turn fixes — the log is
  signal, not a changelog. Not every session earns one.
- One file per month (`docs/devlog/YYYY-MM.md`), newest entry on top, English.
  Use the template and commit convention in `docs/devlog/README.md`; commit the
  entry on its own (`docs(devlog): …`). Search with
  `scripts/devlog-search.sh <term> [YYYY-MM]`.
- The `project-devlog` skill walks this flow.

## Project skills

- Project-local agent skills live under `.agents/skills/<name>/` (the canonical
  source); Claude discovers them through a gitignored `.claude/skills` bridge.
- Create them only with the create-project-skill tooling — never hand-write
  `.claude/skills/<name>/SKILL.md`:

  ```sh
  ~/.claude/plugins/meta/skills/create-project-skill/scripts/create-project-skill.sh \
    <name> --description "One-line description."
  ```

  Names must start with `project-` (e.g. `project-devlog`). The tooling wires the
  `.claude/` bridge and the `.gitignore` entry for you. Add `--with-script` /
  `--with-tests` only when the skill owns code.
- Existing skills: `project-devlog` (append a development-log entry).

## Agent helper scripts

Quick, read-only lookups in `scripts/` (no build — just run); see
`scripts/README.md`:

- `scripts/devlog-search.sh <term> [YYYY-MM]` — search past devlog entries.
- `scripts/contract-summary.sh [contract.json]` — counts, per-source, edges by
  lifecycle from an emitted contract.
- `scripts/db-summary.sh [db_path]` — items / edges / sync-run summary from the
  canonical SQLite store (opened with `PRAGMA query_only`; the loop daemon stays
  the sole writer).

## Target

- Contract + read-only UI are the product surface.
- The Docker loop daemon is the sole writer (no external cron, no second writer).
