# Realtime Live Event Stream for symphony-board — Implementation Handoff

- **Status:** ready for plan tracking (L2)
- **Date:** 2026-06-20 (Asia/Taipei)
- **Source:** discussion-to-implementation-doc — in-session requirements +
  design discussion, grounded by a parallel verification pass over official
  GitHub/GitLab/SSE/Tailscale docs, an exact map of the repo's integration
  seams, and an adversarial security/ops red-team.
- **Intended next step:** Delivered as the L2 plan bundle in this directory and
  tracked by the linked plan-tracking issue. Implement in the sprint sequence in
  the plan document. The previously-open product/policy choices (UI body
  presentation default; company clearance to mirror private GitLab content) are
  recorded as Decisions 10–11 below.

## Purpose

Capture the converged design for a **new, independent realtime "Live" activity
mechanism** so a later session can implement it without re-litigating the
settled parts. The mechanism ingests provider webhooks, verifies them, stores
them as rich provider-neutral live-event records in a **dedicated** store, and
streams them to a **new Live page** over Server-Sent Events (SSE). It is
deliberately **separate** from the existing
`raw store → canonical DB → versioned contract` pipeline, from `contract.json`,
and from the existing Activity tab.

## Confirmed facts (about the current product)

- symphony-board is a provider-agnostic work-item aggregator:
  GitHub/GitLab → canonical store (SQLite default, Postgres opt-in) → versioned
  JSON contract (currently major **v4**, emitted `4.0.0`) → a
  **read-only-toward-providers** UI. `normalize` and `buildContract` are **pure**
  (no network/IO); network lives in `src/sources/*`, DB IO in `src/db/*`,
  HTTP orchestration in `src/cli/*` + `src/server/*`. [F: `docs/DESIGN.md`,
  `AGENTS.md`]
- The product has **one writer per store**, enforced by the `Store` writer lease
  (`Store.acquireWriterLease()`), not just convention: the Docker `board` loop
  daemon for compose, or the standalone app's bundled `app-server` for its own
  per-user store. There is "intentionally no external cron and no second
  writer." [F: `AGENTS.md` Target; `docs/DESIGN.md` Runtime Decisions / #164]
- HTTP is composed per process by `node:http` `createServer` + method/path
  dispatch — **no router library**. The writer **control plane**
  (`handleControlRequest` in `src/cli/sync-daemon.ts`) gates every *mutating*
  route behind `SYNC_CONTROL_ENABLED` **plus** a same-origin custom header
  `X-Symphony-Sync-Control` (`SYNC_CONTROL_HEADER`); read-only query handlers
  (`src/server/range.ts` / `stats.ts` / `review-candidates.ts`) open the store
  via `openConfiguredStoreReadOnly` and close it per request. [F:
  `src/cli/sync-daemon.ts`, `src/server/*`]
- Docker runs three capability-split services — `board` (sole writer +
  control plane, internal port 8080), `api` (read-only sidecar, 8081), `web`
  (nginx: serves the UI + `/contract.json`, reverse-proxies `/api/*` to `board`
  or `api`). Only `web` is published, **loopback-only**; tailnet exposure is done
  **outside compose** via `tailscale serve` on the host. No published port binds
  `0.0.0.0`. [F: `docker/compose.yaml`, `docker/ui-nginx.conf`, `README.md`]
- The standalone macOS app (`src/cli/app-server.ts`) collapses all roles into
  one **loopback-only** (`127.0.0.1:8787`) process with **no inbound ingress**.
  [F: `src/cli/app-server.ts`, `packages/desktop-standalone/README.md`]
- The UI (`packages/ui`) is a zero-dependency **hash-routed SPA**: `App.tsx` is
  the single root; pages are a hard-coded union (`Page` in `nav.ts`) + a render
  ladder; all HTTP goes through `appFetch` (`runtime.ts`) +
  `resolveEndpoint` (`contract.ts`), which rebase relative `./api/...` onto the
  configured `serverBaseUrl` for thin/Android Tauri clients. There is currently
  **zero EventSource/SSE and zero webhook/HMAC code anywhere in the repo** — both
  are greenfield. [A: seam map]
- Tokens/secrets are referenced by **env-var name** and read from the
  environment, never inlined or committed; a write-only secrets surface never
  reads values back. The g14 deployment additionally keeps secrets in a SOPS/age
  store. [F: `AGENTS.md`, `docs/DESIGN.md`]

### Verified external facts (corroborated against official docs, 2026-06-20)

GitHub webhooks [W: docs.github.com/webhooks; A: verification pass]:

- Relevant events/actions: `issues` (opened/edited/closed/reopened/labeled/…),
  `issue_comment` (created/edited/deleted — **fires for both issues AND PRs**;
  disambiguate via `payload.issue.pull_request`), `pull_request` (a **merge**
  arrives as `action=closed` with `pull_request.merged=true` — there is no
  `merged` action), `pull_request_review` (submitted/edited/dismissed; the
  verdict is in `review.state`), `pull_request_review_comment`
  (created/edited/deleted), and `pull_request_review_thread`
  (resolved/unresolved).
