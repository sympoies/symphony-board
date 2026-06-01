# scripts/ — agent helper scripts

Small, read-only lookups for fast orientation. No build step — just run them.
They never mutate the store or the providers.

| Script | What it does |
|---|---|
| `devlog-search.sh <term> [YYYY-MM]` | Case-insensitive search of `docs/devlog/*.md` (optionally one month). |
| `contract-summary.sh [contract.json]` | Counts, per-source, items by kind/state, edges by type/lifecycle from an emitted contract (default `data/contract.json`). Needs `jq`. |
| `db-summary.sh [db_path]` | Sources, live items/edges, tombstones, and the latest sync run per source from the canonical SQLite store (default `data/symphony.db`). Opened **read-only** so the loop daemon stays the sole writer. Needs `sqlite3`. |

Examples:

```sh
scripts/devlog-search.sh gitlab
scripts/contract-summary.sh
scripts/db-summary.sh
```
