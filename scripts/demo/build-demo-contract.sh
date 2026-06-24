#!/usr/bin/env bash
# Regenerate the GitHub Pages demo contract (site/demo-contract.json) from the
# public-only sources in config/sources.demo.json.
#
# This is the product's normal sync -> emit pipeline pointed at PUBLIC repos only
# (the sympoies org on GitHub + gitlab-org/labkit on GitLab.com), so the demo at
# https://sympoies.github.io/symphony-board/demo renders real data whose every
# item / commit / review / activity links to a live provider URL.
#
# The output is a FROZEN one-shot snapshot: it is committed to the repo and served
# verbatim, so the demo shows identical data and dates on every visit. Re-run this
# only when you want to refresh the snapshot, then commit the result.
#
# Requires two env vars (referenced by name from the config, never inlined):
#   GITHUB_TOKEN  any token with public read; `gh auth token` works.
#   GITLAB_TOKEN  a gitlab.com PAT with read_api (public read).
#
# Usage:
#   GITHUB_TOKEN=$(gh auth token) GITLAB_TOKEN=glpat-... scripts/demo/build-demo-contract.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
cd "$repo_root"

config="config/sources.demo.json"
out="site/demo-contract.json"
node_bin="node --disable-warning=ExperimentalWarning"

: "${GITHUB_TOKEN:?set GITHUB_TOKEN (e.g. GITHUB_TOKEN=\$(gh auth token))}"
: "${GITLAB_TOKEN:?set GITLAB_TOKEN to a gitlab.com PAT with read_api}"

# Throwaway store: data/*.db is gitignored, and the demo snapshot is the only
# artifact we keep. Start clean so a removed/renamed upstream item cannot linger.
db_path="$($node_bin -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).db_path)' "$config")"
echo "demo: resetting throwaway store $db_path"
rm -f "$db_path"

echo "demo: init-db"
$node_bin src/cli/init-db.ts "$config"

echo "demo: full sync (public repos)"
$node_bin src/cli/sync.ts --config "$config" --full

echo "demo: emit + validate -> $out"
$node_bin src/cli/emit-contract.ts --config "$config" --out "$out"

echo "demo: done. Snapshot summary:"
scripts/contract-summary.sh "$out" || true