- Signature: validate **`X-Hub-Signature-256`** = HMAC-SHA256 hex digest of the
  **raw request body**, value prefixed `sha256=`; compare **constant-time**
  (`crypto.timingSafeEqual`), never `==`. The legacy `X-Hub-Signature` (SHA-1)
  is legacy-only and must not be the basis of validation.
- Delivery headers: `X-GitHub-Delivery` is a globally unique GUID — the
  **dedupe / replay key**; `X-GitHub-Event` names the event;
  `X-GitHub-Hook-ID` / `X-GitHub-Hook-Installation-Target-*` identify the hook.
- Reliability: a receiver must return **2XX within 10 seconds** or the delivery
  is marked failed, and **GitHub does NOT auto-retry failed deliveries** —
  redelivery is manual (UI/REST). Webhooks are therefore **at-most-once**, not a
  retried queue. A `ping` event is sent on creation and must be acked.
- Scope: an **organization webhook** fans in across all the org's repos with one
  per-webhook secret (org-owner managed). (Per-repo = one secret each; GitHub App
  = one app-level webhook + one app-level secret across all installations,
  subscriptions managed at the App registration.)

GitLab webhooks [W: docs.gitlab.com; A: verification pass] (for the future
adapter):

- Events signal type via the `X-Gitlab-Event` header (`Note Hook`,
  `Merge Request Hook`, `Issue Hook`, `Push Hook`, `Pipeline Hook`, …) and
  `object_kind` in the body; `object_kind` does **not** always match the header
  (e.g. `Job Hook` → `build`). **Work items** (Tasks/Incidents/Epics/OKRs) arrive
  on the `Issue Hook` with `object_kind: "work_item"` (not `"issue"`).
- Verification: the recommended path is the **signing token** (HMAC-SHA256 in
  the lowercase `webhook-signature` header, `v1,{base64}`, signed over
  `{message_id}.{timestamp}.{body}`; GA in GitLab 19.1). The legacy plain-text
  `X-Gitlab-Token` is weaker and **not recommended for new webhooks**.
- Dedupe on the `webhook-id` header (stable across retries), **not** on
  `X-Gitlab-Event-UUID` (shared by recursive webhooks). Webhooks **auto-disable**
  after 4 consecutive failures (temporary, 1 min → 24 h backoff) and
  **permanently** after 40. Group webhooks require a paid tier.
- A self-managed/internal GitLab (e.g. `gitlab.gamania.com` behind VPN) can only
  deliver if **the GitLab host has outbound reachability** to the public
  receiver URL — webhooks are server-initiated outbound POSTs. By default GitLab
  also blocks deliveries to private/local addresses; a public receiver URL
  sidesteps that.

SSE / EventSource [W: html.spec.whatwg.org, MDN, nginx docs; A: verification
pass]:

- Wire format is `text/event-stream`: `data:` / `event:` / `id:` / `retry:`
  fields, an **empty line dispatches** the event, lines starting `:` are
  comments. Default event type is `message`.
- Resumability: the server sends `id:`; the browser stores it and echoes it as
  the **`Last-Event-ID` request header** on automatic reconnect. **Gap recovery
  only works if the server keeps a backlog keyed by that id and replays it** —
  the browser side is automatic, the server side is not. An `id:` value
  containing a NUL byte is silently ignored.
- Reverse-proxy reality: nginx `proxy_buffering` is **on by default** and will
  batch/stall SSE; fix with `proxy_buffering off` on the SSE location and/or the
  app emitting `X-Accel-Buffering: no`. Emit a **heartbeat comment (`:`) every
  ~15 s** so intermediaries don't drop the idle connection. HTTP/1.1 has a
  ~6-connection-per-origin cap (HTTP/2 multiplexing removes it).
- **EventSource cannot set custom request headers** (only `withCredentials`).
  Auth on the stream is limited to cookies or a URL token unless you abandon
  native EventSource for a `fetch()`+ReadableStream client.

Tailscale Funnel [W: tailscale.com/kb; A: verification pass]:

- Funnel exposes a tailnet node to the **public internet over HTTPS** (TLS
  terminated on the node; the relay is a pass-through). It listens on **only
  ports 443, 8443, 10000**, can be **path-scoped** via `--set-path`, and
  requires the **`funnel` node attribute** in the tailnet policy (admin action).
- Public/private is **per PORT, not per path**: you cannot have one path on a
  port be Funnel-public while another path on the *same* port stays Serve-only —
  most-recent-command-wins flips the whole port. To expose only the webhook path
  publicly, run **Funnel on its own dedicated port** (path-scoped) and keep the
  existing `tailscale serve` (tailnet-only) on a **different** port.
- The backend behind Funnel receives the **original headers + raw body intact**
  (so raw-body HMAC verification works), but **not** the original client IP
  unless `--proxy-protocol` is enabled. Funnel has non-configurable bandwidth
  limits and **no built-in per-request rate-limiting or access logging** — the
  endpoint must do its own signature/auth/abuse handling.

## Decisions (adopted direction)

