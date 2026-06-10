# In-App Config Settings Source

- Status: decisions settled; ready for L2 plan tracking.
- Date: 2026-06-10
- Source: user discussion on desktop-app settings integration, current repo
  docs, and current source code inspection.
- Intended next step: open an L2 plan-tracking issue from this bundle.

## Execution

- Recommended plan: docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-plan.md
- Recommended execution state: docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-execution-state.md
- Status: decisions settled; plan tracking is the next step.
- Next-task source: this document.

## Problem

Before the desktop apps existed, producer config (`config/sources.json`) was a
hand-edited repo file consumed by the Docker stack, and that workflow was
acceptable. The standalone macOS app changed the audience: it seeds a config
template and a `secrets.env` under
`~/Library/Application Support/com.sympoies.symphony-board.standalone/` and
asks users to hand-edit both. For a self-contained app this is the weakest
part of the product surface, and it also blocks a real first-run onboarding.

The question discussed: should producer config become editable inside the app,
and should that mechanism be unified with the pure-web/Docker deployment or
split per deployment?

## User Decisions

- [U1] The standalone app should gain in-app Settings for producer config;
  hand-editing files under Application Support is not acceptable UX for a
  self-contained app.
- [U2] Keep one UI and one protocol across deployments and split by capability
  detection, mirroring the existing sync-control pattern; do not build a
  separate Tauri-native settings surface.
- [U3] Docker/web keeps the file-based config workflow; the config-edit
  capability defaults off there and defaults on in the standalone sidecar.
