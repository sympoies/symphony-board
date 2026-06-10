# In-App Config Settings Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: Sprints 1-2 complete (config control plane + Sources editor); Sprint 3 next
- Target scope: writer-owned config control plane, write-only secrets surface,
  capability-gated Settings -> Sources editor, standalone onboarding, and the
  DESIGN.md decision record.
- Execution window: Sprint 1 (config control plane) -> Sprint 2 (Sources
  editor) -> Sprint 3 (standalone onboarding and docs), serial.
- Current task: Sprint 2 delivered on the branch; checkpoint posted.
- Next task: Task 3.1 (standalone capability and secrets wiring).
- Last updated: 2026-06-10
- Branch/commit/PR: feat/in-app-config-settings (no PR yet)
- Source document: docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-plan.md
- Direct source-doc execution waiver: not applicable.
- Tracking issue: <https://github.com/sympoies/symphony-board/issues/151>

## Validation Plan

- Bundle creation: `plan-tooling validate --file docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-plan.md --format text --explain`.
- Sprint 1: `pnpm run typecheck && pnpm test`.
- Sprint 2: `pnpm run typecheck && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`.
- Sprint 3 / final: `pnpm run typecheck`, `pnpm test`,
  `pnpm --filter @symphony-board/ui run test`,
  `pnpm --filter @symphony-board/ui run build`,
  `pnpm --filter @symphony-board/ui run smoke`, `git diff --check`, plus the
  standalone rebuild/install/open smoke via the
  `project-rebuild-open-standalone-app` flow or an explicit waiver.

## Task Ledger

| ID | Status | Task | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | done | Config read/write endpoints and capability gate | GET/PUT /api/config on shared control handler; configErrors collects all problems; atomic saveConfig; typecheck + 144/144 tests pass | GET probe + validated atomic PUT on the shared control handler. |
| 1.2 | done | Write-only secrets surface and fresh token resolution | SYMPHONY_SECRETS_FILE overlay in tokenFor (fresh per call); write-only GET/PUT /api/secrets (booleans only, 0600 file, comments preserved); typecheck + 148/148 | SYMPHONY_SECRETS_FILE overlay; reads never return values. |
| 1.3 | done | Control-plane hardening and regression pass | readBody drains oversized bodies for a clean 413 (was ECONNRESET); independent gate matrix, concurrent PUT last-write-wins, mid-run edit tests; typecheck + 150/150 | Body limits, concurrency, mid-run edits, gate matrix. |
| 2.1 | done | Config client and capability probe | fetchConfigControl/saveConfigDocument/fetchSecrets/saveSecretValue + useConfig hook; probe-driven visibility; client tests pass | Typed client + probe-driven editor visibility. |
| 2.2 | done | Settings -> Sources editor section | SourcesEditor in Settings (capability-gated): draft + explicit save, add/remove source & project, display name, write-only token set/replace; field-level server errors render verbatim | Capability-gated; identities/exclude_actors untouched. |
| 2.3 | done | Post-save sync flow and removal semantics | sourcesNeedingSync drives post-save source-scoped full-sync offer via existing sync control; removal copy states history is retained | Source-scoped sync; retained-data messaging. |
| 2.4 | done | UI tests and render smoke | UI tests 79/79; render-smoke extended with config/secrets mock + 4 Sources-editor assertions, 0 console errors | Capability-absent smoke stays green. |
| 3.1 | todo | Standalone capability and secrets wiring | - | Default-on capability; empty-sources first-run seed. |
| 3.2 | todo | First-run onboarding empty state | - | Empty contract + capability + no sources only. |
| 3.3 | todo | Docs, devlog, and final validation | - | DESIGN.md decision record incl. JSON-not-TOML. |

## Session Log

- 2026-06-10: Implemented Sprint 2. New useConfig hook + config/secrets client
  in packages/ui (probe-driven: any probe failure hides the editor), and the
  SourcesEditor section on Settings: local draft with one explicit Save,
  add/remove sources (suggested defaults per provider/host) and repos, display
  name editing, write-only token set/replace with set/missing badges, the
  daemon's field-level validation errors rendered verbatim, removal copy
  stating history is retained, and a post-save source-scoped full-sync offer
  (sourcesNeedingSync) through the existing sync control. Render smoke now
  mocks /api/config + /api/secrets and asserts the editor. Validation: UI
  tests 79/79, UI build clean, smoke green with 0 console errors.
- 2026-06-10: Implemented Sprint 1 on feat/in-app-config-settings. GET/PUT
  /api/config and the write-only GET/PUT /api/secrets live on the shared
  control handler, gated by CONFIG_CONTROL_ENABLED (default on in app-server,
  off in the Docker daemon) plus the same-origin header. configErrors collects
  every validation problem for one-round-trip rejection; saveConfig/saveSecret
  write atomically (secrets file 0600, comments preserved); tokenFor overlays
  a fresh SYMPHONY_SECRETS_FILE read over the process env so runtime token
  edits apply without restart. Hardening fixed a latent readBody bug where an
  oversized body reset the socket instead of returning 413. The Docker daemon
  now also re-reads config per run, matching app-server. Validation: typecheck
  clean, 150/150 root tests (12 new).
- 2026-06-10: Created this bundle from the desktop-settings discussion. The
  converged approach is one UI and one protocol with capability-based
  enablement: a writer-owned config control plane (default on in the
  standalone sidecar, off in Docker), a write-only secrets surface with
  restart-free token resolution, a capability-gated Sources editor, and
  standalone first-run onboarding. Config stays JSON; TOML was evaluated and
  rejected.

## Validation

| Command | Status | Summary | Artifact |
| --- | --- | --- | --- |
| `plan-issue --version && plan-tooling --version` | pass | Both report 1.0.14, satisfying the create-plan-tracking-issue floors. | local |
| `plan-tooling validate --file docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-plan.md --format text --explain` | pass | Plan file valid; 0 errors. | local |
| `fnm exec --using 24 pnpm run typecheck` | pass | Root TypeScript check clean after Sprint 1. | local |
| `fnm exec --using 24 pnpm test` | pass | 150/150 root tests pass (12 new config/secrets/hardening tests). | local |
| `node src/cli/sync.ts --dry-run` | waived | Provider token env vars are unset in this shell; Sprint 1 touches the control surface and config loading, not provider fetch paths. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run test` | pass | UI tests 79/79 (config client + draft-mutation helper tests added). | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run build` | pass | Vite build clean after Sprint 2. | local |
| `fnm exec --using 24 pnpm --filter @symphony-board/ui run smoke` | pass | Render smoke green incl. 4 new Sources-editor assertions; 0 console errors / 0 uncaught exceptions. | local |
