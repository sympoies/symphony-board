# @symphony-board/ui

Read-only web UI for the `symphony-board` contract. It imports DTO types from
`@symphony-board/contract`, fetches `./contract.json`, and renders the board,
graph, activity feed, and settings surface. It never reads SQLite, provider
APIs, or backend source modules.

The backend stays buildless. This package is the deliberate home for browser
dependencies and the Vite + React build.

## Pages

### Board (`#/`)

The primary board is a 7-column surface:

- status columns: `Open`, `In Progress`, `Trailing`, `Closed`
- Spotlight lanes: `Follow-up`, `Plan-tracking`, `PR`

Status is derived from item state plus relationship edges. Spotlight lanes are
cross-cuts based on label/kind conventions, so their counts do not sum to the
item total.

The Board has an item-local active-since window with quick presets (`1w`, `2w`,
`1mo`, `3mo`, `all`). It filters cards by `updated_at` and defaults to `3mo`.
The summary pills on the Board are scoped to that same Board window: item totals
count the cards that survive the active-since filter, and edge lifecycle counts
cover relationships touching those windowed cards.

Cards show source, repo, iid, author, timestamps, demand, labels, draft state,
review/CI/merge signals, and optional repo/source highlight color. Cards with at
least one relationship include a graph-focus link.

### Graph (`#/graph`)

The Graph page renders edge-connected items with React Flow:

- `closes` edges are the workflow spine and are colored by lifecycle.
- `mentions` can be included for context.
- side-list search and kind filters keep large graphs navigable.
- active-since presets window the overview.
- focusing an item narrows the canvas to that item's relationship
  neighborhood.
- Board card deep-links use `#/graph?focus=<ref>&q=<repo #iid>` so the graph is
  narrowed before it renders.

Graph summary pills are scoped to the graph currently being inspected. In the
overview they count rendered nodes and links after the active-since window,
mention toggle, mention target, search, and facet filters. In focus view they
switch to `focus` scope and count the focused subgraph instead of implying an
overview total.

Untracked cross-repo endpoints render as unresolved refs.

### Activity (`#/activity`)

The Activity page renders `activities[]` newest first. It includes canonical
item transitions and provider activity records such as commits, pushes, and
branch/tag events.

Activity shares the global search box plus source/kind filters. Search includes
title, summary, actor, project path, target metadata, and provider details; a
`#<iid>` token matches `target_iid` exactly.

The feed defaults to `this week`, where the week starts on Monday in local time
relative to the loaded contract's `generated_at`. Quick ranges are `1d`, `3d`,
`this week`, `1w`, `2w`, `1m`, and `all`. The page filters by range before the
global source/kind/search facets, then renders the newest 300 matching rows with
a `Show more` stepper for larger windows.

### Settings (`#/settings`)

Settings is a browser-local display surface:

- hide/show individual repos
- hide/show whole sources
- set per-repo highlight color overrides

The choices are stored in `localStorage` and apply as a pre-filter across the
Board, Graph, and Activity feed before each page computes its view. They are
view-only; the daemon keeps syncing every configured source.

Configured source/repo colors arrive on the contract (`sources[].color`,
`repos[]`). UI overrides beat configured repo colors, which beat source colors.
Only `#rgb` and `#rrggbb` values are accepted before reaching CSS.

## Run

From the repository root:

```sh
pnpm install
pnpm --filter @symphony-board/ui dev
pnpm --filter @symphony-board/ui run build
pnpm --filter @symphony-board/ui run test
pnpm --filter @symphony-board/ui run smoke
pnpm --filter @symphony-board/ui run preview
```

`dev` and `build` use `packages/ui/public/contract.json`, a tracked sample
contract that covers the important UI states. Regenerate it from local data when
you intentionally want to refresh the sample:

```sh
pnpm run emit -- --out packages/ui/public/contract.json
```

Runtime contracts under `data/` stay gitignored.

## Smoke Test

`pnpm --filter @symphony-board/ui run smoke` runs
`packages/ui/scripts/render-smoke.mjs` against the built `dist/` in headless
Chrome. It asserts the Board, Graph, Activity feed, Settings, deep-link search,
focus path, and configured display colors render without console errors. It also
verifies that Board and Graph scoped summaries change when their active-since
windows change.

Set `CHROME_BIN` if Chrome is not available at the default macOS path or through
the CI setup action.

## Real Data Wiring

The app fetches `./contract.json`. For local dev, write a contract into
`public/`:

```sh
pnpm run emit -- --out packages/ui/public/contract.json
pnpm --filter @symphony-board/ui dev
```

For deployment, use the repo's Docker Compose stack. The `web` service serves
the built UI and aliases the daemon-emitted `data/contract.json` to
`/contract.json`, so the UI always reads the latest contract produced by the
sole writer.