These are settled. Rationale is given where a later implementer might otherwise
re-open them.

1. **Fully separate subsystem.** [U1, U2, U3] The Live mechanism is a parallel
   pipeline — `webhook receiver → verified delivery → dedicated append-only
   live-event store → provider-neutral live-event record → snapshot + SSE → Live
   page`. It does **not** modify `contract.json`, the contract schema
   (`packages/contract`, `docs/CONTRACT.md`), the canonical store, or the
   existing Activity tab. The live-event record is its **own** schema, versioned
   independently, and **must not** be folded into the product contract.

2. **Dedicated live-event store, owned by the receiver — not the canonical
   store.** [I, resolving a seam-mapping divergence] One seam analysis argued for
   adding live-event tables *inside* the canonical store (so the existing sole
   writer writes them). We **reject** that for two load-bearing reasons: (a) U1
   demands complete separation; (b) the receiver is a **public-internet-facing**
   process, and the security red-team requires it to run **least-privilege with
   no handle to the canonical store, provider tokens, or secrets** — which is
   impossible if it must open the canonical store to append. The live-event store
   is therefore a **separate store with its own single writer (the receiver)**.
   This honors "one writer per store" (each store has exactly one writer); it
   does **not** introduce a second writer to the *canonical* store. The receiver
   never acquires the canonical writer lease, never soft-deletes, and never
   mutates canonical items/edges.

3. **v1 live store = a dedicated SQLite database**, independent of the canonical
   store's driver. [I] Append-only, TTL-pruned, single-writer, low value to
   replicate — so it stays out of the canonical `Store` interface, the
   `store-conformance` suite, and the Postgres compose gates. If a Postgres
   deployment later wants the live store on Postgres too, that is an additive
   follow-up, not a v1 requirement.

4. **Public ingress via Tailscale Funnel, path-scoped, on its own port.** [U,
   chosen] Funnel exposes **only** the inbound webhook path
   (e.g. `https://<g14-node>.<tailnet>.ts.net:8443/webhooks/github`) on a
   dedicated funnel-enabled port; the existing UI (and the new SSE/snapshot
   routes) stay on the existing `tailscale serve` (tailnet-only) port,
   **never funneled**. Granting the `funnel` node attribute is a one-time admin
   change to the tailnet policy. An external verify-and-forward relay (small
   VPS / Cloudflare Worker / smee-style) is recorded as a documented alternative
   if zero public ingress on g14 is later required.

5. **Org/group-level webhook + single shared HMAC secret per provider.** [U,
   chosen] One GitHub **organization webhook** (e.g. `sympoies`) covers all
   current and future repos; the secret is stored **by env-var name** and read
   from the environment, integrated with the existing SOPS/age + secrets flow.
   GitHub App webhooks are recorded as a future option.

6. **GitHub first; GitLab adapter designed but stubbed.** [U, chosen] Ship the
   GitHub receiver end-to-end behind a provider-adapter interface; implement the
   GitLab adapter against the same interface later. Matches the repo's
   established "GitHub lands first" pattern and avoids blocking on self-hosted
   GitLab outbound reachability and company-content clearance.

7. **Retention: TTL-bounded, default ~30 days, row-capped; full raw payload
   retained, with secret-field scrubbing.** [U4, U-chosen] The live store keeps
   the full raw payload + neutral record + delivery metadata, but is a
   **freshness buffer, not a system of record**: a background prune drops events
   older than `LIVE_EVENT_TTL_DAYS` (default 30) and enforces a max row count.
   Known secret-bearing fields (installation/app tokens, signatures) are
   **stripped before persist**. The webhook secret is never persisted or logged.

8. **Verified-only ingestion; the live feed is freshness, not truth.** [W2, W4,
   I3] A delivery is untrusted until signature verification succeeds over the
   **raw body** with a constant-time compare and **no permissive fallback**. The
   existing **periodic full/incremental sync remains the canonical
   reconciliation/backstop**; because GitHub does not auto-retry, the live feed
   may have gaps (receiver downtime), so the UI must label it as a live feed and
   point to the board as the source of truth. v1 does **not** couple webhook →
   canonical sync; a debounced "webhook hints a sync" enhancement is a documented
   future option.

9. **Receiver + SSE/snapshot served by one new isolated `live` service;
   server/Docker-only.** [A: seam map; red-team] The receiver also serves the
   tailnet-only SSE + snapshot reads (it owns the live store and the in-process
   broadcaster). The standalone macOS app has no public ingress, so the Live
   page/receiver is **absent/disabled** there (capability-gated OFF) — the
   inverse of the sync/config control planes' standalone-ON default.

10. **Live page shows full event content by default; a redaction/collapse toggle
    is a follow-up.** [U4 deferral, now resolved to a default] The Live page
    renders the neutral summary plus the full `body` by default, consistent with
    the existing board's trust model (private tailnet, no public UI exposure).
    The full `raw` payload sits behind an expand/"raw" affordance (like the
    Commits page expands commit bodies), not inline by default. A per-source or
    global redaction/collapse control is a documented follow-up — and becomes a
    **requirement** once private GitLab content is ingested (see Decision 11).

