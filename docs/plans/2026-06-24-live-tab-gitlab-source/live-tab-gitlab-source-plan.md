# Plan: GitLab source for the Live event stream

## Overview

Turn the existing GitLab `WebhookProvider` **interface stub**
(`src/live/gitlab.ts`) into a working **GitLab source** for the realtime Live
event stream: implement signing-token signature verification and the
event-to-neutral-`LiveEvent` adapter (both pure), wire the provider into the
least-privilege `live` receiver with a per-host `source_id` design, expose the
GitLab webhook ingress on the existing public webhook listener, and stage the
governance/UI preconditions for ingesting **private** internal GitLab content.

This is a strict continuation of `docs/plans/2026-06-20-live-event-stream/`
(Decision 6 deferred GitLab to "interface only"). It reuses that feature's
receiver, broadcaster, store, schema, SSE/snapshot endpoints, Live UI page, and
Docker `live` service unchanged — the work is almost entirely **filling the
stub + one route registration**. It does **not** touch `contract.json`, the
contract schema, the canonical `Store`, `store-conformance`, the Postgres gates,
the sync engine, or the Activity tab (the live store is a separate SQLite store
with its own versioned `live-event/1` schema; the no-import isolation is enforced
by `test/live-store.test.ts`).

The adapter code is host-agnostic and ships once; **rollout is staged**. The
`gitlab.com`-**public** path (Sprints 1–4) carries no internal-content
sensitivity and ships behind the existing tailnet trust boundary. Enabling the
**internal `gitlab.gamania.com`** instance (Sprint 5) is gated on a company
content-clearance decision (Decision 11), self-managed outbound reachability,
and the previously-deferred redaction/visibility controls — none of which block
the public path.

## Read First

