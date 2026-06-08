#!/usr/bin/env bash
# Read-only scan for actor-identity / bot-filter config maintenance. Prints
# ready-to-paste suggestions for config/sources.json (identities[] and
# exclude_actors[]). Never writes. See ../SKILL.md for the full workflow.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  project-actor-identities.sh [--json] [--db <path>] [--config <path>]

Read-only. Scans the canonical store + current config and reports:
  - NEW same-person candidates (commit name == an existing username), as
    ready-to-paste "identities" objects;
  - likely bot candidates for "exclude_actors";
  - uncertain pairs to review by hand.

Options:
  --json            Emit the report as JSON.
  --db <path>       SQLite store (default: <repo>/data/symphony.db).
  --config <path>   Config file (default: <repo>/config/sources.json).
  -h, --help        Show this help.

Requires Node 24 (node:sqlite); honors the repo's .node-version via fnm.
USAGE
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

NODE=(node)
if command -v fnm >/dev/null 2>&1; then
  NODE=(fnm exec --using "$(cat .node-version 2>/dev/null || echo 24)" node)
fi

exec "${NODE[@]}" --disable-warning=ExperimentalWarning "$DIR/scan-actors.mjs" "$@"
