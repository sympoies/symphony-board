#!/usr/bin/env bash
# Live Postgres gate: docker-compose a throwaway Postgres, run the store
# conformance suite WITH the pg driver registered plus the live e2e
# (test/e2e/pg-live.test.ts), then tear everything down (tmpfs data — nothing
# survives). This is the pg driver's test gate; `pnpm test` stays Docker-free.
#
# Usage:
#   pnpm run test:pg-e2e
#
# Env:
#   SYMPHONY_PG_TEST_URL  preset to target an existing Postgres instead of the
#                         compose one (the compose step is skipped).
#   PG_E2E_KEEP_UP=1      leave the compose Postgres running after the tests
#                         (inspect it; tear down with
#                         `docker compose -f docker/compose.pg-e2e.yaml down`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker/compose.pg-e2e.yaml)

if [ -z "${SYMPHONY_PG_TEST_URL:-}" ]; then
  export SYMPHONY_PG_TEST_URL="postgres://postgres:postgres@127.0.0.1:54329/symphony_e2e"
  if [ -z "${PG_E2E_KEEP_UP:-}" ]; then
    trap '"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true' EXIT
  fi
  "${COMPOSE[@]}" up -d --wait
fi

echo "==> store conformance (sqlite + postgres) and pg live e2e against $SYMPHONY_PG_TEST_URL" | sed 's|//[^@]*@|//***@|'
node --disable-warning=ExperimentalWarning --test \
  test/store-conformance.test.ts \
  test/e2e/pg-live.test.ts
