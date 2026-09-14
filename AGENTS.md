# AGENTS.md

## Scope

Repo-local agent policy for `symphony-board`.

This repository owns a provider-agnostic work-item aggregator: it reads issues
and PR/MRs from multiple sources (GitHub, GitLab, …), stores them in a local
canonical model (SQLite by default, Postgres by opt-in), emits a versioned JSON
contract, and serves a UI from that contract. The UI is read-only with respect
to providers — it never writes issues, labels, or PR/MRs back — though a
capability-gated writer control plane lets it trigger local syncs and edit
producer config/tokens (see `docs/DESIGN.md`).

## Boundaries

- Do not commit secrets, tokens, the SQLite store (`*.db`), Postgres volume
  dumps, `.env`, `config/sources.json`, `config/sources.pg.json`, or
  runtime-emitted contracts under `data/`. All are gitignored.
  `packages/ui/public/contract.json` is a tracked sample contract for local UI
  development and render-smoke tests.
- Tokens are referenced by env-var name in config and read from the environment
  — never inlined.
- Keep the three layers separate: raw store, canonical DB, versioned contract.
  Do not let the canonical DB schema become the contract.
- `normalize` MUST stay pure (no network/IO) so it is replayable against stored
  raw. Network lives in `src/sources/*`; DB IO in `src/db/*`.
- Identity is the provider's immutable global id `(source_id, external_id)`;
  never key *identity* on mutable `project_path` / `iid`. Display *grouping*
  (e.g. `repo_stats[]` / `repo_metrics[]`) may use `(source_id, project_path)`,
  which is a per-repo bucket, not item identity.
- Disappearance rule: only a full + complete sweep may soft-delete unseen items
  or intra-source edges; a partial, failed, or incremental fetch must never
  delete.

## Development workflow

- Read `DEVELOPMENT.md` for maintenance principles and
  `docs/development-reference.md` for detailed change-path and validation
  guidance. Read `docs/DESIGN.md` and `docs/CONTRACT.md` before changing
  behavior or the data model.
- Toolchain: Node via **fnm** (`.node-version`), package manager **pnpm**
  (`packageManager` in `package.json`). Backend TypeScript runs under Node 24
  stripping with no backend build step; the UI package (`packages/ui`) is the
  Vite + React build step.
- Validate before committing: `pnpm run typecheck && pnpm test`. The detailed
  validation routing lives in `docs/development-reference.md`; also run
  `pnpm --filter @symphony-board/ui run build`, UI tests, and UI smoke when the
  change touches UI, contract, shared view-model behavior, or docs that describe
  those paths. Run a `--dry-run` sync when touching a source or the engine, and
  the Postgres gates (`pnpm run test:pg-e2e`, `pnpm run test:pg-compose`; Docker
  required) when touching the `Store` seam, a driver, or the schema.
- Contract changes follow `docs/CONTRACT.md` (schema + types + version bump +
  test). DB changes are additive migrations applied to EVERY driver
  (`schema/sqlite/` AND `schema/postgres/`); schema version is driver-owned
  (SQLite: `PRAGMA user_version`; Postgres: the `meta` table's
  `schema_version`).
- Prefer dry-run / recorded or throwaway fixtures over hitting live provider
  APIs in automated tests (rate limits; a self-hosted provider may be
  network-bound).

## Documentation and delivery

- [`DEVELOPMENT.md`](DEVELOPMENT.md) owns contributor principles and the
  routine finish-line; [`CLAUDE.md`](CLAUDE.md) imports this policy for Claude
  Code. [`docs/development-reference.md`](docs/development-reference.md) owns
  detailed change-path and validation routing.
- [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/CONTRACT.md`](docs/CONTRACT.md)
  own normative architecture and public-contract decisions. Helper commands
  remain indexed in [`scripts/README.md`](scripts/README.md).
- Project-local skills live under `.agents/skills/`; use their lifecycle
  tooling instead of hand-maintaining generated Claude discovery bridges.
- This repository's log is `docs/devlog/`; its conventions and month index live
  in `docs/devlog/README.md`. When to read it, when to append, what the
  mechanism is, and what must never go into it belong to the `project-dev`
  devlog capability in the agent home, not to this file.
- Deliver tracked changes through the governed managed-worktree and PR flow.
