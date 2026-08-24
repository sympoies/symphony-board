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
#   PG_COMPOSE_SMOKE_SUBNET      compose network subnet (default 10.171.29.0/24)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

mkdir -p out
WORKDIR="$(mktemp -d "$ROOT/out/pg-compose-smoke.XXXXXX")"
CONFIG_DIR="$WORKDIR/config"
mkdir -p "$CONFIG_DIR"
# The board now runs as a non-root user (uid 1000). The config-control override
# below mounts this dir RW and the smoke exercises PUT /api/config (a config
# write), so the dir must be writable by that user. (The default deploy mounts
# config read-only, so this only matters when config-control is enabled.)
chmod 0777 "$CONFIG_DIR"
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

# The upstream-move step below parks a sentinel on a specific address, and
# `docker run --ip` is rejected on a network whose subnet Docker picked itself
# ("user specified IP address is supported only when connecting to networks with
# user configured subnets"). Pinning the subnet here is what makes that step
# work on any daemon rather than only where the default happened to be
# configured. Override PG_COMPOSE_SMOKE_SUBNET if this range collides.
SUBNET="${PG_COMPOSE_SMOKE_SUBNET:-10.171.29.0/24}"

cat >"$WORKDIR/config-control.override.yaml" <<YAML
services:
  board:
    environment:
      CONFIG_CONTROL_ENABLED: "1"
      SYMPHONY_SECRETS_FILE: config/secrets.env
    volumes:
      - \${SYMPHONY_CONFIG_DIR:-../config}:/app/config

networks:
  default:
    ipam:
      config:
        - subnet: $SUBNET
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

SENTINEL=""

cleanup() {
  local code=$?
  # The sentinel holds an address on the compose network; a mid-step failure
  # must not strand it, or `compose down` cannot remove the network.
  if [ -n "$SENTINEL" ]; then
    docker rm -f "$SENTINEL" >/dev/null 2>&1 || true
  fi
  # On failure, surface why before tearing the project down — without this a CI
  # failure (e.g. a non-2xx from a web route) shows only the curl exit code, not
  # the nginx/board error behind it.
  if [ "$code" -ne 0 ]; then
    echo "=== pg-compose smoke FAILED (exit $code); container state + logs ===" >&2
    "${COMPOSE[@]}" ps >&2 2>&1 || true
    "${COMPOSE[@]}" logs --tail 40 web board >&2 2>&1 || true
  fi
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
capabilities="$WORKDIR/capabilities.json"
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
if (stats.db?.schema_version !== 12) {
  console.error(`expected schema_version=12, got ${stats.db?.schema_version ?? "(missing)"}`);
  process.exit(1);
}
' "$stats"

curl -fsS "$base/api/capabilities" >"$capabilities"
# Node reads process.argv; shell expansion is not wanted in the inline JS.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const caps = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (caps.schema !== "symphony-board-capabilities/1") {
  console.error(`expected capabilities schema, got ${caps.schema ?? "(missing)"}`);
  process.exit(1);
}
if (caps.server?.mode !== "docker") {
  console.error(`expected server.mode=docker, got ${caps.server?.mode ?? "(missing)"}`);
  process.exit(1);
}
if (!["unsupported", "unreachable", "empty", "ready"].includes(caps.live?.status)) {
  console.error(`unexpected live.status ${caps.live?.status ?? "(missing)"}`);
  process.exit(1);
}
const text = JSON.stringify(caps);
if (/secret|token|private[_-]?key/i.test(text)) {
  console.error("capabilities response must not expose credential fields");
  process.exit(1);
}
' "$capabilities"

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


# --- proxied upstreams must survive an upstream IP change --------------------
# nginx resolves a literal `proxy_pass` hostname ONCE, at config load, and holds
# that address for the worker's lifetime. Docker hands a recreated service a new
# IP, so an upstream that moves without `web` also being recreated leaves every
# proxied route 502ing against a dead address — while `/` keeps serving the SPA
# from disk, so the container still reports healthy and the break is invisible
# until someone opens the board. That is how a live compose deployment of this
# stack went dark after an ordinary redeploy.
#
# Move `api` to a different address and require the proxy to follow it. The
# sentinel is what makes this deterministic: recreating `api` on its own usually
# gets the SAME address back from Docker's IPAM, which reproduces nothing. So
# park a throwaway container on the old address first, using an image the stack
# has already pulled.
api_container="$("${COMPOSE[@]}" ps -q api)"
test -n "$api_container"
ip_of() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}
old_api_ip="$(ip_of "$api_container")"
test -n "$old_api_ip"
network="$(docker inspect \
  -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$api_container")"
test -n "$network"

SENTINEL="$PROJECT-ip-sentinel"
"${COMPOSE[@]}" rm -sf api >/dev/null
if ! docker run -d --name "$SENTINEL" --network "$network" --ip "$old_api_ip" \
  --entrypoint sleep postgres:16-alpine 600 >/dev/null; then
  SENTINEL=""
  echo "could not park a sentinel on $old_api_ip in $network; without it the" >&2
  echo "upstream would likely reuse the same address and prove nothing" >&2
  exit 1
fi
"${COMPOSE[@]}" up -d --wait api >/dev/null

new_api_ip="$(ip_of "$("${COMPOSE[@]}" ps -q api)")"
docker rm -f "$SENTINEL" >/dev/null
SENTINEL=""
if [ "$new_api_ip" = "$old_api_ip" ]; then
  echo "api returned to $old_api_ip; the upstream never moved, so this proves nothing" >&2
  exit 1
fi
echo "api moved $old_api_ip -> $new_api_ip; web must re-resolve it"

# Allow for the resolver's cache TTL, then require a real recovery. Without
# per-request re-resolution this never recovers and the loop times out.
deadline=$((SECONDS + 60))
until curl -fsS --max-time 10 "$base/api/stats" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "web still cannot reach api at $new_api_ip 60s after the upstream moved:" >&2
    curl -sS -o /dev/null -w 'GET /api/stats -> %{http_code}\n' --max-time 10 "$base/api/stats" >&2 || true
    exit 1
  fi
  sleep 2
done
echo "web re-resolved api after the upstream moved"

echo "pg compose smoke passed: $PROJECT at $base"
