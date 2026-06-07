# @symphony-board/ui

A read-only board that renders the symphony-board **contract** (LAYER 3). It is a
pure **consumer**: it imports types from `@symphony-board/contract`, fetches an
emitted `contract.json`, and renders it. It never touches the backend (`src/db`,
`src/sources`) — the contract package is the only boundary it can see.

Unlike the backend (no build, zero third-party deps), the UI is the deliberate
home for a build step + heavy deps — **Vite + React + TypeScript** (see
`docs/DESIGN.md`).

## What it shows

- **Header** — contract version / generator / emit time, and per-source health
  (last status + last success), so stale or `partial`/`error` sources are obvious.
- **Stats** — items by state and kind; edges by lifecycle (declared / fulfilled /
  broken). Reflects the current filter.
- **Filters** — free-text search (title / author / repo / label) plus source,
  state, and kind toggles. These are *transient* (in-memory) facets, distinct
  from the persistent **Settings** repo filter below.
- **Graph** (`#/graph`) — the relationship graph: issue ↔ PR/MR `closes` edges
  (plus opt-in `mentions`), coloured by derived lifecycle — `declared` = in
  flight, `fulfilled` = merged + closed, `broken` = closed unmerged. A cross-repo
  endpoint in an untracked project is shown by its ref. A side list beside the
  canvas carries the same detail as the board card (author, times, review/CI/merge
  signals, labels, source mark); clicking a card enters a **focus view** — that
  item plus its related items (the other ends of its edges, computed from the full
  edge set, so relations hidden by the “active since” window still list, flagged
  *off-window*) — and fits the camera to it and its on-graph neighbours.
- **Settings** (`#/settings`) — a persistent, client-side **display filter**:
  per-repo checkboxes (grouped by source, with each source's sync health and a
  select-all/none) that pre-filter the contract — items *and* their edges —
  across the Board, Graph, and stats. The choice is saved in `localStorage` and
  defaults to everything visible. It is view-only: the daemon keeps syncing every
  source (read-only consumer — no backend, no contract change).
- **Items** — cards with state/kind, draft flag, labels (scoped labels styled),
  author, demand, and the review / CI / merge signals when present.

## Run

```sh
pnpm install                 # from the repo root (workspace)
pnpm --filter @symphony-board/ui dev      # dev server (uses public/contract.json)
pnpm --filter @symphony-board/ui build    # tsc --noEmit + vite build -> dist/
pnpm --filter @symphony-board/ui preview  # serve the built dist/
pnpm --filter @symphony-board/ui smoke    # headless-render dist/ + assert it draws (needs build first)
```

`smoke` (`scripts/render-smoke.mjs`) renders the built board in headless Chrome
against the bundled sample contract and fails on a render crash or any console
error — the layer `tsc`/`build`/unit tests can't see. It runs in CI (`ui` job)
and locally (set `CHROME_BIN` if Chrome isn't at the macOS default path).

## Wiring real data

The app fetches `./contract.json` (relative). Point it at live data by dropping
the loop daemon's output next to the app, or regenerate the bundled sample:

```sh
pnpm run emit -- --out packages/ui/public/contract.json   # from the repo root
```

You can also load any contract file ad hoc via the "load contract.json" picker.
`public/contract.json` is a small **sample** (covers all three lifecycles, scoped
labels, the extension signals, and a cross-repo edge) so `dev`/`build` show
something out of the box.
