# @symphony-board/ui

Read-only web UI for the `symphony-board` contract. It imports DTO types from
`@symphony-board/contract`, fetches `./contract.json`, and renders the board,
graph, activity feed, commits log, repo analytics, and settings surface. It
never reads SQLite, provider APIs, or backend source modules.

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
- the side list indexes every relationship candidate in the selected range; the
  canvas can still hide mention-only items for the default overview, and those
  list cards are marked `not drawn`.
- side-list search and kind filters keep the relationship inventory navigable.
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

Rows link to `activities[].url` when the producer supplied a reliable provider
destination. Unlinked rows are intentional; the UI does not reconstruct provider
URLs locally.

Activity uses the same date range as Board and Graph, plus the global search
box and source/kind filters. Search includes title, summary, actor, project
path, target metadata, and provider details; a `#<iid>` token matches
`target_iid` exactly. The page filters by range before the global
source/kind/search facets, then virtualizes the matching rows so large windows
keep the DOM bounded.

### Commits (`#/commits`)

The Commits page renders a commit-only SCM log over `activities[]`, visually
separate from the mixed Activity feed. It uses the shared URL-backed date range
and page-local SCM filters:

- repo: self-styled typeahead over repos with commits in the loaded window
- branch: enabled only when commit rows carry `details.ref`, `details.refs`,
  `details.branch`, or `details.branches`

Rows group by commit date, link the commit message to the provider commit URL,
show provider/repo/actor metadata, expose short SHAs with copy buttons, and
offer an inline body toggle when `details.body` is present. Current live sources
annotate REST commit rows with the default branch/ref when repository metadata
is available; richer multi-branch membership can still use `refs` / `branches`.
Provider-specific signals such as GitHub Verified or check counts are omitted
until the contract has comparable GitHub and GitLab semantics.

### Repo Analytics (`#/repo-analytics`)

Repo Analytics renders `repo_metrics[]`: per-repo totals, bucketed series,
bounded top actors, and data-quality metadata for the selected window.

The page uses the same URL-backed date range as Board, Graph, Activity, and
Commits. Default static contracts render their active-since repo metrics; custom
ranges load `/api/range` and render the returned time-range metrics. The table
ranks repos by contract `activity_score`, then shows activity, commits, opened
issue and PR/MR throughput, closed/merged totals, review counts with approval
tooltips, compact trend bars, and a data-quality badge.

Repo labels link to `repo_metrics[].repo_url` when present. Non-zero metric values
deep-link to source-aware Activity or Commits routes for the same selected date
range so repeated provider paths from different sources stay distinct.

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
Board, Graph, Activity feed, Commits log, and Repo Analytics before each page
computes its view. They are view-only; the daemon keeps syncing every configured
source.

Repo rows use `repo_stats[]` when present so Settings keeps full repo counts
even though contract v2 `items[]` is windowed. Older v1 contracts fall back to
deriving repo counts from loaded items.

Configured source/repo colors arrive on the contract (`sources[].color`,
`repos[]`). UI overrides beat configured repo colors, which beat source colors.
Only `#rgb` and `#rrggbb` values are accepted before reaching CSS.

## Manual Sync

A browser reload only re-reads the latest emitted `contract.json`; it does not
ask providers for new data. When the board daemon's writer-owned control surface
is reachable (`./api/sync-control` answers `enabled: true`), the Header shows a
**Sync** action that triggers a real provider sync + contract emit, and Settings
adds a **Manual sync** section for full sweeps, dry-runs, and source-scoped runs.

- The Header action runs an incremental sync of every source.
- While a run is active the button is disabled and shows `Syncing`; the UI polls
  the run and, on a successful non-dry run, reloads `./contract.json` (and the
  active `/api/range` response) in place — the route, search, filters, time range,
  and display preferences are preserved.
- A dry-run reports `Dry-run completed` and never reloads the data view; a failed
  run reports the error and does not present stale data as fresh.
- A second request while a run is active is reported as "already running" rather
  than starting a second sync (the daemon owns one writer lock).
- When the control surface is absent or `enabled: false`, the affordance is
  hidden. The client treats a missing/unreachable surface as simply unavailable.

The UI is still read-only with respect to providers: this only triggers a local
provider-read sync owned by the daemon; it never writes back to a provider.

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
Chrome. It asserts the Board, Graph, Activity feed, Commits log, Repo Analytics,
Settings, deep-link search, focus path, and configured display colors render
without console errors. It also verifies that Board, Graph, Activity, Commits,
and Repo Analytics share the same range presets, that the Settings default-range
selector renders, that Board/Graph scoped summaries change when the range
narrows through `/api/range`, and that large synthetic Activity/Commits feeds
stay virtualized. It also mocks the daemon's sync control surface to assert the
Header Sync action renders, enters the running (disabled) state on click, shows
the reloaded status on completion, and that Settings exposes the advanced
manual-sync controls.

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
`/contract.json`, proxies `/api/range` to the read-only range API sidecar, and
proxies the sync-control routes (`/api/sync-control`, `/api/sync-runs`) to the
`board` daemon. The UI therefore reads the latest static contract, can request
explicit date ranges, and can trigger a daemon-owned manual sync — all without
becoming a database writer itself.
