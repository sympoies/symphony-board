# scripts/

Small repository helper scripts. Most are read-only orientation tools; CI
coverage scripts write only their declared coverage/badge outputs.

## Read-only Helpers

| Script | What it does |
| --- | --- |
| `devlog-search.sh <term> [YYYY-MM]` | Case-insensitive search of `docs/devlog/*.md`, optionally limited to one month. |
| `contract-summary.sh [contract.json]` | Counts sources, items by kind/state, edges by type/lifecycle, and activity by kind/action from an emitted contract. Defaults to `data/contract.json`; requires `jq`. |
| `db-summary.sh [db_path]` | Summarizes sources, live/tombstoned items and edges, and latest sync runs with activity counts from the canonical SQLite store. Defaults to `data/symphony.db`; opens with `PRAGMA query_only`; requires `sqlite3`. |

Examples:

```sh
scripts/devlog-search.sh gitlab
scripts/contract-summary.sh
scripts/db-summary.sh
```

## CI Helpers

| Script | What it does |
| --- | --- |
| `ci/coverage.sh` | Runs backend and UI logic coverage with `c8`, merges LCOV, and enforces the line floor. |
| `ci/coverage-summary.sh [lcov]` | Emits a Markdown coverage summary with worst-covered files. Used by CI job summary and PR comment. |
| `ci/coverage-badge.sh [lcov] [out.svg]` | Renders the self-hosted coverage badge SVG published from CI to the `coverage-badge` branch. |

Coverage covers backend `.ts` files and UI `.ts` view-model logic. The React
`.tsx` layer is gated by the UI render-smoke, not by a percentage.

## Fixture Scripts

Provider fixture seeders and the UI probe live in
[`scripts/fixtures`](fixtures). The seeders mutate throwaway provider projects;
the probe is read-only against an already-served board.
