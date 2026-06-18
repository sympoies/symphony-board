#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Pick the docker compose stack from the active runtime switch
# (SYMPHONY_BOARD_ENV), resolved by the same module project-review-cleanup uses
# so deploy and review-cleanup never target different stacks. postgres -> the
# opt-in Postgres stack; sqlite or unset -> the default SQLite stack.
compose_file="$(node "$repo_root/scripts/active-compose-file.mjs")"

# Load the repo-root .env for variable interpolation. Compose anchors its
# project directory to the compose file's folder (docker/), so its automatic
# .env lookup would target docker/.env (which we do not ship) and silently drop
# operator overrides like SYMPHONY_PG_WEB_BIND -- leaving the web UI on its
# 127.0.0.1 default instead of the configured host interface. Pass the file
# explicitly so deploys honor it; skip cleanly when there is no .env.
compose_args=(-f "$compose_file")
if [ -f "$repo_root/.env" ]; then
  compose_args+=(--env-file "$repo_root/.env")
fi

echo "deploy: SYMPHONY_BOARD_ENV=${SYMPHONY_BOARD_ENV:-<from .env / unset>} -> $compose_file" >&2
exec docker compose "${compose_args[@]}" up -d --build "$@"
