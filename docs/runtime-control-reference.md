# Runtime and control API reference

For setup and operator commands, start with [Running Symphony Board](running.md).
The [design record](DESIGN.md) owns architecture decisions; the emitted work-item
contract is defined in [CONTRACT.md](CONTRACT.md). These operational APIs retain
the writer/read-only boundaries described below.

## Docker Operation

The Docker deployment keeps the same process split in both store modes:

- `board`: backend loop daemon and sole writer; also serves the writer-owned
  sync control surface (see below)
- `api`: read-only range query and operational discovery sidecar over the
  configured store
- `web`: read-only nginx sidecar serving the built UI and `/contract.json`
- `live`: least-privilege webhook receiver + tailnet SSE/snapshot for the Live
  page; owns its own `live.db`, with no canonical store / token / config (see
  [Live Event Stream](DESIGN.md#live-event-stream-realtime))

`docker/compose.yaml` is the default SQLite stack. It bind-mounts `config/` and
`data/`, so the SQLite file and emitted `data/contract.json` survive container
rebuilds and can be inspected from the host.

`docker/compose.pg.yaml` is the opt-in Postgres stack. It uses an independent
Compose project name, a `postgres:16-alpine` service with its own named data
volume, and a separate named volume for the emitted contract shared by `board`
and `web`. Its config template carries `db_url_env: "SYMPHONY_DB_URL"`; compose
sets that URL to the internal Postgres service by default. The web and Postgres
ports are loopback-only and separate from the default stack, so both deployments
can run on the same host for validation.

For Android thin-client use, keep those loopback bindings as the baseline and
publish only the web surface into the tailnet. The preferred operator shape is
Tailscale Serve on the Ubuntu host proxying compose-pg's loopback web port
(`tailscale serve --bg 18080`). If Serve is unavailable, bind only the web port
to the host's Tailscale IP with an operator-local compose override. Never expose
Postgres, provider tokens, or config files to Android.

The daemon writes `data/contract.json` inside its deployment's data volume. The
API sidecar mounts config read-only, opens the configured store read-only
(SQLite `query_only` or Postgres `default_transaction_read_only`), and serves
`GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD` plus operational read routes
such as `/api/graph-neighborhood` and `/api/actionable`. The web sidecar mounts the emitted contract
read-only, serves `/contract.json` with `Cache-Control: no-store`, proxies
read-only `/api/*` routes to the API sidecar, and proxies the sync-control
routes (`/api/sync-control`, `/api/sync-runs`) to the `board` daemon's internal
control port. `web` depends on both `board` and `api` healthchecks so it does
not serve before the first contract and read-only API are ready.

There is intentionally no external cron and no second writer **of the canonical
store**. The `live` receiver is the single writer of its own, separate `live.db`
(see [Live Event Stream](DESIGN.md#live-event-stream-realtime)); it never opens or writes the canonical store.

Default compose loop cadence:

- `docker/compose.yaml`: `INTERVAL=120`
- `docker/compose.pg.yaml`: `INTERVAL=${SYNC_INTERVAL:-300}`
- both stacks: `FULL_EVERY=30`

That gives a full sweep on the first iteration and every `FULL_EVERY`
iterations, with incremental syncs between. Scheduled starts use a fixed-rate
cadence: time spent syncing is deducted from the interval, and a run that
crosses one or more deadlines skips those missed ticks without overlapping.
With defaults, the SQLite stack runs incrementals about every 2 minutes and full
sweeps roughly hourly; the Postgres stack runs incrementals about every 5
minutes and full sweeps roughly every 2.5 hours. Set `FULL_EVERY=1` for every
iteration to be full.

The standalone app uses a more conservative local default for personal PATs:
incremental sync every 600 seconds and a requested full sweep interval of one
day (`sync.interval_seconds=600`, `sync.full_interval_seconds=86400` in its
config document). Its app server converts the requested full interval to
`full_every` loop ticks and applies config edits on the next scheduled tick.

## UI-Triggered Sync Control Plane

A browser reload of the UI only reloads the latest emitted `contract.json`; it
never asks providers for newer data. "Sync now" — a real manual provider sync +
contract emit started from the UI — is a separate capability with a deliberate
boundary, because `board` must stay the only DB writer (`api` and `web` are
read-only sidecars).

**Writer-owned control plane.** In `SYNC_MODE=loop`, `board` runs a Node daemon
(`src/cli/sync-daemon.ts`) rather than a shell `while` loop. The daemon owns the
background cadence, a single in-process run lock, in-memory run status, and a
small HTTP control surface. There is still exactly one writer process and one
sync lock, so a manual run and a scheduled run can never overlap on the
configured store.

**Shared runner.** Both the standalone `sync` CLI and the daemon go through
`src/sync-runner.ts`, which syncs selected sources sequentially and publishes
committed data after each leg. The last leg uses the final emit, retaining the
complete-run projection and totals. A failed source does not block a sibling's
emit; an all-failed run, dry-run, or refused writer lease emits nothing.
Contract 4.10.0 `sync_run` metadata distinguishes pending, complete, partial, failed,
and skipped legs from historical source health (see
[`Sync Checkpoints`](CONTRACT.md#sync-checkpoints)). Each atomic file publication
also refreshes the contract-freshness container health signal. An intermediate
emit failure is retried at the next checkpoint; a final emit failure fails the
run. `normalize` stays pure; the engine owns per-source persistence and the
runner orchestrates publication and structured per-source results for the UI.

**Run serialization.** The daemon holds one lock. A manual `POST` while a run is
active returns the active run (HTTP 409) instead of starting a second writer. A
scheduled tick that lands while a manual run is active *skips* that tick (it does
not queue) and the next interval tries again. Scheduled starts use the fixed-rate
cadence above; the first iteration and every `FULL_EVERY`-th iteration are full
sweeps, the rest incremental.

**Control API** (served by `board`, proxied by `web`, never the read-only `api`):

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/sync-control` | GET | availability probe: `{enabled, sources[], current, last, interval_seconds, full_every, full_interval_seconds}` |
| `/api/sync-runs/current` | GET | the active run status, or `null` |
| `/api/sync-runs/last` | GET | the last finished run status, or `null` |
| `/api/sync-runs` | POST | start a manual run |

The POST request body is `{mode?: "incremental"|"full", dry_run?: boolean,
source_id?: string|null}`. Defaults are incremental, write, all configured
sources. A run status carries `run_id`, `trigger` (`manual`/`scheduled`),
`mode`, `dry_run`, `source_scope`, `status` (`running`/`ok`/`partial`/`error`),
`started_at`, `finished_at`, `emitted`, per-source rows, and totals
(items/edges/activities/soft-deleted). While the run is in flight the per-source
rows fill incrementally as each source finishes and `active_source_id` names the
source currently being fetched (null once the run ends), so a polling UI can
show per-source progress instead of a static "running". `emitted` becomes true
after the first successful checkpoint even while the run remains running. The
default UI action is an incremental sync of all sources; full sweep, dry-run, and source-scoped
runs are advanced options.

**Re-entrancy.** A second manual request while a run is active is rejected with
the active run (HTTP 409); the daemon never queues unbounded runs.

**Dry-run.** `dry_run: true` exercises fetch/normalize but opens no write
transaction and emits no contract, so the UI can test provider connectivity
without mutating the store or presenting non-written state as fresh data.

**Safety model.** The mutating `POST /api/sync-runs` is enabled only when
`SYNC_CONTROL_ENABLED` is set, and it additionally requires a same-origin custom
header (`X-Symphony-Sync-Control`). A custom header cannot be set by a cross-site
simple form POST and forces a CORS preflight the daemon never answers, so a blind
cross-site POST is rejected without a shared secret. The control port
(`SYNC_CONTROL_PORT`, default 8080) is internal to the Compose network and is
never published to the host; `web` proxies the sync-control routes to it while
`/api/range` still targets the read-only `api` sidecar. Read-only status GETs and
`/healthz` are always served in loop mode; only the manual run is gated.

**UI behavior.** The UI probes `/api/sync-control` on load; when control is
unavailable or disabled it hides the affordance. While a run is active it polls
the run status fast; while idle it re-probes at a slow cadence (and on tab
focus) so daemon-scheduled background runs disable the button, are reported as
`Background sync running`, and refresh the board when they finish.

Any newly
observed finished, non-dry run that published a contract triggers exactly one
reload of `./contract.json` (and the active `/api/range` response for a custom
range) while preserving the current route, search, filters, time range, and
display preferences. This includes a failed run that published a valid
checkpoint before a sibling or final emit failed; the failure remains visible.
Running, dry-run, skipped and unpublished runs never trigger this reload.

A `409 run_active` reply to a manual start is
adopted, not surfaced as an error: the UI tracks the in-flight run it lost the
race to. Per-source progress is shown on the header source chips (behind the sync
status popover on narrow viewports), not in the
status text: while a run executes, each chip's badge overlays that run's live
state for its source — `syncing` for the in-flight source, the fresh outcome
for an already-finished one — and reverts to the contract's `last_status` when
the run ends (the reloaded contract then carries the freshness). The status
line itself stays one short line (trigger, mode, scope, elapsed).

## Writer-Owned Config Control Plane

The standalone desktop app made hand-editing `config/sources.json` and
`secrets.env` under Application Support the weakest part of the product
surface. The fix follows the sync-control precedent: one UI, one protocol,
**capability-split enablement** — a writer-owned config control plane that the
standalone sidecar enables by default and the Docker stack keeps off.

**Config API** (same shared control handler as sync control):

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/config` | GET | capability probe + the current validated config document |
| `/api/config` | PUT | replace the document (validated, atomic temp+rename write) |
| `/api/secrets` | GET | which token env names are set — booleans only, never values |
| `/api/secrets` | PUT | set/replace a token for an env name, or remove it with `value: null` |

**Standalone cadence settings.** The same config document may carry top-level
`sync.interval_seconds` and `sync.full_interval_seconds`. Settings -> Sources in
the standalone app edits those values beside source/repo/PAT settings. Docker
deployments may keep cadence in environment variables instead; when the config
omits `sync`, the daemon's environment/default cadence remains authoritative.

**Capability split.** Mutations are gated by `CONFIG_CONTROL_ENABLED` plus the
same same-origin custom header as sync control (`X-Symphony-Sync-Control`).
`app-server.ts` (standalone) defaults the flag ON — a same-user, loopback-only
deployment; `sync-daemon.ts` (Docker) defaults it OFF: a web deployment may have
many viewers with no auth layer, and config-as-file is the safest default ops
interface there. Docker web sidecars still proxy `/api/config` and
`/api/secrets` to the writer daemon so the UI can probe capability consistently.
Trusted single-user Docker deployments opt in by setting
`CONFIG_CONTROL_ENABLED=1`, mounting `config/` writable for the writer daemon,
and setting `SYMPHONY_SECRETS_FILE` to a write-only token overlay such as
`config/secrets.env`. The UI probes `GET /api/config` and renders the Settings
-> Sources editor only when the capability answers enabled; a disabled
deployment never serves its config document over HTTP. The split is
configuration, not code.

**Server-side validation is authoritative.** `PUT /api/config` runs the same
rules as `loadConfig` (`src/config.ts`), collects every problem via
`configErrors`, and returns them all in one round trip; an invalid document
never reaches disk. The UI renders the messages verbatim and re-validates
nothing. Fields the editor does not own — `identities`, `exclude_actors`,
unknown future keys — round-trip through GET -> PUT untouched.

**Secrets are write-only.** Credential values never appear in
`config/sources.json` (unchanged rule) and never cross the read surface:
`GET /api/secrets` reports set/unset booleans per env name only. Writes land in
the `SYMPHONY_SECRETS_FILE` KEY=VALUE file (created owner-only, comments
preserved). The auth resolver overlays a **fresh read of that file over
`process.env` at sync/probe time** for source-level PAT envs, GitHub App
credential envs, legacy GitHub `token_pools`, and the newer GitHub
`auth_pools`.

New GitHub config separates credential definition from routing:
`auth_pools` declares PAT pools (`kind: "pat"`) and GitHub App bot pools
(`kind: "github_app"`), while source/repo `auth_policy` selects `pat`, `bot`,
`bot_then_pat`, or repo-level `inherit`.

PAT pools keep the existing failover
semantics and are not balanced across accounts.

GitHub App bot pools may set
`strategy: "budget_aware"`; GraphQL and REST responses update each bot's
observed GitHub rate-limit budget from response headers and the GraphQL
`rateLimit` body when present, then subsequent requests prefer the available bot
with the highest remaining budget. When no budget has been observed yet, the
pool probes through the configured apps with a rotating cursor so each sync run
does not pin its first expensive pages to the same bot.

`bot_then_pat` keeps bot
budget-aware routing as the primary path and uses the PAT pool only when bot
tokens are unavailable or primary-rate-limited. Legacy `token_env`,
`github_app`, and `token_pools` remain accepted for existing deployments, and
`strategy: "round_robin"` remains accepted as a legacy alias for
`budget_aware`.

The standalone shell passes `secrets.env` as spawn env, so the
fresh overlay is what makes a credential set in-app apply without restarting the
app.

GitHub fallback PATs are used only when GitHub clearly reports primary
rate-limit exhaustion for the active token; secondary rate limits remain a
partial run/backoff condition, not a token rotation trigger.

**Credential diagnostics are metadata-only.** `GET /api/token-rate-limits`
returns one row per resolved GitHub credential with the credential env label,
auth kind (`pat` or `github_app`), PAT account login or optional bot display
name, token selection strategy, and the probed GraphQL budget (`remaining`,
`used`, `reset_at`). The token value, app private key, and app JWT never cross
the route boundary. The UI Diagnostics tab renders those metadata fields so
operators can see PAT account ownership, bot usage, and budget-aware routing
metadata without exposing secrets. Rows are ordered with GitHub App bot
credentials before PAT credentials.

**Edits apply on the next run.** Both daemons re-read config per run (the
Docker daemon was aligned to app-server's existing behavior), so a control
plane PUT — or a hand edit on the Docker host — needs no restart. The active
run keeps the config it started with; the next run picks up the new one.

**Source enablement.** A source can set `"enabled": false` to remain in
`config/sources.json` while being skipped by sync runs, including explicit
source-scoped manual runs. This is an operational pause for temporarily
unreachable providers, not a delete or purge path; omitted/`true` means enabled.
The sync-control surface still reports disabled sources with an `enabled` flag
so clients can render the state without losing the source entry.

**Removal semantics.** Removing a source or project stops syncing it but keeps
already-synced history: the disappearance rule only tombstones via a full +
complete sweep of a configured source, and an unconfigured source is never
swept. An explicit purge is deliberately out of scope.

Config is, however, the source of truth for the *projection*. The emitted
contract surfaces ONLY configured sources/repos: `buildContract` /
`buildRangeContract` are handed the configured `(source_id, project_path)` set
(via `configuredRepoRefs(cfg)`), and `mapRows` drops any source, repo, item,
edge, or activity that config no longer declares — across `sources[]`,
`repo_stats`, `repo_metrics`, `items`, `edges`, and `activities`, on every
contract surface (static contract, `/api/range`, and review-candidates
discovery). This is computed at emit time and never persisted, exactly like
colors/identities; the store rows stay untouched, so re-adding a source or
project to config makes its already-synced history reappear with no re-sync.
A disabled source (`"enabled": false`) stays declared in config, so it keeps
appearing (the operational-pause contract above) — only ABSENCE from config
hides a source/repo. Added in contract `4.2.1`.

**First-run onboarding.** A new standalone install seeds a minimal GitHub-only
config for `sympoies/symphony-board`, with `token_env: "GITHUB_TOKEN"` but no
token value. `GET /api/secrets` therefore reports the required PAT as missing,
the standalone UI locks navigation to Settings -> Sources, highlights the
missing credential, and `POST /api/secrets/validate` probes the provider API
before `PUT /api/secrets` persists the value. The lock lifts after the PAT is
validated and saved. GitLab and other sources are added manually by the user
through the same editor.

## Read-Only Diagnostics Surface

Troubleshooting a deployment used to require a terminal: `scripts/db-summary.sh`
for store state and `docker compose logs` / `logs/app-server.log` for the
daemon. The hidden Diagnostics page (`#/debug`, toggled with Cmd+/ or Ctrl+/,
deliberately absent from the nav) moves the common 90% in-app. It renders
before the contract-loading gates, so it stays reachable when the contract
fails to load — exactly when it is needed.

| Route | Method | Served by | Purpose |
| --- | --- | --- | --- |
| `/api/capabilities` | GET | read-only `api` sidecar / app server | safe server capability/status document: board read routes, Live read availability, Live snapshot status, optional non-secret webhook setup hint, and allowlist enabled/count |
| `/api/graph-neighborhood` | GET | read-only `api` sidecar / app server | bounded canonical-history relationship neighborhood for one `ref`; accepts `depth=1..5` (default 1) and `mentions=direct\|all` (default `all`; the UI requests `all`), returns deterministic nodes with hop distance and original directed edges, and reports depth/node/edge limit reasons; `scope=program` returns a tracker's program instead (children, what blocks them, what closes them) in the same shape |
| `/api/stats` | GET | read-only `api` sidecar / app server | store statistics: db + WAL file sizes, per-table row counts, live/tombstoned items and edges with kind/state/type/lifecycle breakdowns, activity bounds, recent `sync_run` history (`?runs=`, default 20) |
| `/api/review-candidates` | GET | read-only `api` sidecar / app server | review-cleanup discovery over the full canonical store; accepts `repo`, `pr`, `days`, repeated `actor`, `all_actors`, and `limit`, and returns the same candidate array as `pnpm review-candidates --json` |
| `/api/actionable` | GET | read-only `api` sidecar / app server | open-work discovery over the full canonical store; accepts `repo`, `source`, `limit`, `stale_days`, and `include_unconfigured`, and returns items grouped into actionable buckets |
| `/api/logs` | GET | writer (`board` daemon / app server) | the writer process's in-memory recent-log tail; `?after=<seq>` returns only newer entries |

**Capabilities, graph neighborhoods, stats, review candidates, and actionable
work are operational surfaces, not contract.** `/api/capabilities` describes route availability and
Live setup state, never work-item data, so it carries no `contract_version` and
needs no bump. It may probe the internal Live reads listener
(`LIVE_READ_BASE_URL`) and may echo only non-secret deployment metadata such as
`LIVE_WEBHOOK_PUBLIC_URL`, `LIVE_WEBHOOK_PROVIDER`, `LIVE_WEBHOOK_EVENTS`, and
the count of `LIVE_PROJECT_ALLOWLIST`; it must never return webhook secrets,
provider tokens, private keys, or raw auth headers.

`/api/stats` describes the
store (sizes, row counts, run history), never the work-item data model, so it
carries no `contract_version` and needs no bump.

`/api/graph-neighborhood` reads current live canonical items and edges from
configured repos rather than the range-windowed contract. It is deliberately
bounded (five hops, 200 nodes, 500 edges), returns `404` for an unknown focus,
and carries its own `symphony-board-graph-neighborhood/1` operational schema;
changing it does not bump `contract_version`. Its program scope reads through
the same two bounded store methods as the neighborhood walk — the tracker's
edges, then its children's — so it adds no query, driver, or schema surface.

`/api/review-candidates` is an agent/workflow surface for review-thread cleanup:
it computes from the full canonical store, not the windowed UI contract, so an
old merged PR with a lingering unresolved thread still appears. `/api/actionable`
does the same for currently open work items: it defaults to the active source
config so historical rows from removed repos do not pollute the queue, while
`include_unconfigured=1` keeps them available for diagnostics. These
store-backed routes follow the `/api/range` access discipline — every request
opens the configured store read-only and closes it — and live on the read-only
`api` sidecar in the Docker stack (the generic `/api/` proxy covers them).
Capabilities needs no canonical store handle.

**Logs are a per-process ring buffer.** `src/log.ts` tees every line into a
1000-entry in-memory buffer with a monotonic `seq`; `GET /api/logs` is gated by
`LOG_CONTROL_ENABLED` (default ON for the standalone app server, OFF for the
Docker daemon — Compose opts in) and must be served by the **writer**, so nginx
adds one exact-match proxy for it. The buffer is lost on restart by design: it
answers "what is the daemon doing / failing on right now", not forensics —
container logs and `logs/app-server.log` remain the durable record. A poller
detects a daemon restart when `latest_seq` drops below its last-seen `seq` and
re-reads from the top. The `sync_run` table (surfaced by `/api/stats`) already
carries per-run `status` / `error`, which covers most "why did sync fail"
questions without log access.

