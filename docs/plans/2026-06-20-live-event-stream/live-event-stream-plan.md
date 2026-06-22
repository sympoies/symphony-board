# Plan: Realtime Live Event Stream

## Overview

Build a new, **independent** realtime "Live" activity mechanism for
symphony-board:

> GitHub webhook → signature-verified delivery → **dedicated append-only
> live-event store** → provider-neutral live-event record → snapshot HTTP +
> SSE stream → new **Live** UI page.

It is fully separate from the `raw → canonical → contract` pipeline,
`contract.json`, the contract schema, and the Activity tab. The existing
periodic sync stays the canonical reconciliation/backstop; the live feed is
freshness, not the state of record. GitHub lands first; the GitLab adapter is
designed as an interface only. Public ingress is a dedicated public HTTPS route
to the webhook route on its own port; SSE/snapshot stay tailnet-only.

All settled decisions, the live-event schema, the API shape, verified
provider/SSE/public ingress facts, and the security model live in the source document —
read it first.

## Read First

- Primary source: `docs/plans/2026-06-20-live-event-stream/live-event-stream-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none
- Also read: `docs/DESIGN.md` (three layers, sole-writer lease, control-plane
  pattern, Docker topology, UI pages); `AGENTS.md` (layer purity, identity,
  disappearance rule, secret handling, sole-writer-per-store);
  `src/cli/sync-daemon.ts`, `src/cli/app-server.ts`, `src/server/http.ts` (HTTP
  composition, `handleControlRequest`, `readBody`, `sendJsonMaybeGzip`);
  `docker/ui-nginx.conf`, `docker/compose.yaml`, `docker/docker-entrypoint.sh`
  (service split, proxy routing, `SYNC_MODE` dispatch);
  `packages/ui/src/{App.tsx,nav.ts,runtime.ts,contract.ts}`,
  `components/ActivityPage.tsx`, `useSync.ts`, `useDebug.ts` (page/route/hook
  patterns; the `debug` contract-independent-page precedent).

## Scope

- In scope: a dedicated live-event SQLite store (separate from the canonical
  `Store`), append-only, deduped, TTL/row-cap pruned, with a backlog read for
  replay; a provider-neutral `live-event/1` record; a pure GitHub
  `WebhookProvider` adapter + raw-body HMAC-SHA256 verifier; a `live` receiver
  service (public `POST /webhooks/github`, tailnet `GET /api/live` SSE +
  `GET /api/live-snapshot` + `/healthz`); a new contract-independent Live UI
  page (web/standalone same-origin; thin-client polling fallback); the Docker
  `live` service + nginx `/api/live*` + `.env.example`; private deployment host ingress wiring
  (documented); a GitLab adapter interface stub; the `docs/DESIGN.md`
  trust-boundary promotion.
- Out of scope: any change to `contract.json`, the contract schema,
  `docs/CONTRACT.md`, the canonical store, the sync engine, or the Activity tab
  as a settled change; provider write-back; GitLab receiver implementation
  (interface only); a Live receiver on the standalone macOS app (no public
  ingress); per-client authz / per-source visibility filtering on the stream
  (v1 relies on the tailnet boundary); WebSocket / bidirectional messaging.

## Assumptions

1. The v1 live store is a dedicated SQLite DB regardless of the canonical store
   driver (Decision 3); it is NOT added to the canonical `Store` interface or
   the `store-conformance` suite, so the Postgres gates do not apply to it.
2. The GitHub source is configured as an organization webhook with a single
   shared HMAC secret referenced by env-var name (Decision 5).
3. Public ingress is a dedicated public HTTPS route scoped to `/webhooks`
   (Decision 4); any required public-ingress enablement is handled by a
   deployment admin before deploy.
4. The standalone macOS app has no public ingress, so the Live receiver is
   absent/disabled there (Decision 9); the page is hidden when the live
   capability is unavailable.
5. The Live page renders before `App.tsx`'s contract-loading gates (the `debug`
   early-return precedent), so it works without `contract.json`.

---

## Sprint 1: Live-event store + neutral schema (foundation, no public surface)

**Goal**: a dedicated append-only store and the provider-neutral record exist and
are tested in isolation, before any network surface is added.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`.
- Verify: events append idempotently by `(source_id, event_id)`; `seq` is
  monotonic and NUL-free; a backlog read returns only events after a given `seq`;
  prune drops rows past the TTL / row cap.

