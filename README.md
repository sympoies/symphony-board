# symphony-board

Provider-agnostic work-item board. It aggregates issues and pull/merge requests
from **multiple sources** (GitHub and GitLab today, others later) into one
normalized **SQLite** store and emits a **versioned JSON contract** for a UI
(built later) and other consumers to read.

The organizing concept is the **issue ↔ PR/MR relationship** — modeled as a
typed, stateful edge — because that link is the backbone of a GitHub/GitLab
workflow.

> Full rationale and the decisions awaiting confirmation: [`docs/DESIGN.md`](docs/DESIGN.md).
> Contract versioning rules: [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Architecture: three layers

```
providers ──fetch──▶  [1] raw store        opaque provider payloads (insurance)
                          │ normalize (pure)
                          ▼
                      [2] canonical DB      item / edge / label / sync_* (SQLite)
                          │ buildContract (pure)
                          ▼
                      [3] contract          versioned JSON  ──▶  UI / consumers
```

- **Layer 1 (raw)** is kept verbatim so contract/normalization changes can be
  **replayed offline** — old records stay compatible without re-fetching.
- **Layer 2 (canonical)** is provider-agnostic and SQL-queryable.
- **Layer 3 (contract)** is a projection, versioned independently (semver). The
  DB schema and the contract evolve on separate clocks.

## Quick start

Requires **Node ≥ 24** (built-in TypeScript stripping and `node:sqlite`; no build
step, zero runtime dependencies). Node is managed with **fnm** (`.node-version`)
and the package manager is **pnpm** (`packageManager` in `package.json`).

```sh
fnm use                                   # picks Node 24 from .node-version
pnpm install                              # dev-only deps (typescript, @types/node)
pnpm run typecheck                        # tsc --noEmit (the type gate)
pnpm test                                 # node --test (pure logic + DB roundtrip)

cp config/sources.example.json config/sources.json   # then edit projects/tokens
export GITHUB_TOKEN=$(gh auth token)      # token per source's token_env
export GITLAB_TOKEN=glpat_…               # if a GitLab source is configured

pnpm run init-db                          # create/migrate the SQLite store
node src/cli/sync.ts --dry-run            # fetch + compute, write nothing
pnpm run sync                             # full sweep -> SQLite
pnpm run emit -- --out data/contract.json # emit the versioned contract
```

A source is skipped (with a warning) when its token env var is unset, so you can
start with GitHub only.

## Running continuously (the writer)

By design there is **no external cron**: a single Docker daemon is the sole
writer while the host is on, and can later move to an always-on server.

```sh
echo "GITHUB_TOKEN=ghp_xxx" > .env       # + GITLAB_TOKEN if used
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml logs -f
```

It loops `sync` + `emit` every `INTERVAL` seconds (default 300), persisting the
DB and the emitted contract to the bind-mounted `data/`. A GitLab source behind a
VPN requires the host to be on that VPN.

## Status

First version. Both sources validated live: GitHub end-to-end (incl. in the
Docker image), and GitLab against gitlab.com — including a **token-authenticated**
run against a private project that drives the full pipeline to contract `1.0.0`.
The UI is a later phase — this repo stabilizes the contract first. See
`docs/DESIGN.md` for the confirmed decisions and what's deferred.