- [U4] The config file format stays JSON. A TOML migration was evaluated and
  rejected: the JS ecosystem has no mature comment-preserving TOML writer (the
  UI write path would clobber the format's human-oriented benefits), a TOML
  parser/serializer would break the backend's zero-third-party-runtime-
  dependency constraint, and the remaining beneficiaries (hand-editors on the
  Docker path) are too few to justify the migration.
- [U5] Deliver as an L2 plan-tracking issue with staged PRs: backend config
  control plane, UI Sources editor, standalone enablement + onboarding, docs.

## Confirmed Repository Facts

- [F1] `src/config.ts:69-140` resolves the config path (`SYMPHONY_CONFIG` env
  override, default `config/sources.json`) and validates strictly on load:
  required fields, hex color format, no `|` in `source_id`, IANA timezone.
- [F2] `src/cli/app-server.ts` re-reads config fresh per use, so config edits
  already apply without a sidecar restart.
- [F3] Provider tokens resolve from `process.env[s.token_env]` at
  `src/config.ts:151`; `src/sync-runner.ts:181` skips a source with a warning
  when the env var is unset. The standalone shell reads `secrets.env` once and
  passes it as env at sidecar spawn
  (`packages/desktop-standalone/src-tauri/src/main.rs`), so a token written at
  runtime is invisible to the running process today.
- [F4] The only mutation endpoint today is `POST /api/sync-runs`, gated by
  `SYNC_CONTROL_ENABLED` plus the same-origin `x-symphony-sync-control` header
  (`src/cli/sync-daemon.ts:33,301-307`). This is the writer-owned control
  plane precedent.
- [F5] The capability split already exists for sync control: the standalone
  app-server enables it by default (`src/cli/app-server.ts:139`), the Docker
  daemon defaults off (`src/cli/sync-daemon.ts:388`), and the UI hides the
  Sync affordance when the probe fails.
- [F6] Standalone data layout: per-user dir with `config/sources.json` seeded
  from a bundled template, `secrets.env`, `data/`, and logs
  (`packages/desktop-standalone/src-tauri/src/main.rs`,
  `packages/desktop-standalone/README.md`).
- [F7] Docker Compose bind-mounts `config/` read-only into all three services;
  even the writer `board` cannot write config (`docker/compose.yaml`).
- [F8] The UI Settings page persists only browser-local view preferences in
  `localStorage` (`packages/ui/src/viewconfig.ts`); the UI has no other write
  path and stays a read-only contract consumer.
- [F9] The backend has zero third-party runtime dependencies; root
  `package.json` dependencies contain only the workspace contract package.
- [F10] `identities` / `exclude_actors` are curated by the
  `project-actor-identities` flow, not hand-edited per session.

## Decisions

- Add a writer-owned config control plane next to the existing sync control
  plane, served by the shared daemon/app-server control handler:
  - `GET /api/config` returns the current validated producer config and acts
    as the UI capability probe (disabled deployments answer with the same
    disabled shape sync control uses).
  - `PUT /api/config` validates the candidate with the same `loadConfig`
    validation rules, returns structured field-level errors on rejection, and
    writes atomically (temp file + rename) on success. Server-side validation
    is authoritative.
  - Gate mutations behind a new `CONFIG_CONTROL_ENABLED` flag plus the
    existing same-origin custom-header pattern. Default on in
    `app-server.ts` (standalone), default off in `sync-daemon.ts` (Docker).
- Secrets stay out of config and out of read responses:
  - Introduce a secrets-file surface (`SYMPHONY_SECRETS_FILE`) with write-only
    semantics: the UI can set/replace a token for an env-var name; reads only
    report which names are set, never values.
  - Token resolution overlays a fresh read of the secrets file over
    `process.env` at sync time so a UI-set token applies without an app
    restart (fixes the spawn-time-env limitation in [F3]).
- Removal semantics: removing a source/project stops syncing it but keeps
  historical data (a source absent from config is never swept, so no
  tombstones). An explicit purge is future work, not v1.
- After a config change that adds a source/project, the UI offers a
  source-scoped manual sync through the existing sync control plane.
- Standalone first-run becomes a real onboarding: empty state guides the user
  to Settings -> Sources (add first source -> set token -> first sync),
  replacing the seeded-template-then-hand-edit flow.
- v1 scope excludes editing `identities` / `exclude_actors` [F10]; the editor
  must round-trip those fields unchanged.
- The contract is untouched: this is control plane, not the versioned consumer
  contract. No contract version bump.
- Record the decision set (writer-owned config plane, Docker stays file-based,
  JSON-not-TOML) in `docs/DESIGN.md`.

## Scope

In scope:

- Backend config control plane: `GET/PUT /api/config`, write-only secrets
  surface, capability gating, atomic writes, structured validation errors,
  fresh token resolution, backend tests.
- UI: capability probe + typed client, Settings -> Sources editor
  (list/add/remove sources and projects, display name, color, token
  set/replace affordance), post-save sync affordance, removal-semantics
  messaging, UI tests and render smoke.
- Standalone: capability and secrets-file wiring, first-run onboarding empty
  state, README updates.
- Docs: DESIGN.md decision record, README control-plane docs, devlog entry.

Out of scope:

- Editing `identities` / `exclude_actors` in the UI.
- Config editing for the Docker/web deployment by default (the architecture
  allows enabling it; the default stays off and the file workflow documented).
- Purging historical data when a source/project is removed.
- TOML or any config file format migration.
- Contract schema or version changes.
- Provider write actions, auth/multi-user concerns, remote (non-loopback)
  mutation hardening beyond the existing same-origin pattern.

## Acceptance Criteria

- A standalone user can add a source and its projects, set its token, trigger
  the first sync, and see the board populate without ever hand-editing files.
- An invalid config submitted through the UI is rejected with field-level
  errors and never written to disk; a valid one applies on the next run
  without restarting the app.
- Reading the secrets surface never exposes token values.
- The Docker deployment behavior is unchanged by default: config mutations are
  refused, the UI hides the editor, file-based workflow keeps working.
- `config/sources.json` written by the app round-trips `identities` /
  `exclude_actors` and unknown-to-the-editor fields unchanged.
- DESIGN.md records the writer-owned config plane and JSON-not-TOML decisions.

## Validation Plan

- `plan-tooling validate --file docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-plan.md --format text --explain`
- `pnpm run typecheck`
- `pnpm test`
- `pnpm --filter @symphony-board/ui run test`
- `pnpm --filter @symphony-board/ui run build`
- `pnpm --filter @symphony-board/ui run smoke`
- `git diff --check`
- Standalone stage: rebuild/install/open smoke via the
  `project-rebuild-open-standalone-app` flow, or an explicit waiver.

## Retention Intent

This plan source is a tracked implementation artifact. Keep it until the plan
is completed and archived; promote only final control-plane semantics into
`docs/DESIGN.md`, README surfaces, and devlog.