### Task 1.1: Dedicated live-event store

- **Location**:
  - `src/live/store.ts`
  - `src/live/schema.sql`
- **Description**: create a `LiveStore` opening a dedicated SQLite file
  (`LIVE_DB_PATH`); it is self-contained and never imports the canonical `Store`.
  Table `live_event(seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id, event_id,
  provider, received_at, occurred_at, event_type, action, category, actor_json,
  target_json, title, body, url, provider_details_json, raw_json, created_at)`
  with a UNIQUE index on `(source_id, event_id)`. Methods: `append(event)`
  (insert-or-ignore; returns assigned or existing `seq`), `since(seq, limit)`
  (replay backlog), `recent(limit)` (snapshot, newest-first), `maxSeq()`,
  `prune(ttlDays, maxRows)`. WAL mode so a reader can tail while the single
  writer appends.
- **Dependencies**:
  - none
- **Complexity**: 5
- **Acceptance criteria**:
  - A duplicate `(source_id, event_id)` append is a no-op and returns the
    original `seq` (idempotent).
  - `seq` is strictly monotonic; ids exposed as SSE `id:` are NUL-free.
  - `since(seq, limit)` returns only rows after `seq`, in order.
  - The store opens its own SQLite file and never imports the canonical `Store`,
    a provider token, or `config`.
- **Validation**:
  - `pnpm run typecheck && pnpm test` (new `test/live-store.test.ts`, modeled on
    the `upsertActivity` idempotency/ordering cases in `store-conformance`).

### Task 1.2: Provider-neutral live-event record + `live-event/1` schema

- **Location**:
  - `src/live/types.ts`
- **Description**: define the `LiveEvent` shape exactly as in the source-doc
  schema (seq, event_id, source_id, provider, received_at, occurred_at,
  event_type, action, category, actor, target, title, body, url, review_state,
  delivery, provider_details, raw) plus a small self-contained validator for the
  `"schema": "live-event/1"` tag. Honor the 64-bit-safe provider-number rule and
  the NUL-byte guard.
- **Dependencies**:
  - none
- **Complexity**: 3
- **Acceptance criteria**:
  - The type/schema is self-contained — no import from `packages/contract` and no
    reference to `contract_version`.
  - A record round-trips through the `LiveStore` json columns without loss.
- **Validation**:
  - `pnpm run typecheck && pnpm test`; extend `test/no-nul-bytes.test.ts` coverage
    to the live-event id path.

### Task 1.3: TTL / row-cap prune

- **Location**:
  - `src/live/store.ts`
  - `src/live/prune.ts`
- **Description**: `prune(ttlDays = LIVE_EVENT_TTL_DAYS default 30, maxRows =
  LIVE_MAX_ROWS)` deletes rows older than the TTL and trims to the row cap
  (oldest first); a timer in the receiver runs it on an interval. Pruning past
  the retained window also bounds the SSE replay backlog.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 2
- **Acceptance criteria**:
  - Rows older than the TTL and rows beyond the cap are removed; newer rows and
    the max `seq` are preserved.
  - Replay (`since`) never returns a pruned row.
- **Validation**:
  - `pnpm run typecheck && pnpm test`.

---

## Sprint 2: GitHub adapter + signature verification (pure)

