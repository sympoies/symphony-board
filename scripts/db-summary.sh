#!/usr/bin/env bash
# Summarize the canonical SQLite store: sources, items by source/state, edges by
# type/lifecycle, tombstones, and the latest sync run per source.
# Uses PRAGMA query_only (no writes) so the loop daemon stays the sole writer
# (see AGENTS.md). query_only — not sqlite3 -readonly — because -readonly cannot
# open a WAL-mode database (it can't set up the -shm; fails SQLITE_CANTOPEN/14).
# Usage: scripts/db-summary.sh [db_path]   (default: data/symphony.db)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
db="${1:-$ROOT/data/symphony.db}"

if [ ! -f "$db" ]; then
  echo "db not found: $db" >&2
  echo "  build one with: pnpm run init-db && pnpm run sync" >&2
  exit 1
fi

q() { sqlite3 -column -header "$db" "PRAGMA query_only=ON; $1"; }

echo "# sources"
q "SELECT source_id, kind, host FROM source ORDER BY source_id;"

echo
echo "# live items by source / kind / state"
q "SELECT source_id, kind, state, COUNT(*) AS n
     FROM item WHERE deleted_at IS NULL
     GROUP BY source_id, kind, state
     ORDER BY source_id, kind, state;"

echo
echo "# live edges by type / lifecycle"
q "SELECT type, lifecycle, COUNT(*) AS n
     FROM edge WHERE deleted_at IS NULL
     GROUP BY type, lifecycle
     ORDER BY type, lifecycle;"

echo
echo "# tombstoned (soft-deleted) items"
q "SELECT COUNT(*) AS tombstoned FROM item WHERE deleted_at IS NOT NULL;"

echo
echo "# latest sync run per source"
q "SELECT source_id, mode, status, started_at, items_seen, edges_seen, activities_seen
     FROM sync_run
     WHERE run_id IN (SELECT MAX(run_id) FROM sync_run GROUP BY source_id)
     ORDER BY source_id;"
