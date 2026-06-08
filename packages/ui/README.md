# @symphony-board/ui

Read-only web UI for the `symphony-board` contract. It imports DTO types from
`@symphony-board/contract`, fetches `./contract.json`, and renders the board,
graph, activity feed, repo analytics, and settings surface. It never reads
SQLite, provider APIs, or backend source modules.

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

The Board uses the shared URL-backed date range with quick presets (`today`,
`this week`, `1w`, `2w`, `1mo`, `3mo`). It filters cards by `updated_at` and
defaults to the Settings default range preset (`this week` for new browsers).
The summary pills on the Board are scoped to that same Board window: item totals
count the cards that survive the date-range filter, and edge lifecycle counts
cover relationships touching those windowed cards. If the loaded contract
contains a compatible `boardWindow` aggregate and no viewer-local filters are
active, the summary uses it; otherwise it computes from the visible items and
edges.

Contract v2 does not load all historical item rows. The Board renders primary
`item_window` rows only, while edge-endpoint extras stay available to the Graph.
Custom ranges are loaded through `/api/range`. Full totals still come from
compatible `aggregates[]` rows on the default static contract.

Cards show source, repo, iid, author, timestamps, demand, labels, draft state,
review/CI/merge signals, and optional repo/source highlight color. Cards with at
least one relationship include a graph-focus link.

### Graph (`#/graph`)

The Graph page renders edge-connected items with React Flow:

- `closes` edges are the workflow spine and are colored by lifecycle.
- `mentions` can be included for context.
- side-list search and kind filters keep large graphs navigable.
- the shared date range windows the overview.
- focusing an item narrows the canvas to that item's relationship
  neighborhood.
- Board card deep-links use `#/graph?focus=<ref>&q=<repo #iid>` so the graph is
  narrowed before it renders.

Graph summary pills are scoped to the graph currently being inspected. In the
overview they count rendered nodes and links after the date range,
mention toggle, mention target, search, and facet filters. In focus view they
switch to `focus` scope and count the focused subgraph instead of implying an
overview total. Contract `graphWindow` aggregates are used only for the default
no-mentions overview when the static range exactly matches an emitted aggregate
row; custom range responses and local graph controls fall back to
client-computed stats.

With contract v2, the default overview stays inside the loaded item window.
Board deep-link focus views can still inspect relationships present in the
emitted endpoint-closed edge set, but the static payload does not contain
relationships wholly outside the loaded window.

Untracked cross-repo endpoints render as unresolved refs.

### Activity (`#/activity`)

The Activity page renders `activities[]` newest first. It includes canonical
item transitions and provider activity records such as commits, pushes, and
branch/tag events.

Rows surface the most identifiable context available in the contract: issue and
change-request events show the provider number plus title, commits show a short
SHA plus commit title, and push/ref events show the branch or tag plus available
commit-range chips.

Activity uses the same date range as Board and Graph, plus the global search
box and source/kind filters. Search includes title, summary, actor, project
path, target metadata, and provider details; a `#<iid>` token matches
`target_iid` exactly. The page filters by range before the global
source/kind/search facets, then virtualizes the matching rows so large windows
keep the DOM bounded.

### Repo Analytics (`#/repo-analytics`)

Repo Analytics renders `repo_metrics[]`: per-repo totals, bucketed series,
bounded top actors, and data-quality metadata for the selected window.

The page uses the same URL-backed date range as Board, Graph, and Activity.
Default static contracts render their active-since repo metrics; custom ranges
load `/api/range` and render the returned time-range metrics. The table ranks
repos by activity and active items, then shows opened issue and PR/MR
throughput, closed/merged totals, compact trend bars, and a data-quality badge.

`repo_metrics[]` is not a full inventory surface. Settings and external
inventory consumers should use `repo_stats[]`; Repo Analytics uses
`repo_metrics[]` because it is explicitly scoped to the current date range.

### Settings (`#/settings`)

Settings is a browser-local display surface:

- hide/show individual repos
- hide/show whole sources
- choose the default shared date range preset
- set per-repo highlight color overrides

The choices are stored in `localStorage` and apply as a pre-filter across the
Board, Graph, Activity feed, and Repo Analytics before each page computes its
view. They are view-only; the daemon keeps syncing every configured source.

Repo rows use `repo_stats[]` when present so Settings keeps full repo counts
even though contract v2 `items[]` is windowed. Older v1 contracts fall back to
deriving repo counts from loaded items.

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
pnpm run emit --out packages/ui/public/contract.json
```

Runtime contracts under `data/` stay gitignored.

The standalone Vite dev server serves only the static sample contract. The
default `this week` range and other custom ranges call `/api/range`; use the
Docker stack for full local range-query testing.

## Smoke Test

`pnpm --filter @symphony-board/ui run smoke` runs
`packages/ui/scripts/render-smoke.mjs` against the built `dist/` in headless
Chrome. It asserts the Board, Graph, Activity feed, Repo Analytics, Settings,
deep-link search, focus path, and configured display colors render without
console errors. It also verifies that Board, Graph, Activity, and Repo Analytics
share the same range presets, that the Settings default-range selector renders,
that Board/Graph scoped summaries change when the range narrows through
`/api/range`, and that a large synthetic Activity feed stays virtualized.

Set `CHROME_BIN` if Chrome is not available at the default macOS path or through
the CI setup action.

## Real Data Wiring

The app fetches `./contract.json`. For local dev, write a contract into
`public/`:

```sh
pnpm run emit --out packages/ui/public/contract.json
pnpm --filter @symphony-board/ui dev
```

For deployment, use the repo's Docker Compose stack. The `web` service serves
the built UI, aliases the daemon-emitted `data/contract.json` to
`/contract.json`, and proxies `/api/` to the read-only range API sidecar. The UI
therefore reads the latest static contract and can request explicit date ranges
without becoming a database writer.
