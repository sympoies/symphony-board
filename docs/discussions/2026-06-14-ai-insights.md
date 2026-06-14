# AI Progress Insights for symphony-board — Implementation Handoff

- **Status:** Captured idea. Not scheduled, not implementing now.
- **Date:** 2026-06-14
- **Source:** In-session design discussion (product fit, UI placement, model/cost).
- **Intended next step:** Drive the open decisions through the linked follow-up
  issue. Graduate to an L2 plan only when a build is actually scheduled.

## Purpose

Capture the converged thinking on adding AI "project-progress summarization" to
symphony-board so a later session can pick it up without re-litigating the
settled parts. The open *decisions* (model per mode, data residency, exact UI
entry points, v1 insight scope) live in the follow-up issue, not here.

## Confirmed facts (about the current product)

- symphony-board is a provider-agnostic work-item aggregator: GitHub/GitLab →
  canonical store (SQLite default, Postgres opt-in) → versioned JSON contract
  (currently major v3, emitted `3.3.0`) → a **read-only-toward-providers** UI.
  See `docs/DESIGN.md`.
- Three separated layers: `raw store → canonical DB → versioned contract`.
  `normalize` and `buildContract` are **pure** (no network/IO); network lives in
  `src/sources/*`, DB IO in `src/db/*`, orchestration in the sync runner/daemon.
  See `AGENTS.md` Boundaries.
- The UI never writes issues/labels/PRs back to providers. It does have two
  **capability-split control planes** — sync-control and config-control — that
  share one pattern: writer-owned, gated by an env flag **plus** a same-origin
  custom header (`X-Symphony-Sync-Control`), served by the writer (Docker
  `board` daemon / standalone `app-server`) and **never** the read-only `api`/
  `web` sidecars; standalone defaults them ON, Docker OFF. See `docs/DESIGN.md`
  → UI-Triggered Sync Control Plane / Writer-Owned Config Control Plane.
- UI pages today: Board (status columns + cross-cut "Spotlight" lanes:
  Follow-up / Plan-tracking / PR), Graph, Activity, Commits, Repo Analytics,
  Settings, plus a hidden Diagnostics page. Note: "Spotlight" here is a
  Board-lane concept, **not** a ⌘K command palette.
- Tokens/secrets are referenced by env-var **name** and read from the
  environment, never inlined or committed; secrets are write-only across the
  control surface. See `AGENTS.md` / `docs/DESIGN.md`.
- Contract versioning: additive optional/nullable fields are a **minor** bump;
  removing/renaming/repurposing is **major**. See `docs/CONTRACT.md`.

## Decisions (adopted direction from this discussion)

1. **AI is a read/insight lens, never a writer.** Every AI feature consumes the
   canonical data and produces summaries/signals/answers. It must not write back
   to providers — that stays an explicit non-goal and preserves the product's
   read-only-toward-providers identity. (A write/agent surface would be a
   different product, closer to the predecessor that wrote into GitHub Projects.)
