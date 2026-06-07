# DEVELOPMENT.md

Developer guide for `symphony-board`. Read [README.md](README.md) for the
operational overview, [docs/DESIGN.md](docs/DESIGN.md) for the design record,
and [docs/CONTRACT.md](docs/CONTRACT.md) before changing the emitted contract.

## Runtime And Toolchain

The backend runs TypeScript directly under Node 24's built-in type stripping:
there is no backend build step and no `dist/`. Node strips types but does not
check them, so `pnpm run typecheck` is the type gate.

The backend uses `node:sqlite` (`DatabaseSync`) as the SQLite driver. It is
built into Node 24 and currently emits an experimental warning; project commands
run with `--disable-warning=ExperimentalWarning`.

The repo is a pnpm workspace:

- root package: backend CLI, sync engine, DB, sources, tests, CI helpers
- `packages/contract`: versioned contract schema and DTOs
- `packages/ui`: Vite + React web UI

Backend runtime imports from `@symphony-board/contract` are type-only. The
Docker backend image copies source and schema files but does not run
`pnpm install`; the contract package is not resolved as runtime code by the
backend. The UI is the package that owns browser dependencies and the Vite build.

Toolchain:

- Node via `fnm` and `.node-version`
- pnpm via `packageManager` in `package.json`
- TypeScript as the type gate
- `c8` for the combined logic-tier coverage gate
- `lefthook` for the local pre-push gate

## Layout

```text
schema/0001_init.sql          canonical DB DDL, applied by src/db/open.ts
src/config.ts                 config loading and token env-var resolution
src/model/                    pure canonical helpers: refs, labels, edges, types
src/sources/                  provider fetchers and pure normalizers
src/db/                       SQLite open/migrate and repository queries
src/sync-engine.ts            fetch -> raw -> normalize -> reconcile -> upsert
src/contract/                 contract builder, validator, version constants
src/cli/                      init-db, sync, emit-contract, validate-contract
test/                         backend node --test suite

packages/contract/            LAYER 3 package: schema + mirrored DTO types
packages/ui/                  Vite + React UI, UI tests, render-smoke

docker/                       backend daemon image, UI sidecar image, compose
scripts/                      read-only helpers and CI support scripts
scripts/fixtures/             provider fixture seeders and UI probe
docs/devlog/                  append-only development log
```

## Boundaries

- Keep the three layers separate: raw store, canonical DB, versioned contract.
- `normalize` must stay pure. Network belongs in `src/sources/*`; DB IO belongs
  in `src/db/*`; orchestration belongs in `src/sync-engine.ts`.
- Identity is `(source_id, external_id)`, where `external_id` is the provider's
  immutable global id. Do not key on mutable `project_path` or `iid`.
- Only a full and complete sweep may soft-delete unseen items or intra-source
  edges. Partial, failed, and incremental runs must never tombstone.
- Runtime contracts under `data/` are generated output and stay gitignored. The
  tracked `packages/ui/public/contract.json` is a small UI sample only.
- Tokens are referenced by env-var name in config and read from the environment.
  Never commit tokens, `.env`, `config/sources.json`, SQLite DB files, or runtime
  emitted contracts.

## Validation Commands

Core backend gate:

```sh
pnpm run typecheck
pnpm test
```

UI gate:

```sh
pnpm --filter @symphony-board/ui run build
pnpm --filter @symphony-board/ui run test
pnpm --filter @symphony-board/ui run smoke
```

Coverage gate:

```sh
pnpm coverage
```

Contract validation:

```sh
pnpm run emit -- --out data/contract.json
pnpm run validate -- --in data/contract.json
```

Provider/source smoke, when credentials and network are available:

```sh
GITHUB_TOKEN="$(gh auth token)" node src/cli/sync.ts --config config/sources.json --dry-run
GITLAB_TOKEN="glpat_xxx" node src/cli/sync.ts --source gitlab:gitlab.com --dry-run
```

`--dry-run` fetches and normalizes but writes nothing. It reports per-source
status, item count, edge count, and soft-delete counts.

## Testing Strategy

The backend test suite covers deterministic logic and SQLite behavior:

- ref and label helpers
- edge lifecycle and reconciliation
- contract build and schema validation
- config validation
- source normalizer behavior
- in-memory DB round trips
- sync-engine soft-delete and failed-fetch invariants

The UI test suite covers view-model and localStorage behavior. The UI
render-smoke builds the app, opens it in headless Chrome, and asserts that the
Board, Graph, Settings, deep-link search, configured colors, and graph focus
path render without console errors.

`pnpm coverage` measures backend `.ts` files plus UI `.ts` logic. It
intentionally excludes React `.tsx` from the percentage because bundled browser
coverage is not a useful source-level measurement for the component layer. The
component layer is gated by render-smoke instead.

Provider API tests should prefer fixtures or dedicated throwaway projects over
production repos. Live provider calls are useful for smoke validation but should
not be required for CI because credentials, rate limits, and network boundaries
vary.

## Common Change Paths

### Adding A Source

1. Implement `Source` in `src/sources/types.ts`.
2. Keep `fetch` impure and `normalize` pure.
3. Register the source in `src/sources/registry.ts`.
4. Use provider immutable global ids for `external_id`.
5. Add source tests for fetch pagination/watermark behavior and normalization.
6. Run the backend gate and, when possible, a `--dry-run` sync.

The DB and contract usually do not change for a new source because `kind`,
edge `type`, labels, and project paths are open vocabularies.

### Changing The DB Schema

1. Add a new `schema/NNNN_*.sql` migration; never edit an applied migration.
2. Append the migration to `MIGRATIONS` in `src/db/open.ts`.
3. Keep changes additive when possible. SQLite column rewrites require the
   create-new/copy/drop-old/rename pattern.
4. Add DB tests and run the backend gate.

Schema version is tracked with `PRAGMA user_version`.

### Changing The Contract

Follow [docs/CONTRACT.md](docs/CONTRACT.md):

1. Edit `packages/contract/contract.schema.json`.
2. Edit `packages/contract/types.ts` in the same commit.
3. Bump `CONTRACT_VERSION` in `src/contract/version.ts`.
4. Update producer validation tests and UI consumer behavior if needed.
5. Run backend, UI, and contract validation gates.

Additive optional fields are minor version changes. Removing, renaming,
repurposing, or changing required fields is a major version change.

### Changing The UI

1. Keep contract loading in `packages/ui/src/contract.ts`.
2. Keep pure view-model logic in `packages/ui/src/model.ts`.
3. Keep persistent browser preferences in `packages/ui/src/viewconfig.ts`.
4. Keep Settings changes view-only. The UI must not write back to the backend,
   provider APIs, SQLite, or generated contracts.
5. Run the UI gate and root typecheck. Run render-smoke after a build.

### Changing Docker Operation

The `board` service remains the only writer. The `web` service must read the
daemon-emitted `data/contract.json` read-only and serve it as `/contract.json`.
Do not introduce an external cron or a second writer.

## Git Hooks

`pnpm install` runs `lefthook install` through the root `prepare` script. The
configured pre-push hook runs:

```sh
pnpm run typecheck
pnpm test
```

The UI build/smoke and coverage gates run in CI and should be run locally when
the change touches UI, contract, or shared view-model behavior. Live provider
dry-runs are not hooked because they require credentials and sometimes specific
network access.

`pnpm-workspace.yaml` disables dependency postinstall builds except the explicit
tooling path used by the UI image. The Docker UI image installs with
`--ignore-scripts` and rebuilds only `esbuild`, because root `prepare` needs a
Git checkout and hooks are irrelevant inside the image.
