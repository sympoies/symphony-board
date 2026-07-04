# Running Symphony Board

This runbook owns operational setup and local run paths. The root
[README.md](../README.md) stays focused on what the project is and the shortest
useful way to try it; [DEVELOPMENT.md](../DEVELOPMENT.md) owns contributor
validation.

## Configure Sources

```sh
cp config/sources.example.json config/sources.json
$EDITOR config/sources.json

export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_TOKEN_BACKUP="ghp_xxx"  # optional: use a different GitHub account
export GITHUB_TOKEN_EXAMPLE_PUBLIC="ghp_xxx"  # optional: named repo token pool
export GITHUB_TOKEN_EXAMPLE_PUBLIC_BACKUP="ghp_xxx"
export EXAMPLE_BOT_A_APP_ID="12345"  # optional: GitHub App bot auth pool
export EXAMPLE_BOT_A_INSTALLATION_ID="67890"
export EXAMPLE_BOT_A_PRIVATE_KEY_PATH="/run/secrets/example-bot-a.pem"
export EXAMPLE_BOT_B_APP_ID="12346"
export EXAMPLE_BOT_B_INSTALLATION_ID="67891"
export EXAMPLE_BOT_B_PRIVATE_KEY_PATH="/run/secrets/example-bot-b.pem"
export GITLAB_TOKEN="glpat_xxx"   # only when a GitLab source is configured
```

Credentials are referenced by env-var name in config and read from the
environment. Do not inline tokens or private keys in `config/sources.json`.
GitHub sources support PAT auth, GitHub App bot auth, and explicit source/repo
selection through `auth_pools` plus `auth_policy`:

- PAT auth uses `token_env` plus optional `fallback_token_envs`. Fallback PATs
  are tried only when GitHub clearly reports primary rate-limit exhaustion for
  the active token. Use a PAT from a different GitHub account; multiple PATs
  from the same account share the same user quota. PAT pools are failover-only.
- GitHub App bot pools use `kind: "github_app"` with one `apps[]` entry per bot.
  Each entry has `app_id_env`, `installation_id_env`, and exactly one of
  `private_key_env`, `private_key_base64_env`, or `private_key_path_env`. A bot
  pool with `strategy: "budget_aware"` uses observed GitHub GraphQL/REST
  rate-limit budgets to pick the app with the highest remaining quota for the
  next request. When no budget has been observed yet, the pool probes through
  the configured apps with a rotating cursor so the first expensive pages are
  not pinned to the same bot.
- `auth_policy.mode` chooses the pool at source or repo scope: `pat` uses one
  PAT pool, `bot` uses one bot pool, `bot_then_pat` uses bot budget-aware
  routing first and PAT failover only when the bot tokens are
  unavailable/rate-limited, and
  repo-level `inherit` keeps the source policy.
- Legacy `token_env`, `github_app`, and `token_pools` configs are still
  supported. `strategy: "round_robin"` is accepted as a legacy alias for
  `budget_aware`, but new config should prefer `auth_pools` / `auth_policy`
  because it separates credential definitions from the routing strategy.

The Diagnostics `Rate limit` tab probes one lightweight GraphQL request per
configured GitHub credential and shows PAT vs bot, PAT account login or bot
name, strategy, remaining budget, and used budget. Token values and private-key
values never appear in the response or UI.

Set `SYNC_AUTH_TRACE=1` temporarily to log each provider request's selected
credential label, auth kind, strategy, API kind, operation, and repo when it can
be inferred. The trace never logs token values or private keys; leave it off in
normal operation because it is intentionally verbose.

A source may also set `"enabled": false` to stay in the config while being
skipped by every sync run. Use this for temporarily unreachable providers, such
as a self-hosted GitLab that needs VPN on one host, instead of removing and
later reconstructing the source.

## One-Shot Sync

```sh
pnpm run init-db
node src/cli/sync.ts --dry-run
pnpm run sync
pnpm run emit --out data/contract.json
pnpm run validate --in data/contract.json
```

