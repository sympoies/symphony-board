# scripts/fixtures/ — review fixture seeders

Reproduce the throwaway provider fixtures the UI is reviewed against. Unlike the
read-only helpers in [`../`](../README.md), these **mutate the providers**: they
create a fresh repo/project and seed issues + PR/MRs spanning every item state
and edge lifecycle (`declared` / `fulfilled` / `broken`), plus scoped + plain
labels and a draft change request. Run each once against a **fresh** target.

| Script | What it does |
|---|---|
| `seed-github-fixture.sh [owner/repo]` | Seeds a GitHub fixture repo (default `graysurf/symphony-board-fixture`) via `gh`. Requires an authenticated `gh`. |
| `seed-gitlab-fixture.mjs [namespace/path]` | Seeds a gitlab.com fixture project (default `symphony-board-fixture` under the token's namespace) via the REST API. Requires `GITLAB_TOKEN` (api scope). |
| `verify-board.mjs` | Headless-Chrome CDP probe of an **already-served** board URL: board-column heights, Night Owl theme, new-tab anchor audit, and graph node / mention counts. Read-only against the UI. |

```sh
# 1. seed the fixtures (once, against fresh targets)
gh auth status                                   # GitHub seeder uses gh
scripts/fixtures/seed-github-fixture.sh
GITLAB_TOKEN=glpat_… node scripts/fixtures/seed-gitlab-fixture.mjs

# 2. sync + emit a contract over the fixture sources (see README "Quick start"),
#    then serve the UI (see "Deploying the UI") and probe it:
URL=http://localhost:8080/ node scripts/fixtures/verify-board.mjs
```

The emitted contract, the SQLite store, and `config/sources.json` stay
gitignored — only these seeders are tracked, so the fixture is reproducible
without committing provider data.