11. **Mirroring private GitLab content is a hard prerequisite for enabling the
    GitLab adapter.** [red-team; policy] Before the GitLab receiver is enabled
    for an internal/self-managed instance (e.g. `gitlab.gamania.com`), confirm
    company policy permits mirroring internal issue/MR/comment text off the
    GitLab host onto the deployment host, and decide whether per-client authz /
    per-source visibility filtering on the SSE stream is then required. v1 is
    GitHub-only, so this does **not** block v1; it gates the GitLab adapter's
    **rollout**, not its interface design.

## Scope

- A GitHub webhook receiver (org-level), signature-verified, behind a
  provider-adapter interface.
- A dedicated append-only live-event store (SQLite) with TTL prune.
- A provider-neutral, independently-versioned live-event record schema.
- A tailnet-only snapshot HTTP endpoint + an SSE stream with resumable replay.
- A new contract-independent "Live" UI page (web + standalone same-origin; thin
  clients fall back to polling).
- Docker `live` service + Funnel/serve deployment shape for g14.
- A GitLab adapter **interface design** (no implementation in v1).

## Non-scope

- Any change to `contract.json`, the contract schema, `docs/CONTRACT.md`, the
  canonical store, the sync engine, or the Activity tab as a **settled** change.
  (The contract may *optionally* gain a small capability hint in a later phase;
  not in v1.)
- Provider write-back of any kind (unchanged product non-goal).
- GitLab receiver implementation (interface only in v1).
- Live receiver on the standalone macOS app (no public ingress).
- Per-client authz / per-source visibility filtering on the stream (v1 relies on
  the tailnet boundary; see Risks for the deferral trigger).
- Bidirectional browser↔server messaging / WebSocket (SSE is sufficient — U5).
- Making the live feed authoritative or a soft-delete source.

## Architecture

```text
                         PUBLIC INTERNET                       TAILNET-ONLY
github.com org webhook ───────────────┐              ┌──────────────────────────┐
                                       │              │                          │
   Tailscale Funnel (dedicated port,   ▼              │   tailscale serve (UI)   │
   --set-path=/webhooks) ───► POST /webhooks/github   │            │             │
                                       │              │            ▼             │
                              ┌────────┴───────────────────────────┴──────────┐  │
                              │              NEW `live` service                │  │
                              │  (least-privilege: NO canonical store handle,  │  │
                              │   NO provider tokens, NO config mount)         │  │
                              │                                                │  │
                              │  1. read RAW body (Buffer)                     │  │
                              │  2. verify X-Hub-Signature-256 (HMAC-SHA256,   │  │
                              │     constant-time) ─ reject if invalid         │  │
                              │  3. dedupe on X-GitHub-Delivery                │  │
                              │  4. adapt → provider-neutral LiveEvent         │  │
                              │  5. append to dedicated live-event store ──────┼──┼─► live.db (SQLite,
                              │  6. broadcast to SSE subscribers               │  │   append-only, TTL prune)
                              │  ack 202 (<10s)                                │  │
                              │                                                │  │
                              │  GET /api/live-snapshot  (JSON, tailnet)       │  │
                              │  GET /api/live           (SSE,  tailnet)  ◄────┼──┤  nginx web proxies
                              └────────────────────────────────────────────────┘  │  /api/live* (proxy_buffering off)
                                                                                   │            │
                                                                                   │            ▼
                                                                                   │   New "Live" UI page
                                                                                   └──────────────────────────┘

   Existing pipeline (UNCHANGED): providers ─fetch─► raw ─normalize─► canonical DB ─buildContract─► contract.json ─► UI
   The periodic sync remains the canonical reconciliation / backstop.
```

- The receiver is the **sole writer** of `live.db`; the canonical store keeps its
  own sole writer (the `board` daemon). The two pipelines share nothing but the
  `source_id` vocabulary.
- The public surface is **only** `POST /webhooks/<provider>`. SSE/snapshot are
  tailnet-only and **must never** be funneled.

### Provider adapter interface

