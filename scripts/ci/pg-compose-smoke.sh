#!/usr/bin/env bash
# Deployment smoke for the opt-in Postgres compose stack. Builds the backend and
# UI images, starts an isolated compose project with a throwaway config, verifies
# the app serves a valid contract, and proves /api/stats is backed by Postgres.
#
# Env:
#   PG_COMPOSE_SMOKE_KEEP_UP=1   keep the compose project running for inspection
#   PG_COMPOSE_SMOKE_PROJECT     compose project name (default unique)
#   SYMPHONY_PG_WEB_PORT         host web port (default 18081)
#   SYMPHONY_PG_PORT             host Postgres port (default 15433)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

mkdir -p out
WORKDIR="$(mktemp -d "$ROOT/out/pg-compose-smoke.XXXXXX")"
CONFIG_DIR="$WORKDIR/config"
mkdir -p "$CONFIG_DIR"
touch "$WORKDIR/empty.env"

cat >"$CONFIG_DIR/sources.pg.json" <<'JSON'
{
  "db_path": "data/smoke-unused.db",
  "db_url_env": "SYMPHONY_DB_URL",
  "timezone": "UTC",
  "sources": [
    {
      "source_id": "github:github.com",
      "kind": "github",
      "host": "github.com",
      "display_name": "GitHub",
      "token_env": "PG_COMPOSE_SMOKE_TOKEN",
      "graphql_url": "https://api.github.com/graphql",
      "rest_url": "https://api.github.com",
      "projects": ["sympoies/symphony-board"]
    }
  ]
}
JSON

PROJECT="${PG_COMPOSE_SMOKE_PROJECT:-symphony-board-pg-smoke-$(date +%s)-$$}"
WEB_PORT="${SYMPHONY_PG_WEB_PORT:-18081}"
PG_PORT="${SYMPHONY_PG_PORT:-15433}"
COMPOSE=(
  docker compose
  -p "$PROJECT"
  -f docker/compose.pg.yaml
)

cleanup() {
  if [ -z "${PG_COMPOSE_SMOKE_KEEP_UP:-}" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
  else
    echo "kept compose project $PROJECT for inspection"
    echo "web: http://127.0.0.1:$WEB_PORT"
    echo "workdir: $WORKDIR"
  fi
}
trap cleanup EXIT

export SYMPHONY_CONFIG_DIR="$CONFIG_DIR"
export SYMPHONY_CONFIG_BASENAME="sources.pg.json"
export SYMPHONY_DB_URL="postgres://symphony:symphony@postgres:5432/symphony_board"
export SYMPHONY_ENV_FILE="$WORKDIR/empty.env"
export SYMPHONY_PG_WEB_PORT="$WEB_PORT"
export SYMPHONY_PG_PORT="$PG_PORT"

"${COMPOSE[@]}" up -d --build --wait

base="http://127.0.0.1:$WEB_PORT"
contract="$WORKDIR/contract.json"
stats="$WORKDIR/stats.json"

curl -fsS "$base/contract.json" >"$contract"
node --disable-warning=ExperimentalWarning src/cli/validate-contract.ts --in "$contract"

curl -fsS "$base/api/stats" >"$stats"
# shellcheck disable=SC2016 # Node reads process.argv; shell expansion is not wanted.
node -e '
const fs = require("fs");
const stats = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (stats.db?.driver !== "postgres") {
  console.error(`expected stats.db.driver=postgres, got ${stats.db?.driver ?? "(missing)"}`);
  process.exit(1);
}
if (stats.db?.schema_version !== 3) {
  console.error(`expected schema_version=3, got ${stats.db?.schema_version ?? "(missing)"}`);
  process.exit(1);
}
' "$stats"

curl -fsS "$base/api/sync-control" >/dev/null

echo "pg compose smoke passed: $PROJECT at $base"
