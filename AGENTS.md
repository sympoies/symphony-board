# AGENTS.md

## Scope

Repo-local agent policy for `symphony-board`.

This repository owns a provider-agnostic work-item aggregator: it reads issues
and PR/MRs from multiple sources (GitHub, GitLab, …), stores them in a local
SQLite canonical model, and emits a versioned JSON contract for a (later) UI.

## Boundaries

- Do not commit secrets, tokens, the SQLite store (`*.db`), `.env`,
  `config/sources.json`, or emitted contracts. All are gitignored.
- Tokens are referenced by env-var name in config and read from the environment
  — never inlined.
- Keep the three layers separate: raw store, canonical DB, versioned contract.
  Do not let the SQLite schema become the contract.
- `normalize` MUST stay pure (no network/IO) so it is replayable against stored
  raw. Network lives in `src/sources/*`; DB IO in `src/db/*`.
- Identity is the provider's immutable global id; never key on mutable
  `project_path` / `iid`.
- Disappearance rule: only a full + complete sweep may soft-delete unseen items;
  a partial/failed fetch must never delete.

## Development workflow

- Read `README.md`, `docs/DESIGN.md`, and `docs/CONTRACT.md` before changing
  behavior or the data model.
- Toolchain: Node via **fnm** (`.node-version`), package manager **pnpm**
  (`packageManager` in `package.json`). No build step: TypeScript runs under
  Node 24 stripping. `pnpm run typecheck` (`tsc --noEmit`) is the type gate;
  `pnpm test` runs pure-logic + DB tests.
- Validate before committing: `pnpm run typecheck && pnpm test`, plus a
  `--dry-run` sync when touching a source or the engine.
- Contract changes follow `docs/CONTRACT.md` (schema + types + version bump +
  test). DB changes are additive migrations tracked by `PRAGMA user_version`.
- Prefer dry-run / recorded fixtures over hitting live provider APIs in tests
  (rate limits; a self-hosted GitLab may be VPN-bound).

## Target

- Contract is the product surface; the UI is a later phase that consumes it.
- The Docker loop daemon is the sole writer (no external cron).
