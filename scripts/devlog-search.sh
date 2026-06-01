#!/usr/bin/env bash
# Search the development log (docs/devlog/*.md).
# Usage: scripts/devlog-search.sh <term> [YYYY-MM]
#   <term>    case-insensitive search string (required)
#   YYYY-MM   restrict to one month file (optional)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/docs/devlog"
term="${1:-}"
month="${2:-}"

if [ -z "$term" ]; then
  echo "usage: $0 <term> [YYYY-MM]" >&2
  exit 2
fi

if [ -n "$month" ]; then
  files=("$DIR/$month.md")
else
  files=("$DIR"/[0-9]*.md)
fi

if [ ! -e "${files[0]}" ]; then
  echo "no devlog month files found under $DIR" >&2
  exit 1
fi

# -n line numbers, -i case-insensitive. grep exits 1 on no match — report it.
if ! grep -n -i --color=never -- "$term" "${files[@]}"; then
  echo "(no matches for '$term')" >&2
  exit 1
fi