A pure, network-free adapter per provider keeps the receiver provider-agnostic
and lets GitHub land first with GitLab implementing the same contract later.
Pure so it is unit-testable and replayable against captured payloads (mirrors
the repo's pure-`normalize` discipline).

```ts
interface WebhookProvider {
  readonly id: "github" | "gitlab";

  // Verify the delivery over the RAW request bytes. Returns the verdict only;
  // no parsing, no side effects. Constant-time compare; no permissive fallback.
  verify(rawBody: Buffer, headers: IncomingHttpHeaders, secret: string): VerifyResult;

  // Stable per-delivery dedupe key from headers (GitHub X-GitHub-Delivery;
  // GitLab webhook-id). Used for idempotent append.
  deliveryId(headers: IncomingHttpHeaders): string | null;

  // True for non-domain control deliveries that must be acked but not stored
  // (GitHub `ping`, etc.).
  isControlEvent(headers: IncomingHttpHeaders, parsed: unknown): boolean;

  // Pure transform of a verified, parsed payload into provider-neutral events.
  // May yield 0..n events (e.g. a GitLab push carries multiple commits).
  // Returns [] for events the Live feed does not surface (ignore gracefully).
  toLiveEvents(parsed: unknown, ctx: AdaptCtx): LiveEvent[];
}

type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "bad_format" | "mismatch" };

interface AdaptCtx {
  sourceId: string;        // canonical "github:github.com" vocabulary
  deliveryId: string;
  receivedAt: string;      // ISO-8601 UTC
  eventHeader: string;     // X-GitHub-Event / X-Gitlab-Event
}
```

Routing maps `(event header, action/object_kind)` explicitly and **ignores
unknown actions gracefully** (provider action enums are version-volatile).
GitHub specifics the adapter must encode: `issue_comment` disambiguation via
`issue.pull_request`; PR merge = `closed` + `merged:true`; review verdict in
`review.state`; `pull_request_review_thread` resolved/unresolved.

### Live event schema (independent of the product contract)

```jsonc
{
  "schema": "live-event/1",          // own version line; NOT contract_version
  "seq": 10427,                       // monotonic append id; the SSE id: (NUL-free)
  "event_id": "GUID-from-provider",   // dedupe key (X-GitHub-Delivery / webhook-id)
  "source_id": "github:github.com",   // canonical source vocabulary
  "provider": "github",
  "received_at": "2026-06-20T08:14:55Z",
  "occurred_at": "2026-06-20T08:14:53Z", // provider event time when available (display ordering)
  "event_type": "pull_request_review",   // provider event name
  "action": "submitted",                  // provider action/sub-action, nullable
  "category": "review",                   // neutral: issue | change_request | comment | review | review_comment | review_thread | push | pipeline | ... (open vocab)
  "actor": { "login": "octocat", "display_name": "The Octocat", "avatar_url": "...", "profile_url": "https://github.com/octocat" },
  "target": {
    "kind": "change_request",             // issue | change_request | repo | commit ...
    "source_id": "github:github.com",
    "project_path": "sympoies/symphony-board",
    "number": 305,                         // provider number/iid (64-bit safe; string-encode if needed)
    "external_id": "PR_kwDО...",           // provider immutable id when known
    "title": "feat: live event stream",
    "url": "https://github.com/sympoies/symphony-board/pull/305"
  },
  "title": "octocat approved PR #305",     // human one-line summary
  "body": "LGTM, nice work …",             // FULL comment/review/MR/issue body (U4); nullable
  "url": "https://github.com/.../pull/305#pullrequestreview-...",
  "review_state": "approved",              // provider-specific detail, nullable
  "delivery": {
    "delivery_id": "GUID",
    "event_header": "pull_request_review",
    "hook_id": "...",
    "signature_status": "verified"
  },
  "provider_details": { /* small, curated provider-specific extras */ },
  "raw": { /* full raw provider payload, secret-fields scrubbed; TTL-pruned */ }
}
```

- **Identity / dedupe:** unique `(source_id, event_id)` → append-only,
  insert-or-ignore. `seq` is a per-store monotonic integer (autoincrement /
  rowid), used as the SSE `id:` and the `Last-Event-ID` resume cursor.
- Honor the repo's existing guards: 64-bit-safe provider numbers and the
  NUL-byte guard (`test/no-nul-bytes.test.ts`); ids used as SSE `id:` must be
  NUL-free.
- `raw` is retained per Decision 7 (TTL + scrub). UI presentation of `body`/`raw`
  follows Decision 10: full `body` shown by default, `raw` behind an expand
  affordance.

### HTTP / SSE API shape

Public (funneled, path-scoped):

| Route | Method | Auth | Behavior |
| --- | --- | --- | --- |
| `/webhooks/github` | POST | **HMAC `X-Hub-Signature-256`** over raw body, constant-time | Verify → ack **202 within 10 s** → (async) dedupe, adapt, append, broadcast. `ping` → 200. Invalid/missing signature → 401/403, no parse-first. Unknown event/action → 204/ignore. |
| `/webhooks/gitlab` | POST | signing-token HMAC (`webhook-signature`) preferred; legacy `X-Gitlab-Token` only if unavoidable | **v1: stub** (interface only). |

Tailnet-only (proxied by nginx `web`, `proxy_buffering off`; **never funneled**):

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/live-snapshot?limit=N` | GET | JSON: newest-first recent live events + current max `seq`; seeds the Live page. May gzip via `sendJsonMaybeGzip`. |
| `/api/live` | GET | **SSE** `text/event-stream`. Per event: `id: <seq>\nevent: live\ndata: <json>\n\n`. Honors `Last-Event-ID` (replay backlog since that seq from `live.db`). Heartbeat comment `:` ~15 s. Sets `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Bounded concurrent connections + idle timeout + slow-consumer shedding. |
| `/healthz` | GET | liveness. |

SSE handler must **not** use `sendJsonMaybeGzip` (it ends the response); it
writes frames on a kept-open socket and tears down on `res.on("close")`.

### UI page behavior

- New top-level **Live** tab, **independent of `contract.json`**. Touch four
  places (per the seam map): add `"live"` to the `Page` union (`nav.ts`); extend
  the `page` derivation ladder, add the nav `<a href={routeHref("live")}>`, and
  add the body branch in `App.tsx`; add `LivePage.tsx`
  (`packages/ui/src/components/`); add a `useLive(serverBaseUrl)` hook
  (`packages/ui/src/`).
- Because it must work **without** `contract.json`, render it via an **early
  return placed before** `App.tsx`'s contract-loading gates — exactly like the
  existing `route.page === "debug"` (DebugPage) precedent. Add `page !== "live"`
  guards around the shared `Controls`/`TimeRangeControls` chrome (it shares no
  date range or facets).
- Data flow: `useLive` (a) seeds via `fetchLiveSnapshot(serverBaseUrl)` (new
  client fn in `contract.ts`, using `appFetch` + `resolveEndpoint`, null-on-
  failure like `fetchSyncControl`), then (b) opens
  `new EventSource(resolveEndpoint("./api/live", serverBaseUrl))`, pushes
  `JSON.parse(ev.data)` into a capped in-memory list (newest-first), and relies
  on EventSource auto-reconnect (surface a "reconnecting" state on `onerror`).
- **Transport branch:** EventSource is **not** covered by `appFetch` /
  Tauri plugin-http and cannot stream from thin clients. `if (isTauriRuntime())`
  the hook **falls back to polling** `fetchLiveSnapshot` on an interval (the
  standalone app, served same-origin, can use native EventSource — but it has no
  receiver, so its Live page is disabled regardless). The Android client must
  honor `endpointRequiresServerUrl()`.
- Presentation must label the feed as **live/best-effort** and the board as the
  source of truth. Per Decision 10, the full `body` is shown by default and
  `raw` sits behind an expand affordance; a redaction/collapse toggle is a
  follow-up (required once private GitLab content is ingested — Decision 11).

### Deployment requirements (g14 / Docker)

- New 4th compose service `live` (e.g. `SYNC_MODE=live` dispatched in
  `docker/docker-entrypoint.sh`, new entrypoint `src/cli/live-receiver.ts`):
  - Mounts **only** its own `live.db` volume. **No** `config/` mount, **no**
    provider `*_TOKEN`, **no** `SYMPHONY_DB_URL`, **no** Docker socket.
  - Env (by name): `WEBHOOK_GITHUB_SECRET`, `LIVE_DB_PATH`,
    `LIVE_EVENT_TTL_DAYS` (default 30), `LIVE_MAX_ROWS`, bind host/port.
  - Run with resource limits (cgroup mem/cpu), read-only rootfs, dropped
    capabilities.
- Binds **loopback only**, like every other service. Public exposure is
  host-level **Tailscale Funnel on a dedicated funnel port (443/8443/10000),
  path-scoped to `/webhooks`** → the `live` service. The existing
  `tailscale serve` (UI) stays on its own port (tailnet-only). Add the
  receiver's bind env to `.env.example` following the `SYMPHONY_PG_WEB_*`
  precedent. The g14-infra `serve.sh` owns the actual funnel/serve wiring.
- nginx `web` gains an `/api/live` + `/api/live-snapshot` location proxying to
  the `live` service with `proxy_buffering off; proxy_http_version 1.1;
  proxy_read_timeout` raised; `/api/live*` is **tailnet-only**.
- Funnel requires the one-time `funnel` node attribute in the tailnet policy
  (admin action). The public URL is `https://<g14-node>.<tailnet>.ts.net:<port>/webhooks/github`.
- **Standalone app:** Live receiver absent/disabled (no public ingress); keep
  its periodic sync.

### Security & verification

- **Read the raw body as a `Buffer`** and compute HMAC over those exact bytes
  **before any `JSON.parse`**. Do **not** reuse `sync-daemon.ts`'s string-coercing
  `readBody`; add a `readBodyBytes` variant. Compare with `crypto.timingSafeEqual`
  on equal-length buffers (length-check first). Reject on missing/malformed/
  length-mismatch/digest-mismatch — **no permissive fallback**.
- Do **not** reuse `X-Symphony-Sync-Control` for the webhook route — that is a
  same-origin browser gate and webhooks are legitimately cross-origin. The HMAC
  signature **is** the auth for `/webhooks/*`. All existing mutating control-plane
  routes keep their `X-Symphony-Sync-Control` gate unchanged.
- **Secret handling:** by env-var name only, via SOPS/age + the secrets overlay;
  never inlined, never logged, never stored in the live-event store. Support
  **dual-secret verification** (current + previous) for zero-downtime rotation;
  document the runbook. Use a distinct secret per provider.
- **DoS controls:** tight `Content-Length` pre-check + streamed byte cap +
  per-request/idle read timeout; in-app rate limiting; optional GitHub hook
  egress CIDR allowlist (GitHub `meta` API) so non-provider traffic is dropped
  before HMAC work; bounded concurrent SSE connections with backpressure.
- **Data exposure:** strip secret-bearing fields from `raw` before persist; TTL
  prune; co-locate `live.db` under the same at-rest protection posture as the
  rest of g14-infra. SSE/snapshot tailnet-only, **never funneled**.
- **Isolation invariants (assert in tests):** the receiver cannot acquire the
  canonical writer lease, cannot soft-delete, and cannot mutate canonical
  items/edges; the secret never appears in stored events or logs.

### Dedupe / idempotency

- Append is insert-or-ignore on unique `(source_id, event_id)` where `event_id`
  is the provider delivery id (`X-GitHub-Delivery`; GitLab `webhook-id`). A
  redelivery or manual replay is a no-op.
- Optionally reject deliveries whose provider timestamp is older than a bounded
  skew window (replay hardening). The live store is a presentation buffer, so a
  replayed event cannot corrupt canonical state by construction.

### Retry / replay / reconnect

- **Provider → receiver:** at-most-once (GitHub does not auto-retry; GitLab
  retries then auto-disables). The receiver acks fast (202) and processes async
  to stay under the 10 s budget. Missed deliveries (receiver downtime) are **not**
  recovered by the stream — the periodic canonical sync is the content backstop
  (Decision 8). Operators should monitor GitLab auto-disable when that adapter
  ships.
- **Receiver → browser (SSE):** the server assigns a monotonic `seq` as `id:` and
  keeps a bounded backlog in `live.db`; on reconnect it replays events newer than
  the client's `Last-Event-ID`. The snapshot endpoint seeds initial state; the
  TTL/row-cap bounds the replay window. The browser reconnects automatically; the
  server may tune cadence with `retry:`.
- **Receiver restart:** in-memory subscribers are dropped (browsers reconnect
  and replay from `Last-Event-ID`); the durable backlog lives in `live.db`.

### Reconciliation / backstop with existing sync

- The webhook channel improves **freshness**; the existing full/incremental sync
  remains the **authoritative reconciliation** path and the only thing that
  writes the canonical store or tombstones via a full+complete sweep [I3, F:
  `AGENTS.md` disappearance rule]. The two never write the same store. The Live
  page is explicitly a live feed, not the board's state of record; when they
  disagree, the board (contract) wins.

## Requirements

- A pure, network-free `WebhookProvider` GitHub adapter + signature verifier.
- A dedicated append-only live-event store (SQLite) with unique-delivery dedupe,
  monotonic `seq`, TTL/row-cap prune, and a backlog read for `Last-Event-ID`.
- The `live` receiver service: public `/webhooks/github` (HMAC-gated, raw-body),
  tailnet `/api/live-snapshot` + `/api/live` (SSE), `/healthz`; least-privilege.
- An in-process broadcaster fanning verified events to SSE subscribers with
  bounds/backpressure.
- The Live UI page + `useLive` hook + `fetchLiveSnapshot` client fn, contract-
  independent, with the Tauri polling fallback.
- Compose `live` service + nginx `/api/live*` location (`proxy_buffering off`) +
  `.env.example` entries; g14 Funnel/serve wiring (serve.sh, out of repo).
- GitLab adapter **interface** present and documented; not wired.

## Acceptance criteria

- A GitHub org webhook delivery with a valid `X-Hub-Signature-256` is verified
  over the **raw bytes**, deduped on `X-GitHub-Delivery`, adapted to a LiveEvent,
  appended once, broadcast to connected SSE clients, and acked **2XX < 10 s**.
  A one-byte payload mutation, a wrong secret, a missing/legacy-SHA1 signature,
  and a redelivery are each handled correctly (reject / reject / reject /
  no-op). A `ping` returns 2XX and stores nothing.
- The live-event record carries the full neutral fields **and** body + raw
  payload + delivery metadata per the schema (U4), with secret fields scrubbed.
- `/api/live` streams `text/event-stream` with `id:`-tagged events, survives an
  nginx proxy (no buffering stall), emits heartbeats, and a reconnect with
  `Last-Event-ID` replays only the missed events. `/api/live-snapshot` seeds the
  page.
- The Live page renders **without `contract.json`**, updates live in the browser/
  standalone, and polls as a fallback on Tauri thin clients; it is labeled a live
  feed.
- The receiver runs with **no** canonical store handle, **no** provider tokens,
  **no** config mount; tests assert it cannot acquire the canonical lease,
  soft-delete, or mutate canonical data, and that the secret never lands in
  stored events or logs.
- Funnel exposes **only** `/webhooks/*`; SSE/snapshot are unreachable from the
  public URL. The contract schema, `contract.json`, canonical store, and Activity
  tab are unchanged.
- The standalone app builds and runs with the Live page disabled (no receiver).

## Validation plan

- Backend gate (always): `pnpm run typecheck && pnpm test`. Add `test/live-*.test.ts`
  following `node:test` + `node:assert/strict`, booting the real receiver on
  `127.0.0.1:0`: HMAC verifier as a **pure unit test** (valid / tampered body /
  wrong secret / missing header / non-UTF-8 byte / legacy SHA-1); append-only
  store idempotency/ordering; SSE framing + `Last-Event-ID` replay via a raw
  `http.request` reading `data:` frames. Network-free (no provider calls; loopback
  inbound).
- UI gate (Live page touches UI): `pnpm --filter @symphony-board/ui run build`,
  UI tests, and `smoke`.
- The live store is a **separate** SQLite store, **not** the canonical `Store`,
  so the Postgres gates (`test:pg-e2e`, `test:pg-compose`) and
  `store-conformance` are **not** required for v1 unless the live store is later
  put on Postgres. State this explicitly in the PR.
- Docs sanity for this handoff: `git diff --check` and a Markdown lint if the
  repo runs one (none is wired today — see final response).
- A live end-to-end check (real org webhook → g14 receiver) belongs under
  `test/e2e/` (env-gated, self-skipping) or a manual deploy smoke, never the
  default glob.

## Risks and guardrails

- **First public ingress onto g14** (which also holds the canonical store,
  tokens, and SOPS/age secrets). *Guard:* least-privilege `live` service with no
  access to those; Funnel path-scoped to `/webhooks` on its own port; the
  external verify-and-forward relay remains the fallback if the residual
  blast-radius is unacceptable.
- **Confidential content at rest / in flight.** Storing full raw payloads and
  streaming bodies is fine for GitHub on a private tailnet board, but
  **private `gitlab.gamania.com` content is a separate matter** — confirm company
  policy permits mirroring internal issue/MR/comment text off the GitLab host
  **before** enabling the GitLab adapter (now Decision 11). *Guard:* GitLab is
  stubbed in v1; scrub + TTL + tailnet-only SSE.
- **SSE has no per-client authz** — it relies on the tailnet boundary, like the
  rest of the UI. Acceptable for v1's data class. *Deferral trigger:* when the
  GitLab adapter (private content) ships, revisit per-client auth + per-source
  visibility filtering (Decision 11).
- **GitLab auto-disable** after consecutive failures can silently kill the future
  feed; monitor when that adapter lands.
- **Layer purity:** keep verification/adaptation pure; the new live table is a
  separate-store concern and must never leak into the product contract.

## Retention intent

This file is the L2 `*-discussion-source.md` for the
`docs/plans/2026-06-20-live-event-stream/` bundle. Promote the settled parts
into `docs/DESIGN.md` (the normative record — this changes the product's stated
read-only / tailnet-only trust boundary) as part of the build, in the same PR
sequence as the implementation.

## Read-first references

- `docs/DESIGN.md` — three layers, sole-writer lease, the two existing control
  planes, Docker topology, UI pages.
- `AGENTS.md` — layer purity, identity, disappearance rule, secret handling,
  sole-writer-per-store.
- `src/cli/sync-daemon.ts` / `src/cli/app-server.ts` — HTTP composition,
  `handleControlRequest`, `SYNC_CONTROL_HEADER`, `readBody` (and why a
  `readBodyBytes` is needed).
- `docker/ui-nginx.conf` — proxy routing precedent for a new `/api/live*`
  location.
- `packages/ui/src/{App.tsx,nav.ts,runtime.ts,contract.ts}` and
  `components/ActivityPage.tsx`, `useSync.ts`, `useDebug.ts` — page/route/hook
  patterns; the `debug` early-return precedent for a contract-independent page.
- `docs/g14-infra` / `serve.sh` (external repo) — Tailscale serve/funnel IaC.
- Official docs (verified 2026-06-20): GitHub webhook events
  (docs.github.com/webhooks) + signature validation; GitLab webhook events +
  signing token (docs.gitlab.com); SSE/EventSource (html.spec.whatwg.org, MDN) +
  nginx `proxy_buffering`; Tailscale Funnel (tailscale.com/kb/1223, /1311).

## Execution

- Recommended plan: `docs/plans/2026-06-20-live-event-stream/live-event-stream-plan.md`
- Recommended execution state: `docs/plans/2026-06-20-live-event-stream/live-event-stream-execution-state.md`
- Status: ready for plan tracking
- **Suggested sprint sequence (dependency-ordered):**
  1. **Sprint 1** — dedicated live-event store + neutral `live-event/1` schema +
     TTL/row-cap prune (foundation; no public surface).
  2. **Sprint 2** — raw-body reader + GitHub HMAC verifier + `WebhookProvider`
     GitHub adapter (all pure; unit-testable).
  3. **Sprint 3** — `live` receiver service (`POST /webhooks/github`) + in-process
     SSE broadcaster + `GET /api/live` / `/api/live-snapshot` / `/healthz`.
  4. **Sprint 4** — Live UI page + `useLive` hook + `fetchLiveSnapshot` (contract-
     independent; Tauri polling fallback).
  5. **Sprint 5** — Docker `live` service + nginx `/api/live*` (`proxy_buffering
     off`) + `.env.example`; g14 Funnel/serve wiring (serve.sh) + `docs/DESIGN.md`
     trust-boundary promotion.
  6. **Sprint 6** — GitLab `WebhookProvider` adapter **interface stub** (not
     wired; rollout gated by Decision 11).
- A `docs/DESIGN.md` promotion of the trust-boundary decision rides Sprint 5.
