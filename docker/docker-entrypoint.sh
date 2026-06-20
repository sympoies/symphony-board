#!/bin/sh
# Entrypoint for the symphony-board image. Five modes:
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
#   live           - least-privilege webhook receiver + SSE/snapshot for the
#                    Live page. Owns ONLY its own live.db; no canonical store,
#                    no provider token, no config mount. Never syncs or emits.
#   live-telegram  - read-only bridge: consumes the `live` service's SSE stream
#                    (GET /api/live) and forwards every event to Telegram. Holds
#                    no store / token / config — only LIVE_URL + TELEGRAM_* env.
#                    Never syncs or emits.
#
# This is the SOLE writer by design: no external cron/trigger. A single writer
# also preserves the writer/read-only boundary while the UI sidecar and
# inspection helpers read.
#
# Tokens come from env vars named by each source's token_env (e.g. GITHUB_TOKEN,
# GITLAB_TOKEN). Config, SQLite files, contract output, and/or Postgres
# credentials are provided by compose/env. A GitLab source behind a VPN requires
# the host running this container to be on that VPN.
#
# In `loop` mode the cadence is mostly incremental with a periodic full sweep:
# every FULL_EVERY-th iteration (and the first) runs a full sweep, the rest run
# --incremental. A full sweep is REQUIRED for disappearance handling — only a
# full + complete sweep may soft-delete unseen items/edges — so incremental
# alone would never tombstone. With the defaults (INTERVAL 120, FULL_EVERY 30)
# that is a full sweep about hourly, incremental every 2 minutes in between.
#
# Env: SYNC_MODE (once|loop|api|live|live-telegram), INTERVAL (seconds, default 120), FULL_EVERY (loop:
# run a full sweep every Nth iteration, default 30; 1 = always full), SYMPHONY_CONFIG
# (default config/sources.json), CONTRACT_OUT (default data/contract.json), PORT
# (api mode, default 8081). Loop mode also reads SYNC_CONTROL_ENABLED (enable
# UI-triggered manual sync; default off), SYNC_CONTROL_PORT (default 8080), and
# SYNC_CONTROL_HOST (default 0.0.0.0). Live mode reads LIVE_BIND_HOST (default
# 127.0.0.1), LIVE_PORT (default 8090), LIVE_DB_PATH, WEBHOOK_GITHUB_SECRET
# [_PREVIOUS], LIVE_EVENT_TTL_DAYS, LIVE_MAX_ROWS, and LIVE_PROJECT_ALLOWLIST.
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
  live)
    # Least-privilege Live receiver: verifies webhooks, owns its own live.db,
    # and serves the tailnet SSE/snapshot. No --config by design — it reads only
    # its own LIVE_* / WEBHOOK_* env and never opens the canonical store.
    # shellcheck disable=SC2086
    exec $NODE src/cli/live-receiver.ts
    ;;
  live-telegram)
    # Read-only Live -> Telegram bridge: consumes the `live` service's SSE
    # stream and forwards events to Telegram. No --config; reads only LIVE_URL /
    # TELEGRAM_* / LIVE_TELEGRAM_* env and never opens the canonical store.
    # shellcheck disable=SC2086
    exec $NODE src/cli/live-telegram-bridge.ts
    ;;
  *)
    echo "$(ts) ERROR: unknown SYNC_MODE='$MODE' (use once|loop|api|live|live-telegram)" >&2
    exit 2
    ;;
esac
