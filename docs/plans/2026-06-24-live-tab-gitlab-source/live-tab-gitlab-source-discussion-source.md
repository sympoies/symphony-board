# GitLab source for the Live event stream — Implementation Handoff

- **Status:** ready for plan tracking (L2)
- **Date:** 2026-06-24 (Asia/Taipei)
- **Source:** discussion-to-implementation-doc — grounded by a parallel
  feasibility pass over the repo (the existing `src/live/*` subsystem and its
  GitLab interface stub), an adversarial verification pass over the riskiest
  technical and governance claims, and the settled design of the parent
  `docs/plans/2026-06-20-live-event-stream/` bundle (Decisions 6, 10, 11 and the
  verified GitLab webhook facts).
- **Intended next step:** Delivered as the L2 plan bundle in this directory and
  tracked by the linked plan-tracking issue. Implement in the sprint sequence in
  the plan document.

## Purpose

The realtime **Live** event stream shipped GitHub-only by design
(`docs/plans/2026-06-20-live-event-stream/`, Decision 6: "GitHub first; GitLab
adapter designed but stubbed"). The GitLab side exists only as an interface stub
(`src/live/gitlab.ts`): `verify()` and `toLiveEvents()` throw "not implemented"
and the provider is not wired into the receiver. This bundle plans turning that
stub into a working **GitLab source** for the Live stream — implementing the
adapter, wiring it into the receiver, exposing the webhook ingress, and
resolving the governance/UI preconditions for ingesting private GitLab content.

It is a strict continuation of the parent feature. It does **not** revisit the
parent's settled decisions; it executes the deferred GitLab work against the
same `WebhookProvider` contract and the same separate-store / least-privilege /
tailnet-only-reads trust boundary.

## Confirmed facts (current product)

- The Live subsystem is a **separate pipeline** from `raw → canonical →
  contract`: `webhook → verified delivery → dedicated append-only live-event
  store (`live.db`, SQLite) → provider-neutral `live-event/1` record → snapshot
  + SSE → contract-independent Live UI page`. It touches neither `contract.json`
  (now contract major **v4**, emitted `4.0.0`), the contract schema
  (`packages/contract`, `docs/CONTRACT.md`), the canonical `Store`, the sync
  engine, nor the Activity tab. [F: `docs/DESIGN.md` "Live Event Stream";
  `src/live/*`]
- The `live` receiver is **least-privilege**: it holds only its own `live.db`
  handle and the webhook secret (by env-var name) — **no** canonical store, **no**
  provider tokens, **no** `config/` mount, **no** Docker socket. It is the sole
  writer of `live.db`. [F: `src/cli/live-receiver.ts`, `src/live/receiver.ts`,
  Decision 2]
- The receiver runs **two disjoint HTTP listeners** so the public/tailnet split
  does not depend on out-of-repo proxy config alone:
  - **Public** webhook listener: `POST /webhooks/<provider>` (+ `/healthz`),
    routed `path.startsWith("/webhooks/")` → `routes.get(segment)`. This is the
    only public surface. [F: `src/live/receiver.ts`]
  - **Tailnet-only** reads listener: `GET /api/live` (SSE) + `/api/live-snapshot`
    (+ `/healthz`), proxied by nginx with `proxy_buffering off`. [F:
    `src/live/receiver.ts`, `docker/ui-nginx.conf`]
- Provider adaptation goes through the pure `WebhookProvider` interface
  (`src/live/provider.ts`): `verify(rawBody, headers, secrets) → VerifyResult`,
  `deliveryId(headers)`, `isControlEvent(headers, parsed)`,
  `toLiveEvents(parsed, ctx) → LiveEventInput[]`. The GitHub adapter
  (`src/live/github.ts`) is the reference implementation; the verifier
  (`src/live/verify.ts`) and raw-body reader (`src/live/http-body.ts`) are pure
  and reusable patterns. [F: `src/live/*`]
- The GitHub route binds a **single fixed** `sourceId` (`GITHUB_SOURCE_ID`)
  per `ProviderRoute`, fed into `AdaptCtx.sourceId`. [F: `src/cli/live-receiver.ts`,
  `src/live/receiver.ts`]
- `src/live/gitlab.ts` already encodes the GitLab specifics as design comments
  and is a typed stub: `GITLAB_SOURCE_ID_PREFIX = "gitlab:"` (a **prefix**, not a
  fixed id — unlike GitHub), `eventHeaderName = "x-gitlab-event"`,
  `hookIdHeaderName = "x-gitlab-webhook-uuid"`, `deliveryId()` reads `webhook-id`
  (implemented), `isControlEvent()` returns `false` (no GitLab `ping` analog).
  [F: `src/live/gitlab.ts`]
- `test/live-gitlab.test.ts` contains an explicit guard asserting the stub is
  **NOT wired** into the receiver in v1 — it greps `src/live/receiver.ts` and
  `src/cli/live-receiver.ts` for `/GitlabWebhookProvider|gitlab\.ts/` and fails
  if either matches. Wiring GitLab **will** break this test; it must be replaced
  with a "GitLab IS wired" assertion as part of this work. [F:
  `test/live-gitlab.test.ts`]
- The canonical board already ingests GitLab from **more than one host** —
  `gitlab.com` and the self-managed `gitlab.gamania.com` — which map to distinct
  canonical source ids `gitlab:gitlab.com` and `gitlab:gitlab.gamania.com`. [F:
  `src/sources/registry.ts`, `config/sources.json`; AGENTS.md identity rules]

## Verified external facts (GitLab webhooks)

Carried from the parent bundle (corroborated against official docs 2026-06-20)
and re-verified for this work. These are the facts the real adapter must encode:

- **Verification — signing token (preferred).** GitLab signs with a
  Standard-Webhooks signing token: the lowercase `webhook-signature` header
  carries `v1,{base64}`; the signature is **HMAC-SHA256 over the ASCII string
  `{webhook-id}.{webhook-timestamp}.{rawBody}`**. The configured token has the
  form `whsec_{base64}`; the HMAC **key is the base64-decode of the token with
  the `whsec_` prefix stripped** — using the token string verbatim as the key
  rejects every valid signature. Verify over the **raw bytes**, constant-time, no
  permissive fallback (exactly as the GitHub adapter does). The
  `webhook-signature` header may carry multiple space-separated values (key
  rotation); accept if any verifies. The legacy plaintext `X-Gitlab-Token` is
  weaker and **not recommended for new webhooks**.
- **Dedupe key** is the `webhook-id` header (stable across retries) — **not**
  `X-Gitlab-Event-UUID` (shared by recursive webhooks), and distinct from the
  webhook's own identity header `x-gitlab-webhook-uuid` (persisted as
  `delivery.hook_id`).
