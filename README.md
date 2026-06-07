# symphony-board

Provider-agnostic work-item board. It aggregates issues and pull/merge requests
from **multiple sources** (GitHub and GitLab today, others later) into one
normalized **SQLite** store and emits a **versioned JSON contract** that a
read-only **web UI** ([`packages/ui`](packages/ui)) and other consumers read.

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
- **Layer 3 (contract)** is a projection, versioned independently (semver), and
  lives in its own package [`@symphony-board/contract`](packages/contract) so a
  consumer cannot reach past it. The DB schema and the contract evolve on
  separate clocks.

This is a **pnpm workspace**: the backend (repo root, no build, zero
third-party runtime deps), [`packages/contract`](packages/contract) (LAYER 3:
schema + types), and [`packages/ui`](packages/ui) (the read-only viewer; Vite +
React, the one package with a build step).

## Quick start

The backend requires **Node ≥ 24** (built-in TypeScript stripping and
`node:sqlite`; no build step, zero third-party runtime dependencies). Node is
managed with **fnm** (`.node-version`) and the package manager is **pnpm**
(`packageManager` in `package.json`). The UI build lives in `packages/ui`.

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
DB and the emitted contract to the bind-mounted `data/`. The cadence is mostly
**incremental** (cheap, watermark-bounded) with a periodic **full sweep** every
`FULL_EVERY` iterations (default 12 ≈ hourly): a full sweep is what enables
disappearance handling — only a full + complete sweep may soft-delete items/edges
it no longer sees, so incremental alone never tombstones. Set `FULL_EVERY=1` to
always full-sweep. A GitLab source behind a VPN requires the host to be on that VPN.

**The daemon is the source of truth for the contract.** `data/contract.json` is
written *only* by this loop — never by hand — so what the UI serves (see
[Deploying the UI](#deploying-the-ui)) is always the daemon's latest emit. The
`board` service has a healthcheck that reports it `healthy` only while
`data/contract.json` keeps being refreshed, so a wedged daemon that stops emitting
is visible (`docker compose -f docker/compose.yaml ps`). Confirm the on-disk
contract is daemon-produced with the read-only helpers:

```sh
docker compose -f docker/compose.yaml ps          # board: healthy
scripts/db-summary.sh                              # items/edges/sync runs (query_only)
scripts/contract-summary.sh                        # counts from data/contract.json
```

## Deploying the UI

The same `docker compose` stack also serves the read-only board. The
[`web`](docker/compose.yaml) service builds `packages/ui`
([`docker/ui.Dockerfile`](docker/ui.Dockerfile), a multi-stage Vite build → nginx)
and serves it at a stable URL — no manual `vite preview`:

```sh
docker compose -f docker/compose.yaml up -d --build   # brings up board + web
open http://localhost:8080                            # the board
```

The sidecar serves the daemon-emitted `data/contract.json` directly (mounted
read-only; nginx aliases it to `/contract.json` — see
[`docker/ui-nginx.conf`](docker/ui-nginx.conf)), and `depends_on` the `board`
healthcheck, so it never serves before the first contract exists and always
renders the daemon's **latest** emit — consistent with "the daemon is the sole
writer." A fresh emit is picked up on reload (the contract is served `no-store`);
rebuild the image (`up -d --build`) only when the UI code itself changes. Change
the published port by editing the `web` service's `ports` mapping.

## Status

Both sources validated live: GitHub end-to-end (incl. in the Docker image), and
GitLab against gitlab.com — including a **token-authenticated** run against a
private project that drives the full pipeline to contract `1.0.0`.

Since the initial cut the contract pipeline was hardened and the UI landed:
- **Contract validator** — `emit` validates against the schema and refuses to
  ship an invalid contract (dependency-free; runs in CI).
- **Edge soft-delete** + **incremental loop cadence** — see above.
- **`packages/contract`** — LAYER 3 extracted into its own package.
- **`packages/ui`** — a read-only board (Vite + React) consuming the contract:
  source health, filters, grouping, label chips, and the issue ↔ PR/MR
  relationship view by lifecycle.

See `docs/DESIGN.md` for the confirmed decisions and what's still deferred.
