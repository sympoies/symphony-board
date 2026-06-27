# symphony-board

[![CI](https://github.com/sympoies/symphony-board/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sympoies/symphony-board/actions/workflows/ci.yml)
[![Coverage](https://raw.githubusercontent.com/sympoies/symphony-board/coverage-badge/badges/coverage.svg)](https://github.com/sympoies/symphony-board/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/demo-live-82aaff)](https://sympoies.github.io/symphony-board/)

[![activity](docs/assets/readme-activity.png)](https://sympoies.github.io/symphony-board/demo/)

Read-only cross-provider workflow board for GitHub and GitLab. `symphony-board`
coordinates issues, pull requests, merge requests, activity, and typed
relationships from configured projects into a canonical store (SQLite by
default, Postgres by opt-in compose), emits a versioned JSON contract, and serves
a web UI from that contract.

The product surface is the contract plus UI. The database is an implementation
store, not the consumer API.

- Live demo: <https://sympoies.github.io/symphony-board/> - landing page plus a
  read-only board on a bundled sample contract
- Runbook: [docs/running.md](docs/running.md)
- Design rationale: [docs/DESIGN.md](docs/DESIGN.md)
- Contract rules: [docs/CONTRACT.md](docs/CONTRACT.md)
- Developer guide: [DEVELOPMENT.md](DEVELOPMENT.md)
- UI package: [packages/ui](packages/ui)
- Contract package: [packages/contract](packages/contract)

## Features

The full product path is implemented end to end:

- GitHub and GitLab sources fetch issues, change requests, review state,
  commits, comments, and repository/project activity.
- Raw provider payloads, canonical rows, labels, sync state, relationship
  edges, and activity rows are stored in the configured canonical store.
- `sync` supports full and incremental modes; only a full and complete sweep may
  soft-delete unseen items or edges.
- `emit` produces contract major v4, currently `4.6.0`, and validates the JSON
  envelope before writing.
- The UI renders the contract as a Board, relationship Graph, Activity feed,
  work-item log, Commits log, Review thread inbox, Repo Analytics view, and
  Settings surface.
- Docker Compose runs a sole-writer sync/emit daemon, a read-only API sidecar,
  a read-only web sidecar, and the least-privilege Live webhook receiver.
- Desktop and Android shells reuse the same read-only UI. The thin clients
  connect to a server; the standalone macOS app bundles the backend for a
  single-machine install.

Historical validation details and PR links live in [docs/devlog](docs/devlog).

## How It Works

```text
providers --fetch--> [1] raw store
                       opaque provider payloads
                       |
                       | normalize (pure)
                       v
                    [2] canonical DB
                       item / edge / activity / label / sync_*
                       |
                       | buildContract (pure)
                       v
                    [3] contract
                       versioned JSON -> UI / consumers
```

`normalize` maps raw provider records into canonical items and edges without
network or database IO. `buildContract` maps canonical rows into the semver
consumer surface. Because the raw payloads are retained, normalization and
contract changes can be replayed without re-fetching from providers.

The central model is the issue <-> PR/MR relationship. `closes` edges carry a
derived lifecycle:

- `declared`: linked work is still in flight or not yet fulfilled.
- `fulfilled`: change request merged and target issue closed.
- `broken`: change request closed without merging.

Activity rows are separate timestamped events. Items are current state; activity
records describe developer-significant events such as commits, comments,
branch/tag events, reviews, and issue or PR/MR state transitions. The full
architecture record lives in [docs/DESIGN.md](docs/DESIGN.md).

## Quick Start

Requirements:

- Node >= 24, normally selected with `fnm use` from `.node-version`
- pnpm >= 11, pinned by `packageManager`

```sh
fnm use
pnpm install

cp config/sources.example.json config/sources.json
$EDITOR config/sources.json

export GITHUB_TOKEN="$(gh auth token)"
# export GITLAB_TOKEN="glpat_xxx"   # only when a GitLab source is configured

pnpm run init-db
node src/cli/sync.ts --dry-run
pnpm run sync
pnpm run emit --out data/contract.json
pnpm run validate --in data/contract.json

# Starts Vite against the tracked sample contract for UI exploration.
pnpm --filter @symphony-board/ui dev
```

Credentials are referenced by env-var name in config and read from the
environment. Do not inline tokens or private keys in `config/sources.json`.
A source may set `"enabled": false` to stay in the config while being skipped by
sync runs. Runtime output under `data/` is gitignored; the tracked
`packages/ui/public/contract.json` is only the bundled UI sample.

Use [docs/running.md](docs/running.md) for the long-form runbook: advanced
GitHub auth pools, one-shot contract validation, local UI previews, Docker
SQLite/Postgres stacks, manual sync, config editing, Live webhooks, desktop
apps, Android builds, release zips, and inspection helpers.

## Workspace

This is a pnpm workspace:

- repo root: backend CLI, sync engine, SQLite/Postgres schema, sources, tests,
  CI helpers
- `packages/contract`: contract JSON Schema and TypeScript DTOs
- `packages/ui`: Vite + React read-only board
- `packages/desktop`: Tauri macOS shell for the UI
- `packages/android`: Tauri Android shell for the UI
- `packages/desktop-standalone`: Tauri macOS shell plus bundled backend sidecar

The backend runs TypeScript directly under Node 24 type stripping. There is no
backend build step; the Docker image installs root production runtime
dependencies so the lazy-loaded Postgres driver can resolve when a deployment
selects it. The UI is the deliberate home for browser dependencies and a build
step.

## Running Options

- Local UI development serves `packages/ui/public/contract.json`.
- Docker SQLite is the default continuous local stack at `http://localhost:8080`.
- Docker Postgres is the independent deployment-validation stack at
  `http://localhost:18080`.
- `packages/desktop` is a thin macOS client for a running server.
- `packages/desktop-standalone` is a single-machine macOS app that bundles the
  backend and stores data under the user's app data directory.
- `packages/android` is a thin Android shell; set the server URL in Settings or
  at build time with `VITE_SYMPHONY_BOARD_SERVER_URL`.

See [docs/running.md](docs/running.md) for exact commands and operational
boundaries.

## Contract

The current emitted contract is major v4, currently `4.6.0`. The canonical
schema, field semantics, version rules, and full version history live in
[docs/CONTRACT.md](docs/CONTRACT.md). The TypeScript DTO and JSON Schema entry
point is [`@symphony-board/contract`](packages/contract).

Consumers must branch on contract major and ignore unknown fields within a
major. Producers validate strictly before emitting.

Display colors are contract metadata, read from config at emit time and never
stored in the canonical store. The UI resolves highlight color in this order:

```text
browser repo override -> repos[] color -> sources[].color -> no highlight
```

## Development

Before editing behavior or the data model, read [DEVELOPMENT.md](DEVELOPMENT.md)
plus the relevant design or contract document. The normal backend gate is:

```sh
pnpm run typecheck
pnpm test
```

Run the UI, Postgres, coverage, desktop, Android, or provider dry-run gates
when the change touches those paths. `DEVELOPMENT.md` owns contributor workflow
and validation details; [docs/running.md](docs/running.md) owns operational
runbooks.
