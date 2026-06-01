#!/bin/sh
# Entrypoint for the symphony-board image. Two modes:
#
#   once (default) - one sync + one contract emit, then exit. CMD args pass to
#                    the sync (e.g. --dry-run, --incremental, --source <id>).
#   loop           - daemon: sync + emit every INTERVAL seconds. For an always-on
#                    box (the local Mac while it is on, or a server later):
#                    docker compose up -d  /  docker run -d --restart=unless-stopped.
#
# This is the SOLE writer by design (point 3): no external cron/trigger. A single
# writer also keeps SQLite happy (WAL + one writer; the future UI reads).
#
# Tokens come from env vars named by each source's token_env (e.g. GITHUB_TOKEN,
# GITLAB_TOKEN). The DB and config are mounted volumes (see compose.yaml). A
# GitLab source behind a VPN requires the host running this container to be on
# that VPN.
#
# Env: SYNC_MODE (once|loop), INTERVAL (seconds, default 300), SYMPHONY_CONFIG
# (default config/sources.json), CONTRACT_OUT (default data/contract.json).
set -eu

MODE="${SYNC_MODE:-once}"
INTERVAL="${INTERVAL:-300}"
CONFIG="${SYMPHONY_CONFIG:-config/sources.json}"
OUT="${CONTRACT_OUT:-data/contract.json}"
NODE="node --disable-warning=ExperimentalWarning"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

run() {
  # shellcheck disable=SC2086
  $NODE src/cli/sync.ts --config "$CONFIG" "$@"
  # shellcheck disable=SC2086
  $NODE src/cli/emit-contract.ts --config "$CONFIG" --out "$OUT"
}

case "$MODE" in
  once)
    run "$@"
    ;;
  loop)
    echo "$(ts) [loop] sync + emit every ${INTERVAL}s -> $OUT"
    while true; do
      run || echo "$(ts) [loop] iteration error; continuing"
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "$(ts) ERROR: unknown SYNC_MODE='$MODE' (use once|loop)" >&2
    exit 2
    ;;
esac
