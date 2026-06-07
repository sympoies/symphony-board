# DEVELOPMENT.md

Developer guide for `symphony-board`. For the overview and architecture see
`README.md`; for the design rationale and open questions see `docs/DESIGN.md`.

## Runtime: TypeScript via Node 24 (no build step)

Scripts are TypeScript run directly under Node 24's built-in type stripping —
**no build, no `dist/`**. Node strips types but does not check them, so
`tsc --noEmit` (`pnpm run typecheck`) is the gate. `node:sqlite` is the DB driver
(built in, experimental — runs pass `--disable-warning=ExperimentalWarning`).
There are **zero runtime dependencies**; dev deps are only `typescript` and
`@types/node`.

Toolchain: **fnm** manages Node (the version is pinned in `.node-version`; run
`fnm use`), and **pnpm** is the package manager (version pinned via
`packageManager` in `package.json`; `pnpm install` reads `pnpm-lock.yaml`).

## Layout

```text
schema/0001_init.sql          # canonical DB DDL (normative; applied at runtime)
schema/contract.schema.json   # contract envelope JSON Schema (normative)
src/model/                    # canonical types + pure helpers (ref, labels, edges)
src/contract/                 # contract version, DTO types, buildContract (pure), validate (dep-free)
src/sources/                  # Source interface + github/gitlab impls + registry + gql client
src/db/                       # open+migrate (node:sqlite), repo (upserts + queries)
src/sync-engine.ts            # fetch -> raw -> normalize -> reconcile -> upsert -> soft-delete
src/cli/                      # init-db, sync, emit-contract, validate-contract
test/                         # node --test: pure logic + in-memory DB roundtrip
docker/                       # loop-daemon image: Dockerfile, entrypoint, compose.yaml (sole writer)
```

Convention (same as the predecessor repo): **pure logic stays testable and free
of IO** — `src/model/*` and `src/contract/build.ts` have no network/DB. Network
lives in `src/sources/*`; DB IO in `src/db/*`; orchestration in `sync-engine.ts`.
`normalize` MUST stay pure so it is replayable against stored raw.

## Validate a change

```sh
pnpm run typecheck && pnpm test
# live smoke (uses your gh token against whatever config you point at):
GITHUB_TOKEN=$(gh auth token) node src/cli/sync.ts --config data/smoke.config.json --dry-run
# validate an emitted contract against the normative schema:
pnpm run validate -- --in data/contract.json
```

`emit` validates the envelope against `schema/contract.schema.json` before
writing and **refuses to ship** an invalid contract (the producer guard — the
contract is the product surface). The validator is dependency-free
(`src/contract/validate.ts`, a JSON-Schema subset), so it adds no runtime deps;
`pnpm run validate` checks an existing file, and `test/validate.test.ts` runs it
in CI. `--no-validate` on `emit` is an escape hatch if the validator ever
rejects a legitimate payload.

A dry-run fetches and normalizes but writes nothing — it reports per-source
`status / items / edges / softDeleted`. Two back-to-back full syncs converge
(upserts are idempotent on `(source_id, external_id)`); genuine provider churn
between runs is expected and is not a determinism bug.

### Git hooks (lefthook)

`pnpm install` auto-wires a **pre-push** hook (the `prepare` script runs
`lefthook install`; config in `lefthook.yml`) that runs `typecheck` + `test` in
parallel before every push — the same gate as CI, with no manual setup on a
fresh clone. The live `--dry-run` smoke is deliberately *not* gated (it needs a
token and a possibly VPN-bound GitLab), and conventional-commit format stays
owned by the commit flow, so there is no commit-msg hook. Bypass once with
`git push --no-verify`, or disable locally with `LEFTHOOK=0`.

> lefthook ships a postinstall build script; pnpm 11 blocks it by default, so
> `pnpm-workspace.yaml` sets `allowBuilds: { lefthook: false }` — we wire hooks
> through our own `prepare` script instead of trusting the dependency's
> postinstall, which also keeps `pnpm install` at exit 0.

The same checks are exposed as `.agents/scripts/pre-pr.sh` (the agent pre-PR
validation dispatcher); `.agents/scripts/bootstrap.sh` and `deploy.sh` wrap
`pnpm install --frozen-lockfile` and the docker loop-daemon bring-up.

### e2e testing approach

Pure logic and the DB roundtrip are covered by `node --test`. For provider
paths, prefer **recorded fixtures → golden contract** assertions (deterministic,
offline) plus a thin **live smoke** test; do not gate CI on reaching a live
GitLab instance (it may be VPN-bound). Fixtures are not yet committed — adding a
`test/fixtures/` capture of a raw payload and asserting `normalize` output is the
next test to write.

## Adding a source (point 6)

1. Implement `src/sources/types.ts::Source` — `fetch` (impure: network) returning
   `RawRecord[]` + watermark + `complete`, and `normalize` (PURE) returning a
   `NormalizedBundle` (item + labels + edges).
2. Register it in `src/sources/registry.ts` under a new `kind`.
3. The DB and contract are unchanged. Use open vocabularies for `kind` / edge
   `type`; key identity on the provider's immutable global id.

## Changing the schema / contract

- DB: add a `schema/NNNN_*.sql` migration (never edit an applied one) and append
  it to `MIGRATIONS` in `src/db/open.ts`. Tracked by `PRAGMA user_version`.
- Contract: follow `docs/CONTRACT.md` (edit schema + `src/contract/types.ts`
  together, bump `CONTRACT_VERSION`, add a test).

## Token & secrets

Tokens are referenced by env-var name in `config/sources.json` (gitignored) and
read from the environment — never inlined or committed. The DB (`*.db`), emitted
contracts, `.env`, and `config/sources.json` are all gitignored.