A source is skipped with a warning when it has `"enabled": false` or when none
of its configured credential env vars resolves. `--dry-run` fetches and
normalizes but writes nothing.

Useful sync flags:

```sh
node src/cli/sync.ts --incremental
node src/cli/sync.ts --source github:github.com
node src/cli/sync.ts --config path/to/sources.json --dry-run
```

## Run The UI Locally

The UI fetches `./contract.json` relative to the app. The tracked
`packages/ui/public/contract.json` is a small sample contract for development
and smoke tests; do not leave live provider data staged there.

To inspect the bundled sample:

```sh
pnpm --filter @symphony-board/ui dev
```

To inspect a real sync through Vite, emit the runtime contract under gitignored
`data/`, copy it over the sample only for the local session, and restore the
tracked sample before committing:

```sh
pnpm run emit --out data/contract.json
pnpm run validate --in data/contract.json
cp data/contract.json packages/ui/public/contract.json
pnpm --filter @symphony-board/ui dev
git restore packages/ui/public/contract.json
```

For a production-style local check against the current UI public contract:

```sh
pnpm --filter @symphony-board/ui run build
pnpm --filter @symphony-board/ui run preview
```

UI-only dev serves a static contract file; use the Docker stack when testing the
default `this week` range or other custom date ranges through `/api/range`.
Runtime output under `data/` remains gitignored.

## Docker Continuous Runs

Docker Compose runs these services in the default SQLite stack:

- `board`: the sole writer. A Node daemon loops `sync` + `emit` on a timer and
  also serves a writer-owned control surface for UI-triggered manual syncs plus
  its recent-log tail on `GET /api/logs` for the hidden Diagnostics page
  (`#/debug`, toggled with Cmd+/ or Ctrl+/).
- `api`: a read-only Node sidecar. It opens the configured store read-only and
  serves `GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD`, review cleanup
  discovery on `GET /api/review-candidates`, actionable open-work discovery on
  `GET /api/actionable`, plus store statistics on `GET /api/stats`, and safe
  server/Live metadata on `GET /api/capabilities`.
- `live`: a least-privilege webhook receiver. It owns its own append-only
  `live.db`; it does not mount provider config, provider tokens, or the
  canonical store.
- `web`: a read-only nginx sidecar that serves the built UI and the daemon's
  latest `data/contract.json` as `/contract.json`, proxies `/api/range`,
  `/api/stats`, `/api/review-candidates`, `/api/actionable`,
  `/api/capabilities`, and `/api/live*` to read-only services, and proxies
  sync-control and log-tail routes to `board`.

```sh
cat > .env <<'EOF'
GITHUB_TOKEN=ghp_xxx
GITHUB_TOKEN_BACKUP=ghp_xxx_from_a_different_account
EOF
# add GITLAB_TOKEN=... if configured
cp config/sources.example.json config/sources.json
$EDITOR config/sources.json

docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml ps
open http://localhost:8080
```

The default stack uses SQLite at `db_path`. To validate or run the independent
Postgres stack, copy the pg config template and use the pg compose file:

```sh
cp config/sources.pg.example.json config/sources.pg.json
$EDITOR config/sources.pg.json

docker compose -f docker/compose.pg.yaml up -d --build
docker compose -f docker/compose.pg.yaml ps
open http://localhost:18080
curl -fsS http://localhost:18080/api/stats
```

`docker/compose.pg.yaml` uses a separate Compose project name
(`symphony-board-pg`), loopback ports (`18080` for web, `15432` for Postgres),
a stack-private Postgres data volume, and a stack-private contract volume. The
config carries `"db_url_env": "SYMPHONY_DB_URL"`; compose supplies
`SYMPHONY_DB_URL` for its internal `postgres` service by default. If you
override `SYMPHONY_PG_USER`, `SYMPHONY_PG_PASSWORD`, or `SYMPHONY_PG_DATABASE`,
set `SYMPHONY_DB_URL` to the matching URL as well. Use `docker compose -f
docker/compose.pg.yaml down -v` to delete the independent pg database and
generated contract volume.