**Goal**: verified-only ingestion and provider-neutral adaptation exist as pure,
replayable functions — no network, no IO — before they are wired to a server.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`.
- Verify: a tampered body, wrong secret, missing/legacy-SHA1 signature each
  reject; a valid delivery verifies and adapts to the right `LiveEvent`(s);
  unknown actions are ignored gracefully; `ping` is recognized as control.

### Task 2.1: Raw-body reader + HMAC verifier

- **Location**:
  - `src/live/http-body.ts`
  - `src/live/verify.ts`
- **Description**: `readBodyBytes(req, maxBytes)` reads the request body as a
  Buffer (never a string) with a tight size cap and read timeout — a Buffer
  variant of `sync-daemon.ts`'s string `readBody`. `verifyGithubSignature(rawBody,
  header, secret)` computes the `sha256=` HMAC-SHA256 hex over the raw bytes and
  compares with `crypto.timingSafeEqual` on equal-length buffers (length-check
  first). No parse-first, no permissive fallback; support dual-secret (current +
  previous) for rotation. Reject on missing/malformed/length-mismatch/
  digest-mismatch.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - A one-byte payload mutation flips the verdict to reject.
  - Wrong secret, missing header, and a legacy `X-Hub-Signature` (SHA-1) all
    reject; only `X-Hub-Signature-256` is accepted.
  - A non-UTF-8 byte in the payload does not break verification (raw bytes used).
  - Dual-secret: a delivery signed with the previous secret still verifies during
    the rotation window.
- **Validation**:
  - `pnpm run typecheck && pnpm test` (new `test/live-verify.test.ts`, pure unit
    tests like `test/rest.test.ts`).

### Task 2.2: `WebhookProvider` interface + GitHub adapter

- **Location**:
  - `src/live/provider.ts`
  - `src/live/github.ts`
- **Description**: implement the interface from the source doc. `deliveryId` reads
  `X-GitHub-Delivery`; `isControlEvent` recognizes `ping`; `toLiveEvents` maps
  `(X-GitHub-Event, action)` to neutral `category`/`LiveEvent` for `issues`,
  `issue_comment` (disambiguate PR vs issue via `issue.pull_request`),
  `pull_request` (merge = `closed` + `merged:true`), `pull_request_review`
  (verdict from `review.state`), `pull_request_review_comment`,
  `pull_request_review_thread` (resolved/unresolved). Unknown events/actions
  yield an empty list (ignore gracefully). Pure: no IO. Scrub known
  secret-bearing fields (installation/app tokens, signatures) from `raw` before
  returning.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 6
- **Acceptance criteria**:
  - Each supported `(event, action)` produces the expected neutral record;
    `issue_comment` on a PR is categorized as a PR comment.
  - A PR `closed` + `merged:true` is categorized as a merge.
  - Unknown/unhandled actions return an empty list without throwing.
  - `raw` has known secret fields stripped; the adapter is pure (replayable
    against a captured payload fixture).
- **Validation**:
  - `pnpm run typecheck && pnpm test` (fixtures of recorded GitHub payloads under
    `test/fixtures/`, no live calls).

---

## Sprint 3: `live` receiver service + SSE/snapshot

**Goal**: a least-privilege process verifies and ingests webhooks and serves the
tailnet-only snapshot + SSE stream.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`.
- Verify: a signed delivery is acked 202 < 10 s, deduped, appended, broadcast;
  `/api/live` streams `text/event-stream`, replays from `Last-Event-ID`, and
  heartbeats; `ping` returns 2XX with nothing stored.

### Task 3.1: Receiver process + webhook intake

- **Location**:
  - `src/cli/live-receiver.ts`
  - `src/live/receiver.ts`
