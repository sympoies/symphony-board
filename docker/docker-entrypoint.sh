#!/bin/sh
# Entrypoint for the symphony-board image. Three modes:
#
#   once (default) - one sync + one contract emit, then exit. CMD args pass to
#                    the sync (e.g. --dry-run, --incremental, --source <id>).
#   loop           - daemon: sync + emit on a timer AND a small writer-owned HTTP
#                    control surface for UI-triggered manual syncs. Delegated to
#                    the Node daemon (src/cli/sync-daemon.ts), which owns the
#                    cadence, a single run lock (manual + scheduled never overlap),
#                    and the control endpoints. For an always-on box (the local Mac
#                    while it is on, or a server later): docker compose up -d  /
#                    docker run -d --restart=unless-stopped.
#   api            - read-only HTTP range-query API. It never syncs or emits.
#
# This is the SOLE writer by design: no external cron/trigger. A single writer
# also keeps SQLite happy while the UI sidecar and inspection helpers read.
#
# Tokens come from env vars named by each source's token_env (e.g. GITHUB_TOKEN,
# GITLAB_TOKEN). The DB and config are mounted volumes (see compose.yaml). A
# GitLab source behind a VPN requires the host running this container to be on
# that VPN.
#
# In `loop` mode the cadence is mostly incremental with a periodic full sweep:
# every FULL_EVERY-th iteration (and the first) runs a full sweep, the rest run
# --incremental. A full sweep is REQUIRED for disappearance handling — only a
# full + complete sweep may soft-delete unseen items/edges — so incremental
# alone would never tombstone. With the defaults (INTERVAL 120, FULL_EVERY 30)
# that is a full sweep about hourly, incremental every 2 minutes in between.
#
# Env: SYNC_MODE (once|loop|api), INTERVAL (seconds, default 120), FULL_EVERY (loop:
# run a full sweep every Nth iteration, default 30; 1 = always full), SYMPHONY_CONFIG
# (default config/sources.json), CONTRACT_OUT (default data/contract.json), PORT
# (api mode, default 8081). Loop mode also reads SYNC_CONTROL_ENABLED (enable
# UI-triggered manual sync; default off), SYNC_CONTROL_PORT (default 8080), and
# SYNC_CONTROL_HOST (default 0.0.0.0).
set -eu

MODE="${SYNC_MODE:-once}"
INTERVAL="${INTERVAL:-120}"
FULL_EVERY="${FULL_EVERY:-30}"
[ "$FULL_EVERY" -ge 1 ] 2>/dev/null || FULL_EVERY=1   # guard: avoid modulo-by-zero
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
    # The Node daemon owns the cadence, the single run lock, and the control
    # surface; it reads INTERVAL / FULL_EVERY / CONTRACT_OUT / SYMPHONY_CONFIG and
    # the SYNC_CONTROL_* knobs from the environment.
    # shellcheck disable=SC2086
    exec $NODE src/cli/sync-daemon.ts
    ;;
  api)
    exec $NODE src/cli/range-api.ts --config "$CONFIG"
    ;;
  *)
    echo "$(ts) ERROR: unknown SYNC_MODE='$MODE' (use once|loop|api)" >&2
    exit 2
    ;;
esac