Use `GET /api/actionable` when a tool needs the full open-work candidate queue.
It reads the canonical store directly and filters to the active source config by
default; the contract's `items[]` payload remains windowed and should not be
used as a full queue inventory.

The agent deploy entrypoint (`.agents/scripts/deploy.sh`, used by the `deploy`
skill) builds and starts whichever stack the `SYMPHONY_BOARD_ENV` switch in
`.env` selects: `postgres` selects `docker/compose.pg.yaml`; `sqlite` or unset
selects `docker/compose.yaml`. The same switch is read by
`project-review-cleanup`, so the two never target different stacks. The explicit
`docker compose -f ...` commands above stay valid for ad-hoc use.

The deployment smoke gate for this path is:

```sh
pnpm run test:pg-compose
```

The default SQLite stack runs with `INTERVAL=120` seconds and `FULL_EVERY=30`.
The Postgres stack runs with `INTERVAL=${SYNC_INTERVAL:-300}` and
`FULL_EVERY=30`. That gives a full sweep on the first loop and then every
`FULL_EVERY` iterations, with incremental runs in between. Set `FULL_EVERY=1`
to always full-sweep. See [DESIGN.md](DESIGN.md) for the stack cadence summary.

The standalone macOS app intentionally uses a slower personal-token cadence:
incremental sync every 600 seconds and a full sweep about once per day. Adjust
those under Settings -> Sources; the values are saved as top-level
`sync.interval_seconds` and `sync.full_interval_seconds` in the standalone
`sources.json`.

Within a single source's sweep, the per-item resolve pass runs at a bounded
concurrency of `SYNC_RESOLVE_CONCURRENCY` (default 4; a value below 1 or
non-integer falls back to the default, read fresh each run). Raising it shortens
that pass on large repos but risks a provider's secondary / abuse rate limit.
Page fetches stay sequential regardless, and `SYNC_RESOLVE_CONCURRENCY=1`
restores the fully sequential behavior.

Only full, complete sweeps can tombstone disappeared items and intra-source
edges. Partial, failed, and incremental runs never delete.

## Manual Sync From The UI

Browser reload only reloads the latest emitted `contract.json`; it does not ask
providers for new data. The UI's **Sync** action triggers a real provider sync +
contract emit through the `board` daemon, then reloads the contract in place
while keeping your route, search, filters, and time range. Use it for an
immediate update or a provider-connectivity check between scheduled loops. Rely
on the background loop for hands-off freshness, and a browser reload only to
re-read the last emit.

The control plane keeps `board` the only writer: manual and scheduled syncs
share one lock and never overlap, and the read-only `api` sidecar is untouched.
The Compose stack enables it via `SYNC_CONTROL_ENABLED=1` on `board`; the
control port (`SYNC_CONTROL_PORT`, default 8080) stays internal to the Compose
network and is never published to the host. Mutating requests require a
same-origin `X-Symphony-Sync-Control` header, so a blind cross-site POST is
rejected. Remove `SYNC_CONTROL_ENABLED` to keep the daemon timer-only and refuse
manual runs; the UI then hides the Sync action. The Header action runs an
incremental sync of all sources; Settings exposes full sweep, dry-run, and
source-scoped runs.

## Editing Sources From The UI

A second writer-owned capability lets Settings -> Sources edit the producer
config itself: add/remove sources and repos, edit display names, and set
provider tokens through a write-only secrets surface. Values are never read
back. The daemon validates with the same rules as `loadConfig` and writes
atomically; edits apply on the next sync run without a restart. Removing a
source or repo stops syncing it but keeps already-synced history.

It is gated by `CONFIG_CONTROL_ENABLED` plus the same same-origin header as
sync control, and it is off by default in the Docker stack. Trusted single-user
deployments can opt in with a compose override that makes `config/` writable for
the writer daemon and provides a write-only token file:

```yaml
services:
  board:
    environment:
      CONFIG_CONTROL_ENABLED: "1"
      SYMPHONY_SECRETS_FILE: config/secrets.env
    volumes:
      - ${SYMPHONY_CONFIG_DIR:-../config}:/app/config
```

