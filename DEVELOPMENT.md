# Development guide

Maintenance principles and the routine contribution workflow for
`symphony-board`. Detailed toolchain, validation, coverage, and change-path
procedures live in the
[`development reference`](docs/development-reference.md); operational setup and
runtime commands live in [`docs/running.md`](docs/running.md).

Read [`AGENTS.md`](AGENTS.md) before editing. [`CLAUDE.md`](CLAUDE.md) imports
the same repository policy for Claude Code.

## Maintenance principles

- Preserve the raw store, canonical database, and versioned contract as
  separate layers. Database schema is an implementation detail, not the
  consumer contract.
- Keep provider network access in `src/sources/*`, database IO in `src/db/*`,
  orchestration in `src/sync-engine.ts`, and normalization pure and replayable.
- Use the provider's immutable `(source_id, external_id)` identity. Mutable
  project paths and local item numbers are display or grouping data only.
- Only a full, complete sweep may soft-delete unseen items or intra-source
  edges. Partial, failed, and incremental runs never prove disappearance.
- Maintain one writer per configured store. Read-only API, UI, desktop, and
  webhook surfaces must not become alternate database writers.
- Keep tokens and runtime state outside git. Config stores credential env-var
  names, never secret values; tracked contract data is sample data only.
- Apply schema changes additively to both SQLite and Postgres, and evolve the
  emitted contract through its schema, mirrored types, version, producer tests,
  and consumers together.

## Change workflow

1. Classify the affected boundary: source/normalizer, store/schema, contract,
   UI, desktop shell, Docker/runtime, or repository documentation.
2. Read the owning design, contract, or runbook and inspect affected callers,
   fixtures, migrations, consumers, and tests before editing.
3. Capture a meaningful regression failure when practical, then make the
   smallest change that preserves the boundaries above.
4. Run focused tests while iterating, then the normal backend gate:

   ```sh
   pnpm run typecheck
   pnpm test
   ```

5. Add the UI, Postgres, contract, coverage, desktop, Docker, or provider
   dry-run gates when the changed boundary requires them. The exact routing and
   commands are in the detailed development reference.
6. Keep current docs synchronized with changed behavior. Add a devlog entry
   only for a durable outcome worth future lookup.

## Documentation routing

| Need | Canonical document |
| --- | --- |
| Toolchain, repository layout, detailed validation, tests, and change paths | [`Development reference`](docs/development-reference.md) |
| Runtime setup, Docker stacks, desktop/Android, Live, releases, and inspection | [`Running Symphony Board`](docs/running.md) |
| Architecture and ownership decisions | [`Design`](docs/DESIGN.md) |
| Emitted contract schema and versioning | [`Contract`](docs/CONTRACT.md) |
| Product overview and quick start | [`README.md`](README.md) |
| Agent-specific repository policy | [`AGENTS.md`](AGENTS.md) |
| Durable implementation history | [`Development log`](docs/devlog/README.md) |

Operational details belong in `docs/running.md`; implementation detail belongs
in the development reference; stable architectural or contract rules belong in
their owning documents. Root `DEVELOPMENT.md` remains the concise maintenance
entrypoint and should not duplicate those references.