- **Description**: a `node:http` server that handles `POST /webhooks/github`:
  read raw body (Task 2.1), verify, on `ping` return 200, compute `deliveryId`,
  adapt (Task 2.2), `LiveStore.append` (dedupe), broadcast to SSE subscribers,
  then ack 202 within 10 s (keep heavy work off the ack path if it ever grows).
  Invalid signature returns 401/403 with no parse-first. The process holds only
  the `LiveStore` handle and the webhook secret (by env-var name) — no canonical
  store, no provider tokens, no config mount. Tight body-size cap +
  per-request/idle read timeout; optional GitHub hook egress CIDR allowlist
  before HMAC work.
- **Dependencies**:
  - Task 1.1
  - Task 1.3
  - Task 2.1
  - Task 2.2
- **Complexity**: 6
- **Acceptance criteria**:
  - A valid signed delivery returns 202 quickly and stores exactly one event
    (redelivery is a no-op); an invalid signature returns 401/403 and stores
    nothing; `ping` returns 2XX and stores nothing.
  - The process never opens the canonical store, never reads a provider token,
    and the webhook secret never appears in stored events or logs (assert).
  - Oversized/slow bodies are rejected by the cap/timeout.
- **Validation**:
  - `pnpm run typecheck && pnpm test` (new `test/live-receiver.test.ts`, booting
    the real server on `127.0.0.1:0`, modeled on `test/app-server.test.ts`).

### Task 3.2: In-process SSE broadcaster + snapshot + healthz

- **Location**:
  - `src/live/broadcaster.ts`
  - `src/live/receiver.ts`
- **Description**: `GET /api/live` sets `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`;
  on connect, if `Last-Event-ID` is present, replays `LiveStore.since(lastId)`
  then streams live; each frame is `id: <seq>` + `event: live` + `data: <json>`
  ended by a blank line; a heartbeat comment every ~15 s; cleans up on
  `res.on("close")`. Bound concurrent connections; shed slow consumers; do NOT
  use `sendJsonMaybeGzip` for the stream. `GET /api/live-snapshot?limit=N`
  returns `LiveStore.recent(N)` + `maxSeq` as JSON (may gzip). `GET /healthz` for
  liveness.
- **Dependencies**:
  - Task 3.1
- **Complexity**: 6
- **Acceptance criteria**:
  - `/api/live` emits `text/event-stream` with `id:`-tagged frames; a reconnect
    with `Last-Event-ID` replays only missed events; heartbeats appear ~15 s.
  - `/api/live-snapshot` returns recent events newest-first + the current max
    `seq`.
  - A closed client connection is cleaned up; the connection cap is enforced.
- **Validation**:
  - `pnpm run typecheck && pnpm test` (raw `http.request` reading `data:` frames
    until expected, then `req.destroy()`; deterministic via a `deferred()/until()`
    gate, not sleeps).

---

## Sprint 4: Live UI page

**Goal**: a new contract-independent Live tab renders, streams live in the
browser/standalone, and falls back to polling on Tauri thin clients.

**Demo/Validation**:

- Command(s): `pnpm --filter @symphony-board/ui run build`,
  `pnpm --filter @symphony-board/ui run test`,
  `pnpm --filter @symphony-board/ui run smoke`.
- Verify: the Live tab appears, seeds from the snapshot, updates on SSE, and
  renders even when `contract.json` is missing.

### Task 4.1: `useLive` hook + `fetchLiveSnapshot` client

- **Location**:
  - `packages/ui/src/contract.ts`
  - `packages/ui/src/useLive.ts`
- **Description**: add `fetchLiveSnapshot(serverBaseUrl)` to `contract.ts` using
  `appFetch` + `resolveEndpoint` (null-on-failure, like `fetchSyncControl`).
  `useLive(serverBaseUrl)` seeds via `fetchLiveSnapshot`, then in the
  browser/standalone opens `new EventSource(resolveEndpoint("./api/live",
  serverBaseUrl))`, pushing parsed events into a capped newest-first list and
  surfacing a reconnecting state on `onerror` (rely on EventSource auto-reconnect).
  When `isTauriRuntime()`, fall back to polling `fetchLiveSnapshot` on an interval
  (EventSource is not covered by plugin-http). Honor `endpointRequiresServerUrl()`
  for the Android client. Use a `cancelled` flag + ref-held callback like
  `useSync`.