Keep this behind a private network such as Tailscale; there is no user auth
layer on the config writer. The standalone desktop app enables the same control
plane by default and onboards new installs entirely in-app. See
[DESIGN.md](DESIGN.md) for the full decision record, including why the
config file stays JSON.

## Live Event Stream

Alongside the periodic-sync pipeline, an independent realtime "Live" mechanism
streams provider webhook activity to the **Live** UI tab:

```text
GitHub org webhook --HMAC verify--> [live receiver] --append--> live.db
   (SQLite, append-only, TTL-pruned) --SSE / snapshot--> Live page
```

It is fully separate from the contract pipeline (its own store and its own
`live-event/1` schema) and is a best-effort freshness feed. The board's periodic
sync remains the source of truth. The `live` Docker service is least-privilege:
it holds only its own `live.db` and the webhook HMAC secret by env-var name,
with no canonical store, provider token, or config mount. GitHub actor avatars
are cached as profile URLs only; the receiver does not store avatar image bytes.
See [DESIGN.md](DESIGN.md) for the full design and trust-boundary notes.

Hosted deployments should expose only the webhook listener (`/webhooks/*`)
publicly and keep the SSE/snapshot reads (`/api/live*`) behind a private network
or authenticated UI edge. The app repo owns the listener split; host-specific
ingress wiring belongs in the deployment repo or operator runbook.

Thin clients use the single Settings -> Server URL for `/contract.json`,
`/api/range`, `/api/capabilities`, and `/api/live*` reads. Do not add a separate
Live URL for the browser. `GET /api/capabilities` is safe to expose on the same
read side because it returns only route booleans, Live read status, optional
webhook setup hints, and allowlist enabled/count; it never returns the webhook
secret, provider tokens, private keys, or raw credential material.

Set `WEBHOOK_GITHUB_SECRET` and, during a rotation window,
`WEBHOOK_GITHUB_SECRET_PREVIOUS`, to match the GitHub org webhook secret. The
`live` service reads it by `environment:` interpolation, which resolves the
`.env` in the compose project directory (`docker/.env` for
`docker compose -f docker/compose.yaml`), not the repo-root `.env` that
`board`/`api` load. For a direct run, set it in `docker/.env` or the shell env:

```sh
WEBHOOK_GITHUB_SECRET=... docker compose -f docker/compose.yaml up -d live
```

See [`.env.example`](../.env.example) for bind ports, retention settings, and
allowlist variables. Deployments may also set `LIVE_WEBHOOK_PUBLIC_URL`,
`LIVE_WEBHOOK_PROVIDER`, and `LIVE_WEBHOOK_EVENTS` to show a non-secret webhook
setup hint in Settings; leave them unset for local/static deployments.

## Optional Release Dispatch

Stable GitHub Releases can notify an external deployment repository after the
public GHCR manifests are pushed and verified. Set the repository Actions
variable `DEPLOY_DISPATCH_REPOSITORY=owner/repo` and the secret
`DEPLOY_DISPATCH_TOKEN` with permission to call `repository_dispatch` on that
repository. `DEPLOY_DISPATCH_EVENT_TYPE` is optional and defaults to
`symphony-board-release`. Prereleases do not dispatch.

Stable releases can also notify a Homebrew tap after both GHCR publishing and
desktop asset upload complete. Set `HOMEBREW_TAP_DISPATCH_REPOSITORY=owner/repo`
and the secret `HOMEBREW_TAP_DISPATCH_TOKEN` with permission to call
`repository_dispatch` on that tap. `HOMEBREW_TAP_DISPATCH_EVENT_TYPE` is
optional and defaults to `symphony-board-release`.

## macOS Apps

Two desktop options share the same UI.

**Thin client** (`packages/desktop`) bundles the React UI and connects to a
running `symphony-board` server. It does not contain SQLite, provider tokens, or
the sync daemon.