- **Event typing.** The `X-Gitlab-Event` header (`Note Hook`, `Merge Request
  Hook`, `Issue Hook`, `Push Hook`, `Pipeline Hook`, `Job Hook`, …) plus
  `object_kind` in the body; `object_kind` does **not** always match the header
  (e.g. `Job Hook` → `build`). **Work items** (Tasks/Incidents/Epics/OKRs) arrive
  on the `Issue Hook` with `object_kind: "work_item"` (not `"issue"`) and must be
  branched separately. A **Note Hook** must be disambiguated by `noteable_type`
  (Commit / MergeRequest / Issue / Snippet). A **Push** carries multiple commits,
  so it yields **0..n** events.
- **Reliability.** GitLab **retries** then auto-disables a webhook after **4**
  consecutive failures (temporary, 1 min → 24 h backoff) and **permanently**
  after **40**; operators must monitor this once the adapter ships. **Group**
  webhooks require a paid tier (per-project webhooks are free).
- **Reachability (self-managed).** A self-managed/internal GitLab (e.g.
  `gitlab.gamania.com` behind the company VPN) can deliver only if **the GitLab
  host has OUTBOUND reachability** to the public receiver URL — webhooks are
  server-initiated outbound POSTs, and GitLab blocks private/local targets by
  default, which a public receiver URL sidesteps.

## Decisions for this work

The parent bundle's Decisions 1–11 stand. The decisions specific to **adding the
GitLab source** are:

