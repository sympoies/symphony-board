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

cat >"$WORKDIR/config-control.override.yaml" <<'YAML'
services:
  board:
    environment:
      CONFIG_CONTROL_ENABLED: "1"
      SYMPHONY_SECRETS_FILE: config/secrets.env
    volumes:
      - ${SYMPHONY_CONFIG_DIR:-../config}:/app/config
YAML

PROJECT="${PG_COMPOSE_SMOKE_PROJECT:-symphony-board-pg-smoke-$(date +%s)-$$}"
WEB_PORT="${SYMPHONY_PG_WEB_PORT:-18081}"
PG_PORT="${SYMPHONY_PG_PORT:-15433}"
COMPOSE=(
  docker compose
  -p "$PROJECT"
  -f docker/compose.pg.yaml
  -f "$WORKDIR/config-control.override.yaml"
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
contract_gzip="$WORKDIR/contract.json.gz"
contract_gzip_headers="$WORKDIR/contract.gzip.headers"
stats="$WORKDIR/stats.json"
config_probe="$WORKDIR/config-probe.json"
config_next="$WORKDIR/config-next.json"
secrets_probe="$WORKDIR/secrets-probe.json"

curl -fsS "$base/contract.json" >"$contract"
node --disable-warning=ExperimentalWarning src/cli/validate-contract.ts --in "$contract"

curl -fsS -H "Accept-Encoding: gzip" -D "$contract_gzip_headers" "$base/contract.json" >"$contract_gzip"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const zlib = require("zlib");
const headers = fs.readFileSync(process.argv[1], "utf8").toLowerCase();
const encoded = fs.readFileSync(process.argv[2]);
const decoded = zlib.gunzipSync(encoded);
const plain = fs.readFileSync(process.argv[3]);
if (!headers.includes("content-encoding: gzip")) {
  console.error("expected gzip-encoded contract response");
  process.exit(1);
}
const contentLength = headers.match(/content-length:\s*(\d+)/);
if (!contentLength) {
  console.error("expected gzip contract response to include content-length");
  process.exit(1);
}
if (Number(contentLength[1]) !== encoded.length) {
  console.error(`expected gzip content-length ${encoded.length}, got ${contentLength[1]}`);
  process.exit(1);
}
if (!decoded.equals(plain)) {
  console.error("expected gzip contract body to decode to the plain contract");
  process.exit(1);
}
' "$contract_gzip_headers" "$contract_gzip" "$contract"

curl -fsS "$base/api/stats" >"$stats"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const stats = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (stats.db?.driver !== "postgres") {
  console.error(`expected stats.db.driver=postgres, got ${stats.db?.driver ?? "(missing)"}`);
  process.exit(1);
}
if (stats.db?.schema_version !== 7) {
  console.error(`expected schema_version=7, got ${stats.db?.schema_version ?? "(missing)"}`);
  process.exit(1);
}
' "$stats"

# The full-history activity_daily aggregate, served by the api sidecar from the
# contract volume (mounted read-only) and proxied by nginx. Proves the route is
# reachable end to end AND that its total reconciles with the static contract's
# activity_daily — i.e. it is the FULL history, not a windowed projection.
activity_daily="$WORKDIR/activity-daily.json"
curl -fsS "$base/api/activity-daily" >"$activity_daily"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const daily = body.activity_daily;
if (!daily || typeof daily.total !== "number" || !Array.isArray(daily.days)) {
  console.error("expected /api/activity-daily to return { activity_daily: { total, days[] } }");
  process.exit(1);
}
const contract = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = contract.activity_daily?.total;
if (daily.total !== expected) {
  console.error(`expected activity-daily total ${expected} (full contract), got ${daily.total}`);
  process.exit(1);
}
' "$activity_daily" "$contract"

curl -fsS "$base/api/sync-control" >/dev/null

curl -fsS "$base/api/config" >"$config_probe"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const probe = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (probe.enabled !== true) {
  console.error(`expected config control enabled, got ${probe.enabled}`);
  process.exit(1);
}
if (probe.config?.sources?.[0]?.source_id !== "github:github.com") {
  console.error("expected config probe to expose the throwaway GitHub source");
  process.exit(1);
}
probe.config.timezone = "Asia/Taipei";
fs.writeFileSync(process.argv[2], JSON.stringify(probe.config));
' "$config_probe" "$config_next"

curl -fsS \
  -X PUT \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Sync-Control: 1" \
  --data-binary "@$config_next" \
  "$base/api/config" >/dev/null

curl -fsS "$base/api/config" >"$config_probe"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const probe = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (probe.config?.timezone !== "Asia/Taipei") {
  console.error(`expected updated timezone, got ${probe.config?.timezone ?? "(missing)"}`);
  process.exit(1);
}
' "$config_probe"

curl -fsS "$base/api/secrets" >"$secrets_probe"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const probe = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (probe.enabled !== true || probe.writable !== true) {
  console.error(`expected writable secrets surface, got enabled=${probe.enabled} writable=${probe.writable}`);
  process.exit(1);
}
if (probe.secrets?.PG_COMPOSE_SMOKE_TOKEN !== false) {
  console.error("expected PG_COMPOSE_SMOKE_TOKEN to be listed as unset");
  process.exit(1);
}
' "$secrets_probe"

curl -fsS \
  -X PUT \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Sync-Control: 1" \
  -d '{"env":"PG_COMPOSE_SMOKE_TOKEN","value":"smoke-token"}' \
  "$base/api/secrets" >/dev/null

curl -fsS "$base/api/secrets" >"$secrets_probe"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const probe = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (probe.secrets?.PG_COMPOSE_SMOKE_TOKEN !== true) {
  console.error("expected PG_COMPOSE_SMOKE_TOKEN to be reported as set");
  process.exit(1);
}
if (JSON.stringify(probe).includes("smoke-token")) {
  console.error("secret value leaked through GET /api/secrets");
  process.exit(1);
}
' "$secrets_probe"

echo "pg compose smoke passed: $PROJECT at $base"