- Primary source: `docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: D-A rollout-scope default = ship
  gitlab.com-public first, defer internal (resolved here); D-B multi-host
  `source_id` = per-host routes (resolved in Sprint 3); D-C (company clearance)
  and the infra reachability prerequisite are external gates, not code.
- Also read: the parent bundle `docs/plans/2026-06-20-live-event-stream/`
  (Decisions 6/10/11 + verified GitLab facts); `src/live/{gitlab.ts,github.ts,provider.ts,verify.ts,http-body.ts,receiver.ts,store.ts,types.ts,broadcaster.ts}`,
  `src/cli/live-receiver.ts`; `test/live-{gitlab,github,verify,receiver,cli,store}.test.ts`,
  `test/no-nul-bytes.test.ts`, `test/fixtures/github/`;
  `src/sources/{gitlab.ts,registry.ts,types.ts}` and `config/sources.json` (the
  `gitlab:<host>` vocabulary); `docker/{compose.yaml,compose.pg.yaml,docker-entrypoint.sh,ui-nginx.conf}`,
  `.env.example`; `docs/DESIGN.md` "Live Event Stream" + "Trust boundary".

## Scope

- In scope: a pure GitLab signing-token verifier; the pure
  `GitlabWebhookProvider.toLiveEvents` adapter; receiver wiring with a per-host
  `source_id` design and `WEBHOOK_GITLAB_*` secrets (by env-var name);
  inverting the no-wire test guard to a wired assertion; recorded/synthetic
  GitLab fixtures + adapter/verifier/receiver/config tests; in-repo deployment
  surface (compose env interpolation, `.env.example`, entrypoint doc) and the
  `docs/DESIGN.md` trust-boundary extension — all scoped to `gitlab:gitlab.com`.
  For the **internal** instance only (staged, gated): the Decision-10 UI
  redaction control, a per-source SSE visibility decision, and the
  `gitlab.gamania.com` route/secret.
- Out of scope: any change to `contract.json`, the contract schema,
  `docs/CONTRACT.md`, the canonical `Store`, `store-conformance`, the Postgres
  gates, the sync engine, or the Activity tab; provider write-back; a Live
  receiver on the standalone macOS app; the legacy plaintext `X-Gitlab-Token`
  verification path (D-E: signing token only); coupling webhook → canonical
  sync; WebSocket / bidirectional messaging.

## Assumptions

1. The live store stays a separate SQLite store; `test:pg-e2e`,
   `test:pg-compose`, and `store-conformance` do **not** apply — state this in
   each PR.
2. Target webhooks use the GitLab signing token (`whsec_`-prefixed,
   Standard-Webhooks); no instance in scope requires the legacy plaintext token.
3. The public webhook listener already path-scopes `/webhooks/*`, so adding the
   `gitlab-com` route needs **no** new public port and **no** nginx change —
   only the receiver's secret env and GitLab-side webhook configuration.
4. A route is registered **only when its secret is configured** ("configured-
   secret registration policy"), so an unset host adds no public endpoint and no
   request ever reaches a not-yet-implemented adapter.
5. Sprints 1–4 (the `gitlab.com`-public path) ship independently of the internal
   gate; Sprint 5 (internal `gitlab.gamania.com`) is blocked until D-C clearance
   and outbound reachability are confirmed externally.
6. GitLab fixtures are recorded/synthetic under `test/fixtures/gitlab/`; no live
   provider calls in automated tests (AGENTS.md). The `test_first` gate is on
   globally, so write/invert the GitLab tests to FAIL first, then implement.

---

## Sprint 1: GitLab signing-token verifier (pure, no IO)

**Goal**: verified-only ingestion for GitLab exists as a pure, replayable
function mirroring the GitHub verifier, with failing-test-first evidence.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`.
- Verify: a tampered body, an undecoded (`whsec_`-verbatim) key, wrong/missing/
  malformed `webhook-signature`, a missing `webhook-id`/`webhook-timestamp`, and
  a timestamp outside the tolerance window each reject; a valid signing-token
  delivery verifies; a delivery signed with the previous secret verifies during
  rotation; one valid value among multiple space-separated signatures accepts.

### Task 1.1: `verifyGitlabSignature` — Standard-Webhooks HMAC over raw bytes

- **Location**:
  - `src/live/verify.ts`
  - `src/live/gitlab.ts`
- **Description**: add an exported pure `verifyGitlabSignature(rawBody, headers,
  secrets)` beside the untouched `verifyGithubSignature`. Read lowercase headers
  `webhook-signature` (`v1,{base64}`, possibly multiple space-separated values),
  `webhook-id`, `webhook-timestamp`. Validate the timestamp (parse Unix seconds;
  reject non-numeric as `bad_format`; reject outside a ±5 min window — make
  `now` injectable — as a new `expired` reason). Build the signed content as the
  exact string `{webhook-id}.{webhook-timestamp}.{rawBody}` over the **raw
  bytes** (verify pre-`JSON.parse`, as the receiver already does). For each
  configured token: require the `whsec_` prefix, strip it, and **base64-decode**
  the remainder to the raw HMAC key (skip tokens lacking the prefix; hard-reject
  if zero usable keys). Compute `HMAC-SHA256(...).digest("base64")` — note GitLab
  uses a **base64** digest and a `v1,` scheme, unlike GitHub's **hex** digest +
  `sha256=` over body-only. Strip the `v1,` scheme from each candidate; length-
  check then `crypto.timingSafeEqual` across the full secret × candidate cross-
  product with **no early return** (the GitHub anti-timing-leak pattern). Return
  `{ ok: true }` on any match, else `{ ok: false, reason }`. Extend the
  `VerifyResult` reason union (the receiver reads only `.ok`, so widening is
  safe). De-stub `GitlabWebhookProvider.verify()` to delegate; keep
  `deliveryId`/`isControlEvent`/`hookIdHeaderName` as-is, and keep the
  `whsec_`/`webhook-signature`/`Decision 11` substrings the source-scan test
  asserts.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - A valid signing-token delivery verifies; a one-byte body mutation rejects.
  - The `whsec_` key is base64-decoded: a verbatim-key implementation fails a
    dedicated fixture; the correct decode accepts (pinned against a hand-computed
    known-good vector so a shared sign/verify bug cannot pass).
  - Missing/malformed `webhook-signature`, missing `webhook-id`/`webhook-
    timestamp`, a wrong secret, and a stale timestamp each reject; zero
    configured secrets is a hard reject.
  - Dual-secret rotation verifies a previous-secret delivery; one valid value
    among multiple space-separated signatures accepts; non-UTF-8 raw bytes are
    safe.
- **Validation**:
  - `pnpm run typecheck && pnpm test` — add GitLab cases to `test/live-verify.test.ts`
    (or a sibling `test/live-verify-gitlab.test.ts`), pure unit tests modeled on
    the GitHub block. Update the `test/live-gitlab.test.ts` test that asserts
    `verify()` throws not-implemented.

---

## Sprint 2: GitLab event adapter (pure)

**Goal**: a complete pure `GitlabWebhookProvider.toLiveEvents` mirroring
`github.ts`, fixture-driven, landable and testable before wiring. Structural
rule: **`event_id == ctx.deliveryId` on every emitted row** — the receiver
supplies the per-row ordinal (dedupe is `(source_id, event_id, ordinal)`).

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`.
- Verify: each supported `(X-Gitlab-Event, object_kind, action)` yields the
  expected neutral record; a `work_item` Issue Hook is categorized distinctly
  from a plain issue; a Note is categorized by `noteable_type`; an MR merge is a
  merge; a Push yields one row per commit, all sharing `event_id == deliveryId`;
  unknown kinds return `[]`.

### Task 2.1: Author GitLab webhook fixtures

- **Location**:
  - `test/fixtures/gitlab`
- **Description**: author synthetic + redacted GitLab webhook payload fixtures
  (no live calls per AGENTS.md): `issue.opened`, `merge_request.merged`,
  `note.on_mr`, `note.on_issue`, `note.on_commit`, `push` (≥2 commits),
  `pipeline`, `build` (Job Hook → `object_kind: "build"`), `work_item`. Include
  one iid/id > 2^53 (64-bit boundary) and one field exercising the NUL guard;
  fixtures must contain **no** literal `0x00` byte (`test/no-nul-bytes.test.ts`
  runs over all tracked files).
- **Dependencies**:
  - none
- **Complexity**: 3
- **Acceptance criteria**:
  - Fixtures cover every category branch the adapter handles, including the
    `work_item` and Job-Hook edge cases and a 64-bit-boundary id.
  - `test/no-nul-bytes.test.ts` passes over the new fixtures.
- **Validation**:
  - `pnpm run typecheck && pnpm test`.

### Task 2.2: Implement `toLiveEvents` + actor/target/body extraction

- **Location**:
  - `src/live/gitlab.ts`
- **Description**: implement the pure adapter mirroring `src/live/github.ts`.
  Add the missing `scrubSecrets` import. Switch on `ctx.eventHeader`
  (`X-Gitlab-Event`), refined by `object_kind` / `object_attributes`: `Note
  Hook` → comment, disambiguated by `noteable_type` (MergeRequest with
  `object_attributes.position` → `review_comment`, else `comment`; Issue →
  comment; Commit → comment; Snippet → `[]`); `Merge Request Hook` →
  `change_request` (merge via `action == "merge"` / `state == "merged"`); `Issue
  Hook` → `issue`, **with `object_kind == "work_item"` branched to a distinct
  category**; `Push Hook` → `push`; `Pipeline Hook` → `pipeline`; `Job Hook`
  (`object_kind: "build"`) → pipeline/job. Extract actor (`user`), target
  (`project.path_with_namespace`, iid/number via `toProviderNumber` for 64-bit
  safety, `url`, title), `body`, and `occurred_at` **normalized through a new
  `gitlabTime()`** (GitLab emits space-separated `YYYY-MM-DD HH:MM:SS ±ZZZZ`, not
  ISO-8601). A Push emits **one row per `commits[]` entry**, every row with
  `event_id == ctx.deliveryId` (the receiver assigns ordinals by array index);
  slice `raw.commits` parallel by index so each row carries only its own commit;
  a branch-delete or tag push carries no commits and yields `[]`. Unknown
  events/actions return `[]`. `raw = scrubSecrets(payload)`. No IO; pure.
- **Dependencies**:
  - Task 1.1
  - Task 2.1
- **Complexity**: 6
- **Acceptance criteria**:
  - Each supported `(event, object_kind, action)` produces the expected neutral
    record; a `work_item` Issue Hook is not categorized as a plain issue; a Job
    Hook (`object_kind: "build"`) routes correctly despite the header/kind
    mismatch.
  - A Note on an MR with a position is `review_comment`; on an issue/commit it is
    `comment`; on a snippet it is `[]`. An MR merge is a merge.
  - A Push with N commits yields N rows, **all sharing `event_id ==
    deliveryId`**, each carrying only its own scrubbed commit; a branch-delete /
    tag push yields `[]`.
  - `occurred_at` is ISO-normalized; 64-bit ids round-trip via `toProviderNumber`;
    `raw` is scrubbed; the adapter is pure (repeated-call equality, input not
    mutated).
- **Validation**:
  - `pnpm run typecheck && pnpm test` — adapter acceptance tests in
    `test/live-gitlab.test.ts` driven by the Task 2.1 fixtures, mirroring
    `test/live-github.test.ts`.

---

## Sprint 3: Receiver wiring + per-host `source_id` (gitlab.com only)

**Goal**: register one `/webhooks/gitlab-com` `ProviderRoute` with a fixed
`source_id` and host-specific secret, using design (a) per-host routes (zero
receiver-contract change), and invert the no-wire guards. Land together with
Sprints 1–2 so no traffic reaches a throwing adapter.

**Demo/Validation**:

- Command(s): `pnpm run typecheck && pnpm test`.
- Verify: a signed GitLab delivery to `/webhooks/gitlab-com` verifies, dedupes
  on `webhook-id`, adapts, appends, and broadcasts; the receiver still holds no
  canonical store / token / config; the no-wire guard is replaced by a wired
  assertion; an unset host registers no route.

### Task 3.1: Resolve GitLab config + register the `gitlab-com` route (D-B)

- **Location**:
  - `src/cli/live-receiver.ts`
- **Description**: extend `LiveConfig` + `resolveLiveConfig` to read
  `WEBHOOK_GITLAB_COM_SECRET` (+ `..._PREVIOUS`) via the existing `nonEmpty(...)`
  merge with the analogous empty-secret warning. When configured, append a
  `ProviderRoute { pathSegment: "gitlab-com", provider: new
  GitlabWebhookProvider(), sourceId: GITLAB_SOURCE_ID_PREFIX + "gitlab.com",
  secrets }` — derive `sourceId` from the prefix constant + host so it byte-
  matches `config/sources.json` (a drift here orphans events in the UI source
  filter). Apply the configured-secret registration policy: an unset host adds
  no route, hence no public endpoint and no throwing-adapter exposure. Keep
  `src/live/receiver.ts` provider-agnostic (no GitLab-specific code). The
  payload-derived-host alternative (provider-supplied `source_id`, requiring an
  `AdaptCtx`/receiver change) is documented as the fallback if a single shared
  GitLab endpoint is ever required.
- **Dependencies**:
  - Task 1.1
  - Task 2.2
- **Complexity**: 4
- **Acceptance criteria**:
  - With the secret set, a `gitlab-com` route exists tagging events
    `gitlab:gitlab.com`; with it unset, no route is registered.
  - Adding/removing a host is env-driven, not a code change; `receiver.ts` stays
    provider-agnostic.
  - The `sourceId` form is asserted to match the `gitlab:<host>` vocabulary.
- **Validation**:
  - `pnpm run typecheck && pnpm test` (extend `test/live-cli.test.ts`:
    secret-rotation merge, empty-secret warning, route built when configured /
    absent when not).

### Task 3.2: Invert the wiring guards + receiver integration test

- **Location**:
  - `test/live-gitlab.test.ts`
  - `test/live-receiver.test.ts`
- **Description**: **replace** the `test/live-gitlab.test.ts` "stub is NOT wired"
  assertion (the source-scan greppping both files for
  `/GitlabWebhookProvider|gitlab\.ts/`) with a positive assertion that the GitLab
  provider **is** wired — `src/cli/live-receiver.ts` must match while
  `src/live/receiver.ts` must still **not** (the provider-agnostic split) — and
  update the framing comment. Update the unknown-provider 404 test
  (`test/live-receiver.test.ts:411`, currently POSTs `/webhooks/gitlab`) to a
  still-unknown segment so it keeps asserting `unknown_provider`. Add a GitLab
  receiver integration test: POST a signed delivery to `/webhooks/gitlab-com`
  (`x-gitlab-event` + `webhook-id` + `webhook-signature`) and assert verify →
  dedupe (on `webhook-id`) → adapt → append (202, stored once) → SSE broadcast;
  a redelivery (same `webhook-id`) is a no-op and not rebroadcast; a bad
  signature → 401 stores nothing; a multi-commit Push delivery asserts per-commit
  ordinals/seqs with the shared `event_id`. Add a `gitlabDelivery()` signing
  helper.
- **Dependencies**:
  - Task 3.1
- **Complexity**: 4
- **Acceptance criteria**:
  - The inverted guard fails if the GitLab route is ever removed, and still
    asserts `receiver.ts` is provider-agnostic.
  - The integration test exercises the full verify→dedupe→adapt→append→broadcast
    path, redelivery no-op, bad-signature reject, and Push ordinals.
  - The receiver opens no canonical store, reads no provider token, and the
    secret never appears in stored events or logs (assert).
- **Validation**:
  - `pnpm run typecheck && pnpm test`.

---

## Sprint 4: In-repo deployment surface + DESIGN promotion (gitlab.com only)

**Goal**: make the new secret reachable in the `live` container and document the
route. **No new public port and no nginx change** — `/webhooks/gitlab-com`
shares the existing dedicated webhook listener.

**Demo/Validation**:

- Command(s): compose config lint; `shellcheck` on the entrypoint if edited; a
  manual signed `curl` to `/webhooks/gitlab-com`.
- Verify: `/webhooks/gitlab-com` is served by the public webhook listener and
  reachable through the existing ingress; `/api/live*` stays tailnet-only; the
  GitLab webhook config + reachability prerequisite are documented.

### Task 4.1: Compose env wiring + `.env.example` + entrypoint doc

- **Location**:
  - `docker/compose.yaml`
  - `docker/compose.pg.yaml`
  - `.env.example`
  - `docker/docker-entrypoint.sh`
- **Description**: add `WEBHOOK_GITLAB_COM_SECRET` / `..._PREVIOUS` to the `live`
  service in **both** compose files via `environment:` interpolation — **never
  `env_file`**, which would pull `GITLAB_TOKEN` into the no-token `live`
  container and break least privilege (GitHub is already wired this way). **No
  `ports:` change.** Document the env in `.env.example` (names only; note the
  `whsec_` Standard-Webhooks token, the `/webhooks/gitlab-com` route, and the
  interpolation-not-`env_file` rule) and extend the entrypoint's Live-mode env
  doc comment.
- **Dependencies**:
  - Task 3.2
- **Complexity**: 2
- **Acceptance criteria**:
  - Both compose `live` services thread `WEBHOOK_GITLAB_COM_*` via
    `environment:` interpolation; no `env_file`; no `ports:` change.
  - `.env.example` documents the env by name with the interpolation rule.
- **Validation**:
  - `shellcheck` if the entrypoint is edited; compose config lint.

### Task 4.2: `docs/DESIGN.md` trust-boundary promotion

- **Location**:
  - `docs/DESIGN.md`
  - `README.md`
- **Description**: update the "Trust boundary", adapter-interface, and
  Live-coverage sections to promote GitLab from "stubbed" to
  "enabled-for-gitlab.com-public on the SAME public listener/port (no new
  surface)". Record that the **internal** instance stays gated on Decision 11 +
  outbound reachability, and the GitLab webhook **auto-disable** monitoring
  obligation (temporary after 4 consecutive failures, permanent after 40). The
  README webhook-listener line is cosmetic (lowest priority).
- **Dependencies**:
  - Task 4.1
- **Complexity**: 2
- **Acceptance criteria**:
  - `docs/DESIGN.md` records GitLab as a second provider on the public webhook
    listener, the private-content caveat, and the auto-disable monitoring note.
- **Validation**:
  - `git diff --check`; docs read-through.

---

## Sprint 5: DEFERRED / ROLLOUT-GATED — internal `gitlab.gamania.com`

**Goal**: enable the internal instance **only after** the POLICY clearance and
the INFRA reachability prerequisite are independently satisfied. The adapter
code is already done in Sprints 1–3; this sprint is governance + the two
deferred code controls the clearance makes mandatory. **Do not start the code
tasks until the gates clear.**

**Demo/Validation**:

- Command(s): `pnpm --filter @symphony-board/ui run build` + UI tests + `smoke`
  (redaction control); `pnpm run typecheck && pnpm test` (per-source filtering /
  internal route).
- Verify: the clearance + reachability are recorded; the Live page can
  collapse/redact private bodies; if adopted, the SSE stream scopes by source;
  the internal route is registered and tagged `gitlab:gitlab.gamania.com`.

### Task 5.1: Decision 11 company-content clearance (POLICY — not code)

- **Location**:
  - `docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-execution-state.md`
  - `docs/DESIGN.md`
- **Description**: obtain documented Gamania clearance to mirror internal
  `gitlab.gamania.com` issue/MR/comment/commit **text** + raw payloads off the
  GitLab host onto the deploy host (persisted ~30 d in `live.db`, streamed
  plaintext over the unauthenticated tailnet-only SSE fan-out). **Hard gate** —
  no internal route may be registered until this is granted in writing. Record
  the outcome (permit / deny / conditional, plus any required visibility
  constraints) in the execution state and `docs/DESIGN.md`.
- **Dependencies**:
  - Task 4.2
- **Complexity**: 2
- **Acceptance criteria**:
  - A recorded clearance decision and any conditions, or an explicit "internal
    rollout deferred" note. No code gate.
- **Validation**:
  - Documentation only.

### Task 5.2: Outbound reachability probe (INFRA — not code, out-of-repo)

- **Location**:
  - `docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-execution-state.md`
  - the deployment infra repo (out of this repo)
- **Description**: probe whether `gitlab.gamania.com` can make an **outbound**
  POST to the public `https://<deploy-host>.<tailnet>.ts.net:<port>/webhooks/gitlab-gamania`
  URL (GitLab webhook **Test** button / `curl` from the same corporate-egress
  path). Note the deployment host's company-VPN split-tunnel does **not** help —
  it routes the deployment host → company network, the opposite of the needed
  direction; this is a corporate-egress/firewall question that may be
  unsolvable. A failed probe is a hard go/no-go. On success, provision
  `WEBHOOK_GITLAB_GAMANIA_SECRET` into the SOPS/age store and add auto-disable
  monitoring + a re-enable runbook.
- **Dependencies**:
  - Task 4.2
- **Complexity**: 4
- **Acceptance criteria**:
  - A recorded reachability verdict (reachable / not) and, if reachable, the
    provisioned secret + monitoring note.
- **Validation**:
  - Out-of-band infra probe; not a repo test.

### Task 5.3: Decision-10 UI redaction/collapse control (CODE — after 5.1)

- **Location**:
  - `packages/ui/src/components/LivePage.tsx`
  - `packages/ui/src/useLive.ts`
- **Description**: ship the previously-deferred redaction/collapse toggle on the
  Live page — **mandatory** once private content is ingested (parent Decision 10:
  "becomes a requirement"). Default-collapse bodies for flagged/private sources
  with an expand affordance so full bodies are not exposed inline without a
  control.
- **Dependencies**:
  - Task 5.1
- **Complexity**: 5
- **Acceptance criteria**:
  - The Live page can collapse/redact body content for private sources by
    default.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run build` + UI tests + `smoke`.

### Task 5.4: Per-source SSE visibility decision (CODE DECISION — after 5.1)

- **Location**:
  - `src/live/broadcaster.ts`
  - `src/live/store.ts`
- **Description**: per Decision 11 ("decide whether ... is then required"),
  assess and, if required, implement per-source / per-client visibility filtering
  on the SSE fan-out — thread an allowed-source set onto `Subscriber`, filter in
  `send()`/`broadcast()`, and source-scope the store reads `since()` / `recent()`
  / `sinceDesc()`. Note the existing ingest `projectAllowlist` is an **ingest**
  filter, **not** per-client authz, and does not satisfy this. If deferred,
  record the explicit reliance on the tailnet boundary and the residual risk.
- **Dependencies**:
  - Task 5.1
- **Complexity**: 6
- **Acceptance criteria**:
  - The per-source visibility decision is implemented (stream/snapshot scope by
    source) or explicitly recorded with its residual risk.
- **Validation**:
  - `pnpm run typecheck && pnpm test` for any backend filtering.

### Task 5.5: Register the internal route (CODE — after 5.1 + 5.2)

- **Location**:
  - `src/cli/live-receiver.ts`
  - `docker/compose.yaml`
  - `docker/compose.pg.yaml`
  - `.env.example`
- **Description**: register the `/webhooks/gitlab-gamania` `ProviderRoute` with
  `sourceId: "gitlab:gitlab.gamania.com"` (byte-matching `config/sources.json`)
  and its own configured-secret-gated secret, mirroring the Sprint 3 + Sprint 4
  per-host wiring. Only after 5.1 (clearance) and 5.2 (reachable).
- **Dependencies**:
  - Task 5.1
  - Task 5.2
- **Complexity**: 3
- **Acceptance criteria**:
  - The internal route is registered only when its secret is configured and tags
    events `gitlab:gitlab.gamania.com`.
- **Validation**:
  - `pnpm run typecheck && pnpm test`.

---

## Cross-cutting acceptance (whole feature)

- `contract.json`, the contract schema (`packages/contract`, `docs/CONTRACT.md`),
  the canonical `Store`, the sync engine, and the Activity tab are unchanged.
- The receiver stays least-privilege (no canonical store / token / config);
  tests assert it cannot acquire the canonical writer lease, soft-delete, or
  mutate canonical data, and the webhook secret never lands in stored events or
  logs.
- GitLab verification is signing-token, raw-bytes, base64-digest + `v1,` scheme,
  constant-time, no permissive fallback; dual-secret rotation supported.
- Every emitted row carries `event_id == ctx.deliveryId`; multi-commit pushes
  rely on the receiver-supplied ordinal for `(source_id, event_id, ordinal)`
  uniqueness.
- The public surface stays only `POST /webhooks/*`; SSE/snapshot remain
  tailnet-only; no new public port.
- The standalone macOS app is unchanged (Live receiver still absent/disabled).
- The internal `gitlab.gamania.com` instance is enabled only after D-C
  clearance, confirmed outbound reachability, and the D-D redaction/visibility
  controls.

## Validation summary

- Test-first discipline (the `test_first` gate is on globally): write/invert the
  GitLab tests to FAIL first (adapter throws; `verifyGitlabSignature` undefined;
  receiver 404s on the segment), capture the failing-test evidence dir, then
  implement.
- Always: `pnpm run typecheck && pnpm test` (covers the new verifier, adapter,
  receiver-integration, and `live-cli` config tests; `no-nul-bytes` runs over the
  new fixtures automatically).
- UI (Sprint 5 redaction control only): `pnpm --filter @symphony-board/ui run
  build` + UI tests + `smoke`. **Not** required for the public code Sprints 1–4
  (no UI/contract/view-model touch) — state this waiver in the PR.
- **Not required** (state as explicit waivers): `test:pg-e2e`, `test:pg-compose`,
  and `store-conformance` (they gate the canonical `Store` seam, untouched here —
  the live store is a separate SQLite DB); a `--dry-run` sync (gates
  `src/sources/*`, not the live receiver).
- Shell/compose (Sprint 4): `shellcheck` if the entrypoint is edited; compose
  config lint.
- Pin the Standard-Webhooks signature against a hand-computed known-good vector
  in addition to round-trip sign/verify, so a shared bug in the test `sign()`
  helper and the verifier cannot pass together.
- Fixtures are recorded/synthetic under `test/fixtures/gitlab/`; no live provider
  calls.
- Internal instance (Sprint 5): the out-of-band reachability probe is the
  go/no-go validation — an infra check, not a repo test.
