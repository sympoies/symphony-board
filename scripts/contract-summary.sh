#!/usr/bin/env bash
# Summarize an emitted contract JSON: counts, per-source, items by kind/state,
# edges by type/lifecycle, activity by kind/action, aggregate rows, and v2
# item-window metadata.
# Read-only.
# Usage: scripts/contract-summary.sh [path]   (default: data/contract.json)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
f="${1:-$ROOT/data/contract.json}"

if [ ! -f "$f" ]; then
  echo "contract not found: $f" >&2
  echo "  emit one with: pnpm run emit --out data/contract.json" >&2
  exit 1
fi

jq '{
  contract_version,
  generated_at,
  item_window: (.item_window // null),
  totals: {
    loaded_items: (.items | length),
    total_items: ((.item_window.total_items // (.items | length))),
    primary_items: (.item_window.primary_items // (.items | length)),
    edge_endpoint_items: (.item_window.edge_endpoint_items // 0),
    edges: (.edges | length),
    activities: ((.activities // []) | length),
    aggregates: ((.aggregates // []) | length),
    repo_stats: ((.repo_stats // []) | length)
  },
  items_by_source:    (.items | group_by(.source_id) | map({ (.[0].source_id): length }) | add),
  items_by_kind:      (.items | group_by(.kind)      | map({ (.[0].kind):      length }) | add),
  items_by_state:     (.items | group_by(.state)     | map({ (.[0].state):     length }) | add),
  edges_by_type:      (.edges | group_by(.type)      | map({ (.[0].type):      length }) | add),
  edges_by_lifecycle: (.edges | group_by(.lifecycle) | map({ (.[0].lifecycle // "null"): length }) | add),
  activities_by_kind: (((.activities // []) | group_by(.kind)   | map({ (.[0].kind):   length }) | add) // {}),
  activities_by_action: (((.activities // []) | group_by(.action) | map({ (.[0].action): length }) | add) // {})
}' "$f"