- **Dependencies**:
  - Task 3.2
- **Complexity**: 5
- **Acceptance criteria**:
  - The hook seeds from the snapshot, then live-updates via EventSource in the
    browser; on Tauri it polls instead.
  - It probes the live capability and degrades cleanly when unavailable
    (hidden/empty), without throwing.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run build` + UI tests; a unit test for the
    hook's transport branch.

### Task 4.2: `LivePage` component + nav/router wiring

- **Location**:
  - `packages/ui/src/components/LivePage.tsx`
  - `packages/ui/src/nav.ts`
  - `packages/ui/src/App.tsx`
- **Description**: presentational `LivePage` (props from `useLive`), newest-first
  feed; per Decision 10 shows the full `body` by default and `raw` behind an
  expand affordance; labels the feed as live/best-effort with the board as source
  of truth. Add `"live"` to the `Page` union in `nav.ts`; in `App.tsx` extend the
  page ladder, add the nav anchor and the body branch, wire the page before the
  contract-loading gates (the `debug` early-return precedent) so it works without
  `contract.json`, and guard the shared `Controls`/`TimeRangeControls` chrome with
  `page !== "live"`.
- **Dependencies**:
  - Task 4.1
- **Complexity**: 5
- **Acceptance criteria**:
  - The Live tab is reachable, renders the feed, and updates live.
  - It renders even when `contract.json` is missing/failing.
  - The date-range/facet chrome does not render on the Live tab.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run build` + UI tests + render-smoke.

---

## Sprint 5: Deployment (Docker + nginx + public ingress) + DESIGN promotion

**Goal**: the `live` service runs in compose, SSE is reachable tailnet-only
through nginx, the webhook path is the only public surface, and the trust-boundary
change is recorded in `docs/DESIGN.md`.

**Demo/Validation**:

- Command(s): `pnpm --filter @symphony-board/ui run build`; compose up the
  default stack; a manual signed `curl` to the receiver.
- Verify: `/api/live` streams through nginx without buffering; the public ingress exposes
  only `/webhooks/*`; `/api/live*` is unreachable from the public URL.

### Task 5.1: Compose `live` service + entrypoint dispatch

- **Location**:
  - `docker/docker-entrypoint.sh`
  - `docker/compose.yaml`
  - `docker/compose.pg.yaml`
  - `.env.example`
- **Description**: add a `live` service running `src/cli/live-receiver.ts` via a
  new `SYNC_MODE=live` branch in the entrypoint. It mounts only its own `live.db`
  volume; no `config/` mount, no `*_TOKEN`, no `SYMPHONY_DB_URL`, no Docker
  socket. Env (by name): `WEBHOOK_GITHUB_SECRET`, `LIVE_DB_PATH`,
  `LIVE_EVENT_TTL_DAYS`, `LIVE_MAX_ROWS`, bind host/port. Bind loopback only,
  with a host-interface override env following the `SYMPHONY_PG_WEB_*` precedent.
  Add resource limits.
- **Dependencies**:
  - Task 3.1
  - Task 3.2
- **Complexity**: 5
- **Acceptance criteria**:
  - The `live` service starts in both stacks, binds loopback, and holds no
    canonical store / token / config mount.
  - `.env.example` documents the new env by name (no secret values).
- **Validation**:
  - `shellcheck` on the entrypoint; a compose config lint / up smoke locally.

### Task 5.2: nginx `/api/live*` route + private deployment host ingress + DESIGN promotion

- **Location**:
  - `docker/ui-nginx.conf`
  - `docs/DESIGN.md`
  - `README.md`
