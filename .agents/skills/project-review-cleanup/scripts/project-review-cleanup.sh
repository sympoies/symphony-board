#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  project-review-cleanup.sh [options]

Options:
  --contract PATH   Contract to scan (default: data/contract.json).
  --repo OWNER/REPO GitHub repository to verify (default: all GitHub repos in
                    the contract; origin for live-only without a contract).
  --pr NUMBER       Focus one PR and allow live-only verification.
  --days N          Contract lookback window (default: 7).
  --actor LOGIN     Allowlisted bot actor; repeatable.
  --all-actors      Report candidates from every actor.
  --limit N         Maximum contract candidates (default: 20).
  --no-live         Skip provider live verification.
  --apply           Resolve safe allowlisted bot review threads.
  --disposition-file PATH
                    JSON file of agent-inspected thread dispositions. In
                    --apply mode, only listed safe threads are resolved.
  --resolution-note TEXT
                    Provider-visible note to reply before resolving threads.
                    Defaults to a stale-thread disposition note in --apply mode.
  --no-resolution-note
                    Resolve without posting a provider-visible note.
  --json            Emit JSON.
  -h, --help        Show this help.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir/../../../.." rev-parse --show-toplevel)"

if command -v fnm >/dev/null 2>&1 && [ -f "$repo_root/.node-version" ]; then
  exec fnm exec --using "$repo_root/.node-version" -- node "$script_dir/review-cleanup.mjs" "$@"
fi

exec node "$script_dir/review-cleanup.mjs" "$@"
