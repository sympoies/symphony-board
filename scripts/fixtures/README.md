# scripts/fixtures/

Provider fixture seeders and a UI probe for reviewing the end-to-end board. The
seeders mutate providers by creating or populating throwaway projects. Run them
only against fresh fixture targets.

The fixtures exercise:

- open, closed, merged, draft, and abandoned item states
- `closes` lifecycles: `declared`, `fulfilled`, `broken`
- GitHub and GitLab label shapes, including scoped labels
- GitLab mention/relate note parsing
- source/repo display colors in the emitted sample contract

| Script | What it does |
| --- | --- |
| `seed-github-fixture.sh [owner/repo]` | Seeds a GitHub fixture repo via `gh`. Default target is `sympoies/symphony-board-fixture`. Requires authenticated `gh`. |
| `seed-gitlab-fixture.mjs [namespace/path]` | Seeds a gitlab.com fixture project via REST. Default project is `symphony-board-fixture` under the token user's namespace. Requires `GITLAB_TOKEN` with API scope. |
| `verify-board.mjs` | Headless-Chrome CDP probe of an already-served board URL. Checks board columns, graph nodes, links, theme/link styling, and fixture-derived counts. Read-only against the UI. |

Example:

```sh
gh auth status
scripts/fixtures/seed-github-fixture.sh

GITLAB_TOKEN=glpat_xxx node scripts/fixtures/seed-gitlab-fixture.mjs

# Then sync/emit over the fixture sources, serve the UI, and probe it:
URL=http://localhost:8080/ node scripts/fixtures/verify-board.mjs
```

The SQLite store, runtime contract, `.env`, and `config/sources.json` remain
gitignored. Only the fixture scripts and the small UI sample contract are
tracked.