- **D-A — Rollout scope is the dominant fork.** `gitlab.com` **public** content
  carries no internal-content sensitivity; the **internal `gitlab.gamania.com`**
  instance does (private issue/MR/comment text). The two have very different
  preconditions. The plan implements the adapter once (it is host-agnostic
  code), but **stages rollout**: the public/code-only path can ship and be
  validated without the governance gate; enabling the **internal** instance is
  gated on Decision 11 + outbound reachability. *(Recommended default refined in
  the synthesis / Execution section.)*
- **D-B — Multi-host `source_id`.** Because GitLab spans multiple hosts mapping
  to distinct `gitlab:<host>` source ids, a single `/webhooks/gitlab` route with
  one fixed `sourceId` (the GitHub pattern) cannot tag both correctly. Resolve
  with one of: **(a)** per-host path segments + per-host secrets
  (`/webhooks/gitlab-com`, `/webhooks/gitlab-gamania`), each a `ProviderRoute`
  with its own fixed `sourceId`; or **(b)** derive the host per-delivery from the
  payload (`project.web_url`) and build `sourceId = "gitlab:" + host`, allowing a
  provider-supplied `source_id` (requires `AdaptCtx`/receiver to accept a
  per-delivery source id rather than a route-fixed one). The plan picks one in
  the wiring sprint; **(a)** is the smaller change and reuses the existing
  route-fixed model. *(Confirmed a real fork by the verification pass.)*
- **D-C — Decision 11 is a hard POLICY precondition for the internal instance.**
  Before the GitLab receiver is enabled for `gitlab.gamania.com`, confirm
  company policy permits mirroring internal issue/MR/comment **text** off the
  GitLab host onto the deployment host. This is a clearance decision, **not
  code**, and it blocks **rollout**, not the adapter implementation.
- **D-D — Private content makes the deferred redaction control a requirement.**
  Per the parent's Decision 10, a per-source/redaction control "becomes a
  requirement once private GitLab content is ingested." So the **internal**
  rollout additionally requires the previously-deferred UI redaction/collapse
  affordance and a decision on **per-source visibility filtering** on the SSE
  stream (which today serves all events to every tailnet client with no
  scoping). Not required for a `gitlab.com`-public-only rollout.
- **D-E — Signing token only; legacy `X-Gitlab-Token` not supported.** New
  webhooks use the signing token; the adapter implements signing-token
  verification only and does not add the weaker plaintext-token path, matching
  the parent's "no permissive fallback" stance. *(Revisit only if a target
  instance cannot issue a signing token.)*

## Scope

- Implement `GitlabWebhookProvider.verify()` (signing-token HMAC over raw bytes,
  constant-time, dual-secret rotation) and `toLiveEvents()` (event/`object_kind`
  → neutral `LiveEvent`, `work_item` branch, Note disambiguation, MR merge,
  Push → n events with per-commit ordinals), pure and replayable.
- Wire `GitlabWebhookProvider` into the receiver with the D-B multi-host design;
  add `WEBHOOK_GITLAB_*` secret env (by name) preserving least privilege; replace
  the no-wire test guard with a wired assertion.
- Recorded/synthetic GitLab payload fixtures + adapter/verifier/receiver tests.
- Deployment: confirm `/webhooks/gitlab*` rides the existing public webhook
  listener (no new public port); document GitLab-side webhook config and the
  self-managed outbound-reachability prerequisite; extend the `docs/DESIGN.md`
  trust-boundary note for GitLab.
- For the **internal** rollout only (staged): the UI redaction control + a
  per-source SSE visibility decision (D-D), and the Decision 11 clearance (D-C).

## Non-scope

- Any change to `contract.json`, the contract schema, `docs/CONTRACT.md`, the
  canonical `Store`, `store-conformance`, the Postgres gates, the sync engine, or
  the Activity tab. (The live store is a separate SQLite store — verified.)
- Provider write-back of any kind.
- Live receiver on the standalone macOS app (no public ingress, unchanged).
- Bidirectional messaging / WebSocket.
- Coupling webhook → canonical sync.

## Architecture (reuse)

The receiver, broadcaster, store, schema, snapshot/SSE endpoints, UI page, and
Docker `live` service all already exist and are provider-agnostic. Adding GitLab
is almost entirely **filling the existing `WebhookProvider` stub + one route
registration** — no new service, no new store, no new endpoint. The public
listener already dispatches `/webhooks/<segment>`; the tailnet reads listener and
nginx `/api/live*` location are unchanged.

