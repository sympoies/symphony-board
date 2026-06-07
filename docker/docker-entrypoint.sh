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
# In `loop` mode the cadence is mostly incremental with a periodic full sweep:
# every FULL_EVERY-th iteration (and the first) runs a full sweep, the rest run
# --incremental. A full sweep is REQUIRED for disappearance handling — only a
# full + complete sweep may soft-delete unseen items/edges — so incremental
# alone would never tombstone. With the defaults (INTERVAL 300, FULL_EVERY 12)
# that is a full sweep about hourly, incremental every 5 minutes in between.
#
# Env: SYNC_MODE (once|loop), INTERVAL (seconds, default 300), FULL_EVERY (loop:
# run a full sweep every Nth iteration, default 12; 1 = always full), SYMPHONY_CONFIG
# (default config/sources.json), CONTRACT_OUT (default data/contract.json).
set -eu

MODE="${SYNC_MODE:-once}"
INTERVAL="${INTERVAL:-300}"
FULL_EVERY="${FULL_EVERY:-12}"
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
    echo "$(ts) [loop] sync + emit every ${INTERVAL}s -> $OUT (full sweep every ${FULL_EVERY} iterations)"
    i=0
    while true; do
      if [ "$((i % FULL_EVERY))" -eq 0 ]; then
        mode_arg=""        # full sweep (enables soft-delete)
        mode_label=full
      else
        mode_arg=--incremental
        mode_label=incremental
      fi
      echo "$(ts) [loop] iteration ${i} (${mode_label})"
      # shellcheck disable=SC2086
      run $mode_arg "$@" || echo "$(ts) [loop] iteration error; continuing"
      i=$((i + 1))
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "$(ts) ERROR: unknown SYNC_MODE='$MODE' (use once|loop)" >&2
    exit 2
    ;;
esac