- **Description**: add an nginx `location /api/live` (and `/api/live-snapshot`)
  with `proxy_buffering off; proxy_http_version 1.1;` and a raised
  `proxy_read_timeout`, proxying to the `live` service (tailnet-only). Document the
  deployment step: configure public HTTPS ingress on a dedicated listener,
  path-scoped `--set-path=/webhooks`, to the `live` service; the existing private
  UI ingress stays on its own port; SSE/snapshot are never publicly exposed.
  Promote the trust-boundary decision into `docs/DESIGN.md`. (The deployment
  ingress script change lives in that external repo and is documented, not edited
  here.)
- **Dependencies**:
  - Task 5.1
- **Complexity**: 4
- **Acceptance criteria**:
  - `/api/live` streams through nginx without buffering stalls (tailnet).
  - The public ingress URL serves only `/webhooks/*`; `/api/live*` and the UI are
    not reachable from it.
  - `docs/DESIGN.md` records the new subsystem and the read-only/tailnet-only
    trust-boundary change.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run build`; nginx config test; a manual
    end-to-end signed delivery on the deployed stack (under `test/e2e/` or a
    deploy smoke, env-gated).

---

## Sprint 6: GitLab adapter interface stub (not wired)

**Goal**: the GitLab adapter is designed against `WebhookProvider` so a later
build implements the same contract, without wiring it into the receiver.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`.
- Verify: the stub compiles against the interface and documents the GitLab
  specifics; it is not registered in the receiver.

### Task 6.1: GitLab `WebhookProvider` stub + rollout gate

- **Location**:
  - `src/live/gitlab.ts`
  - `src/live/provider.ts`
- **Description**: a `WebhookProvider` stub for GitLab documenting: signing-token
  HMAC verification (`webhook-signature` header, `v1,{base64}` over
  `{message_id}.{timestamp}.{body}`) preferred over the legacy plain
  `X-Gitlab-Token`; `webhook-id` as the dedupe key; the `X-Gitlab-Event` header
  to `object_kind` mapping (Note / Merge Request / Issue / Push / Pipeline / Job
  Hook), with the `object_kind: "work_item"` branch under the Issue Hook; the
  self-managed outbound-reachability prerequisite and Decision 11
  (company-content clearance) as the rollout gate. `toLiveEvents` throws
  `not implemented` (stub); not registered in the receiver.
- **Dependencies**:
  - Task 2.2
- **Complexity**: 3
- **Acceptance criteria**:
  - The stub satisfies the `WebhookProvider` type and documents the GitLab
    specifics and Decision 11 rollout gate.
  - It is NOT wired into the receiver; enabling it is out of v1 scope.
- **Validation**:
  - `pnpm run typecheck && pnpm test`.

---

## Cross-cutting acceptance (whole feature)

- `contract.json`, the contract schema (`packages/contract`, `docs/CONTRACT.md`),
  the canonical store, the sync engine, and the Activity tab are unchanged.
- The receiver is least-privilege (no canonical store / token / config); tests
  assert it cannot acquire the canonical writer lease, soft-delete, or mutate
  canonical data, and the webhook secret never lands in stored events or logs.
- Full event content (neutral fields + body + raw + delivery metadata) is stored
  with secret fields scrubbed and TTL-pruned (Decisions 7, 10).
- The public surface is only `POST /webhooks/*`; SSE/snapshot are tailnet-only.
- The standalone app builds and runs with the Live page disabled (Decision 9).

## Validation summary

- Always: `pnpm run typecheck && pnpm test`.
- UI sprints: `pnpm --filter @symphony-board/ui run build` + UI tests + smoke.
- Shell/compose: `shellcheck`; compose up smoke.
- The live store is a separate SQLite store (not the canonical `Store`), so
  `test:pg-e2e` / `test:pg-compose` and `store-conformance` are NOT required for
  v1 — state this explicitly in each PR.
- End-to-end (real org webhook to private deployment host): under `test/e2e/` or a deploy smoke,
  env-gated and self-skipping; never the default `pnpm test` glob.
