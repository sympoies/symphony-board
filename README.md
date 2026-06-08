# symphony-board

[![CI](https://github.com/sympoies/symphony-board/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sympoies/symphony-board/actions/workflows/ci.yml)
[![Coverage](https://raw.githubusercontent.com/sympoies/symphony-board/coverage-badge/badges/coverage.svg)](https://github.com/sympoies/symphony-board/actions/workflows/ci.yml)

Provider-agnostic work-item board for GitHub and GitLab. It syncs issues and
pull/merge requests from configured projects into a local SQLite store, derives
typed relationships between them, emits a versioned JSON contract, and serves a
read-only web UI from that contract.

The product surface is the contract plus UI. The database is an implementation
store, not the consumer API.

- Design rationale: [docs/DESIGN.md](docs/DESIGN.md)
- Contract rules: [docs/CONTRACT.md](docs/CONTRACT.md)
- Developer guide: [DEVELOPMENT.md](DEVELOPMENT.md)
- UI package: [packages/ui](packages/ui)
- Contract package: [packages/contract](packages/contract)

## Current Baseline

The basic product path is implemented:

- GitHub and GitLab GraphQL sources fetch issues and change requests; REST
  activity surfaces add commit and repository/project event records.
- Raw provider payloads, canonical rows, labels, sync state, relationship
  edges, and activity rows are stored in SQLite.
- `sync` supports full and incremental modes; only a full and complete sweep may
  soft-delete unseen items or edges.
- `emit` produces contract major v2, currently `2.5.0`, and validates the JSON
  envelope before writing.
- The UI renders the contract as a 7-column Board, a relationship Graph, an
  Activity feed, a GitHub-like Commits log, a Repo Analytics table/trend view,
  and persistent Settings. Board, Graph, Activity, Commits, and Repo Analytics
  share one URL-backed date-range control with a browser-local default preset.
- Docker Compose runs the sync/emit loop as the sole writer, a read-only range
  API sidecar over SQLite, and a read-only web sidecar over the latest emitted
  contract.
- CI runs backend checks, UI build/tests/render-smoke, and a combined
  logic-tier coverage gate.

Historical validation details and PR links live in [docs/devlog](docs/devlog).

## Architecture

```text
providers --fetch--> [1] raw store
                       opaque provider payloads
                       |
                       | normalize (pure)
                       v
                    [2] canonical DB
                       item / edge / activity / label / sync_* in SQLite
                       |
                       | buildContract (pure)
                       v
                    [3] contract
                       versioned JSON -> UI / consumers
```

- **Layer 1: raw store** keeps the latest opaque provider payload per entity.
  This lets normalization or contract changes be replayed without re-fetching
  from providers.
- **Layer 2: canonical DB** is provider-agnostic and queryable. It is optimized
  for sync, reconciliation, and local inspection.
- **Layer 3: contract** is the semver consumer surface. It is defined in
  [`@symphony-board/contract`](packages/contract) and emitted by the backend.

The central model is the issue <-> PR/MR relationship. `closes` edges carry a
derived lifecycle:

- `declared`: work is linked but not fulfilled.
- `fulfilled`: change request merged and target issue closed.
- `broken`: change request closed without merging.

The graph also supports non-lifecycle edges such as `mentions` and `relates`
where a provider exposes enough information.

Activity rows are separate from items and edges. Items are current state;
activity records are timestamped developer-significant events such as commit
pushes, branch/tag events, and issue or PR/MR open/close/merge transitions.
Commit activity details may include the full commit body and the provider
default branch/ref when the REST source exposes that metadata.

## Workspace

This is a pnpm workspace:

- repo root: backend CLI, sync engine, SQLite schema, sources, tests, CI helpers
- `packages/contract`: contract JSON Schema and TypeScript DTOs
- `packages/ui`: Vite + React read-only board

The backend runs TypeScript directly under Node 24 type stripping. It has no
third-party runtime dependency requirement in the Docker image; the UI is the
deliberate home for browser dependencies and a build step.

## Quick Start

Requirements:

- Node >= 24, normally selected with `fnm use` from `.node-version`
- pnpm >= 11, pinned by `packageManager`

```sh
fnm use
pnpm install

pnpm run typecheck
pnpm test
pnpm --filter @symphony-board/ui run build
pnpm --filter @symphony-board/ui run test
pnpm --filter @symphony-board/ui run smoke
pnpm coverage
```

Configure sources:

```sh
cp config/sources.example.json config/sources.json
$EDITOR config/sources.json

export GITHUB_TOKEN="$(gh auth token)"
export GITLAB_TOKEN="glpat_xxx"   # only when a GitLab source is configured
```

Tokens are referenced by env-var name in config and read from the environment.
Do not inline tokens in `config/sources.json`.

Initialize and run one full sync:

```sh
pnpm run init-db
node src/cli/sync.ts --dry-run
pnpm run sync
pnpm run emit --out data/contract.json
pnpm run validate --in data/contract.json
```

A source is skipped with a warning when its token env var is unset. `--dry-run`
fetches and normalizes but writes nothing.

Useful sync flags:

```sh
node src/cli/sync.ts --incremental
node src/cli/sync.ts --source github:github.com
node src/cli/sync.ts --config path/to/sources.json --dry-run
```

## Run The UI Locally

The UI fetches `./contract.json` relative to the app.

```sh
pnpm run emit --out packages/ui/public/contract.json
pnpm --filter @symphony-board/ui dev
```

For a production-style local check:

```sh
pnpm --filter @symphony-board/ui run build
pnpm --filter @symphony-board/ui run preview
```

The tracked `packages/ui/public/contract.json` is a small sample contract for
development and smoke tests. UI-only dev serves the static contract file; use
the Docker stack when testing the default `this week` range or other custom date
ranges through `/api/range`.
Runtime output under `data/` remains gitignored.

## Run Continuously

Docker Compose runs three services:

- `board`: the sole writer. It loops `sync` and `emit`.
- `api`: a read-only Node sidecar. It opens SQLite with `query_only` and serves
  `GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD`.
- `web`: a read-only nginx sidecar that serves the built UI and the daemon's
  latest `data/contract.json` as `/contract.json`, and proxies `/api/` to
  `api`.

```sh
echo "GITHUB_TOKEN=ghp_xxx" > .env
# add GITLAB_TOKEN=... if configured
cp config/sources.example.json config/sources.json
$EDITOR config/sources.json

docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml ps
open http://localhost:8080
```

The daemon defaults to `INTERVAL=120` seconds and `FULL_EVERY=30`, which means a
full sweep on the first loop and then about once per hour, with incremental
runs about every 2 minutes in between. Set `FULL_EVERY=1` to always full-sweep.

Only full, complete sweeps can tombstone disappeared items and intra-source
edges. Partial, failed, and incremental runs never delete.

Read-only inspection helpers:

```sh
scripts/db-summary.sh
scripts/contract-summary.sh
scripts/devlog-search.sh graph
```

## Contract And Display Metadata

The current emitted contract is major v2, currently `2.5.0`.

Version `1.1.0` added display colors:

- optional `sources[].color`
- optional sparse top-level `repos[]`

Colors are display metadata. They are read from config at emit time, validated
as `#rgb` or `#rrggbb`, and never stored in SQLite. The UI resolves highlight
color as:

```text
localStorage repo override -> configured repo color -> configured source color -> none
```

Version `1.2.0` added optional top-level `activities[]`, a newest-first feed of
developer-significant records. Existing v1 consumers can keep reading
`env.activities ?? []` and ignore it when unsupported.

Version `1.3.0` added optional `aggregates[]`: server-computed totals for
`global`, `boardWindow`, and `graphWindow` scopes, including active-since window
metadata. These aggregates describe the emitted contract before viewer-local
filters such as Settings visibility, search, facets, Graph mention toggles, or
focus targets. The UI uses them only when the visible scope/window/filter is an
exact match and computes locally otherwise.

Version `2.0.0` changes `items[]` from the full live item set to a windowed
payload: the default 90-day Board item window plus extra relationship endpoints
needed by emitted edges. Full item totals stay in `aggregates[]`; Settings repo
counts use `repo_stats[]`; `item_window` describes the loaded window and whether
the payload is truncated.

Version `2.1.0` adds optional `range_query` metadata for read-only range API
responses. Static emits usually omit it; `/api/range` includes it and returns a
windowed contract for the requested UTC date range.

Version `2.2.0` adds optional top-level `repo_metrics[]`: per-repo windowed
analytics totals, bucketed series, top bounded actors, and data-quality
metadata. `repo_stats[]` remains the full inventory count surface for Settings
and external consumers; `repo_metrics[]` is range-scoped and powers the Repo
Analytics page.

Version `2.3.0` adds a canonical actor identity to `repo_metrics[].top_actors[]`:
each row gains `actor_key` (a stable, non-PII identity — provider username,
hashed commit email, or normalized name), `display_name`, and optional
`aliases`, so one human collapses to one row instead of duplicating across a
provider username and several commit author names. `actor` stays as a
backward-compatible display field.

Version `2.4.0` adds optional `repo_metrics[].totals.activity_score` and
matching bucketed `series[].stats.activity_score`. The score is a weighted
activity signal derived from commits, issue openings, PR/MR openings and merges,
comments, reviews, and approvals; the UI rounds it for display but sorts by the
raw decimal value.

Version `2.5.0` adds `repo_metrics[].data_quality.last_activity_at`, the most
recent observed activity instant per repo (the counterpart to the earliest
`observed_since`). The Repo Analytics page renders it as "last active".

Consumers must branch on contract major and ignore unknown fields within a
major. Producers validate strictly before emitting.

## Testing Model

CI has three separate checks:

- backend/root: `pnpm run typecheck` and `pnpm test`
- UI: `pnpm --filter @symphony-board/ui run build`, UI tests, and render-smoke
- coverage: `pnpm coverage`, a combined line-coverage floor over backend `.ts`
  and UI `.ts` logic

The React `.tsx` component layer is not folded into the coverage percentage.
Bundled browser coverage reports misleading near-100% loaded code, so the UI
component gate is the headless Chrome render-smoke instead.

When touching a source or the sync engine, also run a real `--dry-run` against a
safe config if credentials/network access are available. Prefer recorded or
throwaway fixtures over live provider calls in automated tests.