## Security & verification

- Read the raw body as a `Buffer` and compute the HMAC over those exact bytes
  before any `JSON.parse` (reuse `readBodyBytes`); constant-time compare; reject
  on missing/malformed/mismatch; no permissive fallback.
- Secret(s) by env-var name only, via SOPS/age + the secrets overlay; never
  inlined, logged, or stored in `live.db`. Support dual-secret verification for
  rotation. Distinct secret per provider (and per host under D-B option (a)).
- Strip secret-bearing fields from `raw` before persist (as the GitHub adapter
  does). TTL prune unchanged.
- Isolation invariants (assert in tests, as for GitHub): the receiver cannot
  acquire the canonical writer lease, soft-delete, or mutate canonical data; the
  secret never lands in stored events or logs.

## Hard blockers (POLICY/INFRA vs CODE)

- **POLICY (internal only):** Decision 11 company clearance to mirror internal
  GitLab content off-host (D-C). Blocks internal rollout, not the code.
- **INFRA (internal only):** `gitlab.gamania.com` outbound reachability to the
  deploy host's public receiver URL (server-initiated POST; private targets
  blocked by default). The deployment host's company-VPN split-tunnel does
  **not** help — it routes the deployment host → company network, the opposite
  of the needed direction; this is a corporate-egress/firewall question that may
  be unsolvable. Must be probed (GitLab webhook **Test** / `curl` from the same
  egress path) before committing internal work; a failed probe is a hard
  go/no-go. May be the real internal-rollout blocker, independent of code.
- **CODE/UI (internal only):** the redaction control + per-source SSE visibility
  decision (D-D) become requirements once private content is ingested.
- None of the above block a **`gitlab.com`-public-only** adapter ship.

## Validation plan

- Backend gate (always): `pnpm run typecheck && pnpm test` — add `test/live-*`
  GitLab cases: pure verify() unit tests (valid signing-token / tampered body /
  wrong key / missing header / non-UTF-8 byte / dual-secret), adapter fixtures
  (Note/MR/Issue/work_item/Push/Pipeline), receiver integration
  (verify→dedupe→adapt→append→broadcast), replace the no-wire guard.
- UI gate (only if the redaction control lands): `pnpm --filter
  @symphony-board/ui run build` + UI tests + `smoke`.
- The live store is a **separate** SQLite store, so `test:pg-e2e`,
  `test:pg-compose`, and `store-conformance` are **NOT** required — state this in
  the PR.
- Fixtures are recorded/synthetic under `test/fixtures/`; no live provider calls
  (AGENTS.md).
- End-to-end (real GitLab webhook → deploy host) under `test/e2e/` or a deploy
  smoke, env-gated and self-skipping; never the default glob.

## Read-first references

- `docs/plans/2026-06-20-live-event-stream/` — the parent bundle
  (discussion-source Decisions 6/10/11 + verified GitLab facts; plan; execution
  state). The normative prior art for this work.
- `src/live/{gitlab.ts,github.ts,provider.ts,verify.ts,http-body.ts,receiver.ts,store.ts,types.ts,broadcaster.ts}`
  and `src/cli/live-receiver.ts` — the subsystem and the stub.
- `test/live-{gitlab,github,verify,receiver,store}.test.ts`,
  `test/no-nul-bytes.test.ts`, `test/fixtures/` — the test patterns + the
  no-wire guard.
- `src/sources/{gitlab.ts,registry.ts,types.ts}` — canonical `gitlab:<host>`
  source-id vocabulary (the D-B multi-host fork).
- `docker/{compose.yaml,compose.pg.yaml,docker-entrypoint.sh,ui-nginx.conf}`,
  `.env.example` — the `live` service + ingress.
- `docs/DESIGN.md` "Live Event Stream" + "Trust boundary" — the section to
  extend for GitLab.

## Execution

- Recommended plan: `docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-plan.md`
- Recommended execution state: `docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-execution-state.md`
- Status: ready for plan tracking
- The dependency-ordered sprint sequence is given in the plan document.
