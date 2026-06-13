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

## Local Install Helper

| Script | What it does |
| --- | --- |
| `install-release-app.sh [PATH] [options]` | Installs a downloaded, unsigned macOS release. Extracts a release `.zip` (or takes an extracted `.app`), strips the `com.apple.quarantine` flag recursively, copies the bundle into `/Applications`, and opens it. Handles both the thin client and the standalone variants. With no `PATH`, picks the newest `Symphony-Board-*.zip` / `Symphony Board*.app` in `~/Downloads`. Options: `--no-install`, `--no-open`, `--resign`, `--downloads-dir DIR`. macOS only. |

```sh
scripts/install-release-app.sh
scripts/install-release-app.sh ~/Downloads/Symphony-Board-v1.1.0-macos-arm64-unsigned.zip
```

## Release Helper

| Script | What it does |
| --- | --- |
| `release.sh [--dry-run\|--execute\|--verify-only] [--version X.Y.Z]` | Cuts a GitHub Release that publishes the GHCR images and the unsigned macOS desktop assets. Refuses a dirty tree, a non-`main` branch, or a local `main` that differs from `origin/main`. See [../RELEASING.md](../RELEASING.md). |

```sh
scripts/release.sh --dry-run
scripts/release.sh --execute
```

## CI Helpers

| Script | What it does |
| --- | --- |
| `ci/coverage.sh` | Runs backend and UI logic coverage with `c8`, merges LCOV, and enforces the line floor. |
| `ci/coverage-summary.sh [lcov]` | Emits a Markdown coverage summary with worst-covered files. Used by CI job summary and PR comment. |
| `ci/coverage-badge.sh [lcov] [out.svg]` | Renders the self-hosted coverage badge SVG published from CI to the `coverage-badge` branch. |
| `ci/pg-e2e.sh` | Composes up a throwaway Postgres, runs the store-conformance suite with the Postgres driver registered plus the live e2e, then tears down. The `pnpm run test:pg-e2e` / CI `pg` gate. Needs Docker. |
| `ci/pg-compose-smoke.sh` | Builds the backend and UI images, starts the isolated `docker/compose.pg.yaml` stack, and asserts the served contract and `/api/stats` reporting `driver: "postgres"`. The `pnpm run test:pg-compose` / CI `pg_compose` gate. Needs Docker. |
| `package-desktop-release.sh [options]` | Builds the thin and standalone macOS `.app` bundles, zips them as unsigned release assets, and writes SHA256 sums. |

Coverage covers backend `.ts` files and UI `.ts` view-model logic. The React
`.tsx` layer is gated by the UI render-smoke, not by a percentage.

## Fixture Scripts

Provider fixture seeders and the UI probe live in
[`scripts/fixtures`](fixtures). The seeders mutate throwaway provider projects;
the probe is read-only against an already-served board.
