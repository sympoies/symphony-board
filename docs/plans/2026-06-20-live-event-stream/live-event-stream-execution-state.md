# Realtime Live Event Stream Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: complete; tracking issue closed
- Target scope: a new independent realtime Live mechanism — dedicated
  append-only live-event store + neutral `live-event/1` record, a GitHub
  `WebhookProvider` adapter with raw-body HMAC verification, a least-privilege
  `live` receiver service serving `POST /webhooks/github` (public, publicly exposed) plus
  tailnet-only `GET /api/live` (SSE) / `/api/live-snapshot`, a contract-
  independent Live UI page with a Tauri polling fallback, the Docker `live`
  service + nginx `/api/live*` + private deployment host ingress wiring, a `docs/DESIGN.md`
  trust-boundary promotion, and a GitLab adapter interface stub.
- Execution window: Sprint 1 store + schema → Sprint 2 GitHub adapter + verifier
  (pure) → Sprint 3 receiver + SSE/snapshot → Sprint 4 Live UI page → Sprint 5
  deployment + DESIGN promotion → Sprint 6 GitLab adapter stub.
- Current task: none (pre-implementation).
- Next task: 1.1 — dedicated live-event store.
- Last updated: 2026-06-20
- Branch/commit/PR: sympoies/symphony-board#312 merged (https://github.com/sympoies/symphony-board/pull/312)
- Source document: `docs/plans/2026-06-20-live-event-stream/live-event-stream-discussion-source.md`
- Plan document: `docs/plans/2026-06-20-live-event-stream/live-event-stream-plan.md`
- Direct source-doc execution waiver: not applicable
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/305>
- Source snapshot: pending — posted by `create-plan-tracking-issue` at issue open.
- Plan snapshot: pending — posted by `create-plan-tracking-issue` at issue open.
- Initial state snapshot: pending — posted by `create-plan-tracking-issue` at
  issue open.

## Validation Plan

- Bundle:
  - `plan-tooling validate --file docs/plans/2026-06-20-live-event-stream/live-event-stream-plan.md --format text --explain`.
- Tracker open:
  - Dry-run `plan-issue record open --profile tracking`.
  - Live `plan-issue record open --profile tracking`.
  - Read-back and audit with `plan-issue record audit --profile tracking
    --expect-visible`.
- Code (always):
  - `pnpm run typecheck && pnpm test`.
- UI (Sprint 4):
  - `pnpm --filter @symphony-board/ui run build`.
  - `pnpm --filter @symphony-board/ui run test`.
  - `pnpm --filter @symphony-board/ui run smoke`.
- Shell / compose (Sprint 5):
  - `shellcheck` over `scripts/**/*.sh` and `docker/docker-entrypoint.sh`.
  - Compose config lint / local up smoke; nginx config test.
- Live store note:
  - The live-event store is a **separate** SQLite store, NOT the canonical
    `Store`, so `pnpm run test:pg-e2e` / `pnpm run test:pg-compose` and
    `store-conformance` do NOT apply for v1. State this in each PR.
- End-to-end:
  - Real org webhook → private deployment host receiver under `test/e2e/` or a deploy smoke,
    env-gated and self-skipping; never the default `pnpm test` glob.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Dedicated live-event store (`src/live/store.ts` + schema) | PR #307; test/live-store.test.ts (299 pass); test-first verified | Separate SQLite; unique `(source_id, event_id)`; monotonic `seq`; `since`/`recent`/`prune`. |
| 1.2 | done | Provider-neutral `LiveEvent` + `live-event/1` schema | PR #307; test/live-store.test.ts (299 pass); test-first verified | Independent of `packages/contract`; NUL-safe ids; 64-bit-safe numbers. |
| 1.3 | done | TTL / row-cap prune | PR #307; test/live-store.test.ts (299 pass); test-first verified | Default 30d; bounds the SSE replay backlog. |
| 2.1 | done | Raw-body reader + HMAC verifier (pure) | PR (sprint2); test/live-{verify,http-body,github}.test.ts (330 pass); test-first verified | `readBodyBytes` (Buffer); constant-time; no permissive fallback; dual-secret rotation. |
| 2.2 | done | `WebhookProvider` interface + GitHub adapter (pure) | PR (sprint2); test/live-{verify,http-body,github}.test.ts (330 pass); test-first verified | Event/action routing; ping; dedupe id; scrub secret fields from `raw`. |
| 3.1 | done | `live` receiver process + webhook intake | PR (sprint3); test/live-receiver.test.ts (341 pass); test-first verified | Least-privilege; verify→dedupe→adapt→append→broadcast; ack 202 <10s. |
| 3.2 | done | SSE broadcaster + snapshot + healthz | PR (sprint3); test/live-receiver.test.ts (341 pass); test-first verified | `text/event-stream`; `id:`/`seq`; `Last-Event-ID` replay; heartbeat; bounds. |
| 4.1 | done | `useLive` hook + `fetchLiveSnapshot` client | PR (sprint4); ui build+test(181)+smoke pass; test-first verified | EventSource (browser) vs polling (Tauri); capability probe. |
| 4.2 | done | `LivePage` component + nav/router wiring | PR (sprint4); ui build+test(181)+smoke pass; test-first verified | Early-return before contract gates; `page !== "live"` chrome guards; Decision 10 presentation. |
| 5.1 | done | Compose `live` service + entrypoint dispatch | PR (sprint5); shellcheck + compose config + live up --wait healthy under read_only | `SYNC_MODE=live`; loopback bind; no token/config/store mount; `.env.example`. |
| 5.2 | done | nginx `/api/live*` + private deployment host ingress + DESIGN promotion | PR (sprint5); shellcheck + compose config + live up --wait healthy under read_only | `proxy_buffering off`; public ingress path-scoped to `/webhooks`; trust-boundary note. |
| 6.1 | done | GitLab `WebhookProvider` interface stub | PR (sprint6); test/live-gitlab.test.ts (348 pass); test-first verified | Signing-token HMAC design; `webhook-id` dedupe; work_item branch; Decision 11 rollout gate; not wired. |
