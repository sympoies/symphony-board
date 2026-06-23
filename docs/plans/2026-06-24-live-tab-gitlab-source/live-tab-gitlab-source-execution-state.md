# GitLab source for the Live event stream — Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: not started; tracker open (#420) — pre-implementation.
- Target scope: implement the deferred GitLab source for the realtime Live event
  stream — a pure Standard-Webhooks signing-token verifier
  (`verifyGitlabSignature`), a pure `GitlabWebhookProvider.toLiveEvents` adapter
  (event/`object_kind` → neutral `LiveEvent`, `work_item` branch, Note
  disambiguation, MR merge, Push fan-out with `event_id == deliveryId` +
  receiver ordinals), receiver wiring via a per-host `gitlab-com` route
  (configured-secret-gated, `gitlab:gitlab.com`), recorded fixtures + tests, the
  in-repo deployment surface, and the `docs/DESIGN.md` trust-boundary promotion —
  all scoped to **gitlab.com public**. The internal `gitlab.gamania.com` rollout
  is staged behind Decision 11 clearance + outbound reachability + the deferred
  redaction/visibility controls.
- Execution window: Sprint 1 verifier → Sprint 2 adapter + fixtures → Sprint 3
  receiver wiring + guard inversion → Sprint 4 deployment surface + DESIGN
  promotion → Sprint 5 (DEFERRED, gated) internal instance.
- Current task: none (pre-implementation).
- Next task: 1.1 — `verifyGitlabSignature` (Standard-Webhooks HMAC over raw
  bytes).
- Last updated: 2026-06-24
- Branch/commit/PR: branch `docs/live-tab-gitlab-source-plan`; bundle commit
  `bb1371f7`; bundle-delivery PR pending.
- Source document: `docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-discussion-source.md`
- Plan document: `docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-plan.md`
- Direct source-doc execution waiver: not applicable.
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/420>
- Source snapshot: pending — posted by `create-plan-tracking-issue` at issue open.
- Plan snapshot: pending — posted by `create-plan-tracking-issue` at issue open.
- Initial state snapshot: pending — posted by `create-plan-tracking-issue` at
  issue open.

## Validation Plan

- Bundle:
  - `plan-tooling validate --file docs/plans/2026-06-24-live-tab-gitlab-source/live-tab-gitlab-source-plan.md --format text --explain`.
- Tracker open:
  - Dry-run `plan-issue record open --profile tracking`.
  - Live `plan-issue record open --profile tracking`.
  - Read-back and audit with `plan-issue record audit --profile tracking
    --expect-visible`.
- Test-first (the `test_first` gate is on globally):
  - Write/invert the GitLab tests to FAIL first, capture the failing-test
    evidence dir, then implement.
- Code (always):
  - `pnpm run typecheck && pnpm test`.
- UI (Sprint 5 redaction control only):
  - `pnpm --filter @symphony-board/ui run build`, UI tests, `smoke`.
- Shell / compose (Sprint 4 if the entrypoint is edited):
  - `shellcheck`; compose config lint.
- Not required (state as explicit waivers in each PR):
  - `pnpm run test:pg-e2e`, `pnpm run test:pg-compose`, and `store-conformance` —
    the live store is a separate SQLite store, not the canonical `Store`.
  - A `--dry-run` sync — gates `src/sources/*`, not the live receiver.
- End-to-end / internal instance:
  - The out-of-band outbound-reachability probe (GitLab webhook Test / `curl`
    from the corporate-egress path) is the go/no-go for the internal instance —
    an infra check, not a repo test.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | pending | `verifyGitlabSignature` — Standard-Webhooks HMAC over raw bytes (`src/live/verify.ts`, de-stub `gitlab.ts` verify) | — | base64-decode `whsec_` key (the #1 correctness gate); base64 digest + `v1,` scheme; ±5min window; dual-secret; multi-value sig; no permissive fallback. |
| 2.1 | pending | GitLab webhook fixtures (`test/fixtures/gitlab/`) | — | issue/MR-merge/note×3/push≥2/pipeline/build/work_item; 64-bit id; no literal NUL. |
| 2.2 | pending | `toLiveEvents` adapter (`src/live/gitlab.ts`) | — | switch on `X-Gitlab-Event` refined by `object_kind`; `work_item` branch; Note `noteable_type`; MR merge; Push → 1 row/commit, `event_id == deliveryId`; `gitlabTime()`; `toProviderNumber`; `scrubSecrets`; pure. |
| 3.1 | pending | Resolve GitLab config + register `gitlab-com` route (`src/cli/live-receiver.ts`) | — | per-host route (design (a)); `sourceId = prefix + host`; configured-secret registration policy; `receiver.ts` stays provider-agnostic. |
| 3.2 | pending | Invert wiring guards + receiver integration test (`test/live-gitlab.test.ts`, `test/live-receiver.test.ts`) | — | flip the no-wire guard to "IS wired"; fix the unknown-provider 404 test; signed `gitlab-com` delivery → dedupe/adapt/append/broadcast + Push ordinals. |
| 4.1 | pending | Compose env wiring + `.env.example` + entrypoint doc (`docker/compose*.yaml`, `.env.example`, `docker-entrypoint.sh`) | — | `WEBHOOK_GITLAB_COM_SECRET[_PREVIOUS]` via `environment:` interpolation (NOT `env_file`); no `ports:` change. |
| 4.2 | pending | `docs/DESIGN.md` trust-boundary promotion (`docs/DESIGN.md`, `README.md`) | — | GitLab as 2nd provider on the public listener; private-content caveat; auto-disable monitoring note. |
| 5.1 | pending | DEFERRED — Decision 11 company-content clearance (POLICY, not code) | — | hard gate for the internal instance; record permit/deny/conditional. |
| 5.2 | pending | DEFERRED — outbound reachability probe (INFRA, out-of-repo) | — | split-tunnel does not help (wrong direction); failed probe = hard no-go; provision SOPS secret + monitoring on success. |
| 5.3 | pending | DEFERRED — Decision-10 UI redaction/collapse control (CODE, after 5.1) | — | mandatory once private content is ingested. |
| 5.4 | pending | DEFERRED — per-source SSE visibility decision (CODE DECISION, after 5.1) | — | `broadcaster.ts` + store reads; `projectAllowlist` is ingest, not per-client authz. |
| 5.5 | pending | DEFERRED — register internal `gitlab-gamania` route (CODE, after 5.1 + 5.2) | — | `sourceId: gitlab:gitlab.gamania.com`; configured-secret-gated; per-host compose/env. |