```sh
fnm use
pnpm install
pnpm desktop:build
open "packages/desktop/src-tauri/target/release/bundle/macos/Symphony Board.app"
```

In Tauri, the default server URL is `http://localhost:8080/`, matching the
Docker stack. Change it from Settings -> Server for an always-on hosted server.

**Standalone** (`packages/desktop-standalone`) is the fully self-contained app:
UI plus the bundled Node runtime, sync daemon, SQLite store, and contract server
in one `.app`, no Docker or server required. First run seeds one GitHub source
for `sympoies/symphony-board`; until the PAT is set, the UI stays locked on
Settings -> Sources. Paste the highlighted GitHub PAT, let the app validate it,
then run the first sync. GitLab or other sources are added later in Settings ->
Sources. Config, tokens, and data live under:

```text
~/Library/Application Support/com.sympoies.symphony-board.standalone/
```

See [packages/desktop-standalone/README.md](../packages/desktop-standalone/README.md)
for setup.

```sh
fnm use
pnpm install
pnpm desktop-standalone:build
open "packages/desktop-standalone/src-tauri/target/release/bundle/macos/Symphony Board Standalone.app"
```

For self-use on the same Mac, no paid Apple Developer Program membership is
required. Local builds are not notarized; they usually open directly, but if
macOS blocks a launch, unblock the bundle with `scripts/install-release-app.sh`.

GitHub Releases include unsigned CI-built desktop zips for Apple Silicon Macs:

- `Symphony-Board-vX.Y.Z-macos-arm64-unsigned.zip`
- `Symphony-Board-Standalone-vX.Y.Z-macos-arm64-unsigned.zip`

These release builds are unsigned and not notarized, so macOS quarantines the
download and Gatekeeper blocks the first launch. Install with the helper; it
extracts a `.zip`, strips the quarantine flag, copies the bundle into
`/Applications`, and opens it:

```sh
scripts/install-release-app.sh ~/Downloads/Symphony-Board-vX.Y.Z-macos-arm64-unsigned.zip
# or, with no argument, pick the newest Symphony-Board-*.zip in ~/Downloads:
scripts/install-release-app.sh
```

To do it by hand instead: clear the flag with
`xattr -dr com.apple.quarantine "<app>"`, or, on macOS Sequoia and later, use
System Settings -> Privacy & Security -> Open Anyway after the first blocked
launch.

## Android App

`packages/android` is a thin-client shell for phones and tablets. It contains no
SQLite/Postgres store, provider tokens, sync daemon, or backend sidecar; it
loads the same shared UI build as the web and macOS thin client.

Install Android Studio, Android SDK Platform Tools, Build Tools, Command-line
Tools, NDK, a JDK (`JAVA_HOME`), `ANDROID_HOME`, `NDK_HOME`, and Rust Android
targets, then run:

```sh
fnm use
pnpm install
pnpm android:info
pnpm android:init
pnpm android:build:apk
```

Run `pnpm android:init` once after the Android SDK and NDK are installed; Tauri
creates the native Android project under `packages/android/src-tauri/gen/android`.
Set `VITE_SYMPHONY_BOARD_SERVER_URL` during build to preconfigure a server URL,
or enter it later in Settings -> Server. Android deliberately does not inherit
the macOS thin-client `http://localhost:8080/` default.

The preferred self-hosted path is the Ubuntu `docker/compose.pg.yaml` stack with
its web and Postgres ports still loopback-only, then Tailscale Serve exposing
only the web surface to the tailnet:

```sh
docker compose -f docker/compose.pg.yaml up -d --build
tailscale serve --bg 18080
```

Use the resulting tailnet URL in Settings -> Server. Validate from a tailnet
device with `/contract.json`, `/api/range?...`, `/api/capabilities`, and
`/api/stats`. Do not expose Postgres or provider config/token files to Android.

## Inspection Helpers

Read-only inspection helpers:

```sh
scripts/db-summary.sh
scripts/contract-summary.sh
scripts/devlog-search.sh graph
```

The helper catalog lives in [scripts/README.md](../scripts/README.md).
