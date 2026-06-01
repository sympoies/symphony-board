#!/usr/bin/env bash
# Summarize an emitted contract JSON: counts, per-source, items by kind/state,
# edges by type/lifecycle. Read-only.
# Usage: scripts/contract-summary.sh [path]   (default: data/contract.json)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
f="${1:-$ROOT/data/contract.json}"

if [ ! -f "$f" ]; then
  echo "contract not found: $f" >&2
  echo "  emit one with: pnpm run emit -- --out data/contract.json" >&2
  exit 1
fi

jq '{
  contract_version,
  generated_at,
  totals: { items: (.items | length), edges: (.edges | length) },
  items_by_source:    (.items | group_by(.source_id) | map({ (.[0].source_id): length }) | add),
  items_by_kind:      (.items | group_by(.kind)      | map({ (.[0].kind):      length }) | add),
  items_by_state:     (.items | group_by(.state)     | map({ (.[0].state):     length }) | add),
  edges_by_type:      (.edges | group_by(.type)      | map({ (.[0].type):      length }) | add),
  edges_by_lifecycle: (.edges | group_by(.lifecycle) | map({ (.[0].lifecycle // "null"): length }) | add)
}' "$f"
