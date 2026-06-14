#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Pick the docker compose stack from the active runtime switch
# (SYMPHONY_BOARD_ENV), resolved by the same module project-review-cleanup uses
# so deploy and review-cleanup never target different stacks. postgres -> the
# opt-in Postgres stack; sqlite or unset -> the default SQLite stack.
compose_file="$(node "$repo_root/scripts/active-compose-file.mjs")"

echo "deploy: SYMPHONY_BOARD_ENV=${SYMPHONY_BOARD_ENV:-<from .env / unset>} -> $compose_file" >&2
exec docker compose -f "$compose_file" up -d --build "$@"
