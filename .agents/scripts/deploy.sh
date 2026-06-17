#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Run a repo Node script. This repo standardizes on Node via fnm + .node-version
# (see DEVELOPMENT.md). Prefer a `node` already on PATH; otherwise locate `fnm`
# and run through `fnm exec`, so deploy works in non-interactive shells (agents,
# CI, cron) where fnm has not initialized PATH — without duplicating the Node
# stack-resolution logic in bash.
run_repo_node() {
  if command -v node >/dev/null 2>&1; then
    node "$@"
    return
  fi
  local fnm_bin=""
  if command -v fnm >/dev/null 2>&1; then
    fnm_bin="$(command -v fnm)"
  else
    for dir in "$HOME/.local/share/fnm" "$HOME/.fnm" "$HOME/.cargo/bin" \
               /home/linuxbrew/.linuxbrew/bin /opt/homebrew/bin /usr/local/bin; do
      if [ -x "$dir/fnm" ]; then fnm_bin="$dir/fnm"; break; fi
    done
  fi
  if [ -n "$fnm_bin" ]; then
    local node_version="default"
    [ -f "$repo_root/.node-version" ] && node_version="$(cat "$repo_root/.node-version")"
    "$fnm_bin" exec --using "$node_version" node "$@"
    return
  fi
  echo "deploy: node not found and no fnm to provide it; this repo uses Node via fnm + .node-version (see DEVELOPMENT.md)" >&2
  exit 1
}

# Pick the docker compose stack from the active runtime switch
# (SYMPHONY_BOARD_ENV), resolved by the same module project-review-cleanup uses
# so deploy and review-cleanup never target different stacks. postgres -> the
# opt-in Postgres stack; sqlite or unset -> the default SQLite stack.
compose_file="$(run_repo_node "$repo_root/scripts/active-compose-file.mjs")"

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
