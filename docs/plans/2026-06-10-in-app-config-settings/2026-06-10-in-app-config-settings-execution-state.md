# In-App Config Settings Execution State

<!-- plan-issue-record:v2 role=state profile=tracking -->
## Execution State

- Status: planned; awaiting tracking issue open
- Target scope: writer-owned config control plane, write-only secrets surface,
  capability-gated Settings -> Sources editor, standalone onboarding, and the
  DESIGN.md decision record.
- Execution window: Sprint 1 (config control plane) -> Sprint 2 (Sources
  editor) -> Sprint 3 (standalone onboarding and docs), serial.
- Current task: open the plan-tracking issue from this bundle.
- Next task: Task 1.1 (config read/write endpoints and capability gate).
- Last updated: 2026-06-10
- Branch/commit/PR: not started
- Source document: docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-plan.md
- Direct source-doc execution waiver: not applicable.
- Tracking issue: pending

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
| 1.1 | todo | Config read/write endpoints and capability gate | - | GET probe + validated atomic PUT on the shared control handler. |
| 1.2 | todo | Write-only secrets surface and fresh token resolution | - | SYMPHONY_SECRETS_FILE overlay; reads never return values. |
| 1.3 | todo | Control-plane hardening and regression pass | - | Body limits, concurrency, mid-run edits, gate matrix. |
| 2.1 | todo | Config client and capability probe | - | Typed client + probe-driven editor visibility. |
| 2.2 | todo | Settings -> Sources editor section | - | Capability-gated; identities/exclude_actors untouched. |
| 2.3 | todo | Post-save sync flow and removal semantics | - | Source-scoped sync; retained-data messaging. |
| 2.4 | todo | UI tests and render smoke | - | Capability-absent smoke stays green. |
| 3.1 | todo | Standalone capability and secrets wiring | - | Default-on capability; empty-sources first-run seed. |
| 3.2 | todo | First-run onboarding empty state | - | Empty contract + capability + no sources only. |
| 3.3 | todo | Docs, devlog, and final validation | - | DESIGN.md decision record incl. JSON-not-TOML. |

## Session Log

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