2. **Two complementary modes, both wanted — neither replaces the other:**
   - **Mode A — precomputed insights baked into the contract.** Generated at
     emit time (digests, weekly synthesis, risk/stale signals, suggested
     grouping). The read-only UI renders them like any other contract field.
   - **Mode B — interactive Q&A over the board.** Natural-language questions
     answered with a live model call ("what's blocked this week?", "who is
     overloaded?").
3. **Model leaning: the cheap tier, not a frontier model.** The task is
   summarization/synthesis over structured records — light work. Current
   candidates to evaluate/use are **`gpt-5.4-mini`** and **`Claude Haiku 4.5`**.
   Explicitly *not* Opus / GPT-5-class / Gemini-Pro.
4. **Cost is not the blocker; data residency and quality are.** At the cheap
   tier, with prompt caching (the contract is a stable prefix) and batch for
   Mode A, the spend is cents/month for a personal/small-team board. The real
   decision driver is whether internal work items may be sent to a cloud LLM.

## Scope

- Mode A and Mode B as defined above, generating insights over the existing
  canonical/contract data.

## Non-scope

- Provider write-back of any kind (unchanged non-goal).
- New provider kinds; splitting UI/contract into separate repos.
- Any implementation or L2 plan right now. This is idea capture.

## Implementation boundaries (repo-faithful "how", for the later build)

- **Mode A enrichment runs in the emit/daemon orchestration path, never in the
  pure layers.** The model call is network, so it cannot live in `normalize` or
  `buildContract`; it belongs in a new emit-time enrichment stage the writer
  daemon orchestrates. Output is folded into the contract as **additive optional
  fields → minor version bump** per `docs/CONTRACT.md`. Make it **diff-aware**:
  re-summarize only what changed since the **previous emitted contract snapshot**
  (keyed on per-item `updated_at` / `last_seen_at` or a per-item content hash),
  so a run does not re-pay for the whole board. Do **not** key the diff on
  `contract_version` — that is the schema semver, manually bumped only on schema
  changes (`docs/CONTRACT.md`), so it stays constant across ordinary emits and
  keying on it would leave summaries stale until the next schema bump.
- **Range responses need an explicit enrichment rule.** Mode A enrichment is
  emit-path only, but custom time ranges are served by `GET /api/range` — a
  read-only projection built on demand by the read-only `api` sidecar **outside**
  the daemon emit (`docs/CONTRACT.md` → Range Query). Pick one and state it: AI
  fields are emit-path-only and the UI **suppresses/labels them as unavailable**
  on range responses, **or** a cached/range-aware enrichment serves range-scoped
  fields without the read-only sidecar making a model call. A range response must
  **never** silently reuse full-board summaries for a narrow window.
- **Mode B follows the existing control-plane precedent.** Add it as a third
  **writer-owned, capability-split AI control plane** — same env-flag + same-
  origin-header gating as sync/config control, served by the writer
  (`board` daemon / standalone `app-server`), **never** the read-only `api`/`web`
  sidecars. This keeps the read-only sidecar discipline intact. **Unlike
  sync/config control, the AI capability defaults OFF on every deployment**
  (standalone included) until an AI provider and data-residency policy are
  explicitly configured: the sync/config ON-by-default is for same-user *local
  writer* actions, whereas an AI plane can egress internal board data to a
  third-party cloud model (see Risks → Data residency).
- **API key handling matches the existing secret rule.** Keyed by env-var
  *name*, read from the environment, never inlined or committed, never shipped in
  the renderer / Tauri JS bundle. The model call happens server-side (daemon for
  A, writer/app-server for B).
- **Prompt caching:** treat the contract/board snapshot as the stable cached
  prefix for both modes to land cheap-tier cached-input pricing.

## Requirements (light)

- **A:** an emit-time enrichment stage producing contract insight fields
  (batchable, diff-aware); a UI surface to render them.
- **B:** a writer-owned control-plane endpoint that answers NL queries over the
  current store/contract; a UI "ask" surface.

## Acceptance criteria (for the eventual build)

- read-only-toward-providers invariant preserved; no API key in any client
  bundle.
- Mode A contract change done via the `docs/CONTRACT.md` flow (schema + types +
  version bump + tests) as a minor bump.
- Both modes sit behind capability flags, consistent with sync/config control.
- AI-derived content is clearly labeled as AI output and toggleable; never
  presented as provider truth.
- Per-run cost stays in the cheap tier (cheap-tier model + caching + batch).

## Validation plan (for the eventual build)

- Contract change → backend + UI + contract-validation gates per
  `DEVELOPMENT.md` (`pnpm run typecheck`, `pnpm test`, UI build/test/smoke,
  `pnpm run emit`/`validate`).
- Control-plane addition → mirror the sync-control safety model (env flag +
  same-origin custom header). For the AI plane the gate keys on **any route that
  triggers a model call or returns AI output**, not just mutations — only pure
  availability/capability probes stay ungated. A Mode B answer endpoint spends
  the server-side key and egresses board data even on a `GET`, so it must not be
  treated as a harmless read-only route.

## Risks and guardrails

- **Data residency.** The leaning candidates (`gpt-5.4-mini`, `Claude Haiku
  4.5`) are US-hosted cloud APIs; internal/company work items (incl. GitLab,
  potentially self-hosted) would leave the machine. Confirm no-training /
  retention terms before shipping. A local model (e.g. Ollama on the writer
  host) is the deferred privacy alternative if policy forbids cloud.
- **Layer purity.** Keep the AI call out of `normalize`/`buildContract` so
  replay-against-stored-raw stays intact.
- **Trust.** AI output must be visibly AI-derived and dismissible; it must not
  be confused with provider-sourced fields.

## Retention intent

Captured discussion under `docs/discussions/`. Promote the settled parts into
`docs/DESIGN.md` if/when a build is scheduled and decisions firm up. No cleanup
required before then.

## Read-first references

- `docs/DESIGN.md` — three layers, contract versioning, the two existing control
  planes, UI pages.
- `docs/CONTRACT.md` — contract change flow and semver rules.
- `AGENTS.md` — layer-purity and secret-handling boundaries.

## Recommended next artifact

A lightweight follow-up issue (the one linked to this doc) to host the open
decisions below. Graduate to an L2 plan bundle only when a build is scheduled.

> Open decisions are tracked in the follow-up issue, not in this document:
> model-per-mode, data-residency policy, Mode B's exact UI entry point, Mode A's
> surfacing (dedicated Digest page vs. an AI lens toggle vs. both), and the v1
> insight scope.
