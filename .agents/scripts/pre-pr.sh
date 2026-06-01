#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
# NB: `exec a && b` would replace the shell with `a`, so `b` would never run.
# Run typecheck first (set -e aborts on failure), then exec the test suite.
pnpm run typecheck
exec pnpm test "$@"
