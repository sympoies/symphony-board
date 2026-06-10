# Plan: In-App Config Settings Via Writer-Owned Config Plane

## Overview

Make producer config (`config/sources.json`) editable from the app through a
writer-owned config control plane, primarily for the standalone macOS app. One
UI and one protocol serve every deployment; capability detection splits who can
edit: the standalone sidecar enables the surface by default, the Docker stack
keeps its read-only file-based workflow with the capability off.

The work spans the backend control surface, a write-only secrets surface with
restart-free token resolution, the capability-gated Settings -> Sources editor
in the UI, standalone first-run onboarding, and the DESIGN.md decision record.
The versioned contract is untouched.

## Read First

- Primary source: docs/plans/2026-06-10-in-app-config-settings/2026-06-10-in-app-config-settings-discussion-source.md
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope:
  - `GET /api/config` (read + capability probe) and `PUT /api/config`
    (validated, atomic write) on the shared control handler, gated by
    `CONFIG_CONTROL_ENABLED` plus the same-origin header pattern.
  - Write-only secrets surface backed by `SYMPHONY_SECRETS_FILE`, with token
    resolution overlaying a fresh secrets-file read over `process.env` at sync
    time.
  - Capability-gated Settings -> Sources editor: list/add/remove sources and
    projects, edit display name and color, set/replace tokens, structured
    validation errors, post-save source-scoped sync affordance, and
    removal-semantics messaging.
  - Standalone wiring: capability on by default, secrets-file env, first-run
    onboarding empty state, README updates.
  - DESIGN.md decision record (writer-owned config plane, Docker stays
    file-based, JSON-not-TOML), README updates, devlog entry.
- Out of scope:
  - Editing `identities` / `exclude_actors` in the UI (fields must round-trip
    unchanged).
  - Enabling config mutation in the Docker deployment by default.
  - Purging historical data when a source or project is removed.
  - TOML or any config file format migration.
  - Contract schema or version changes.
  - Provider write actions, auth/multi-user hardening beyond the existing
    same-origin pattern.

## Assumptions

1. The contract is untouched: the config control plane is producer-side, so no
   contract version bump and no `packages/contract` changes are needed.
2. The config control plane can reuse the sync-control infrastructure: the
   shared request handler in `src/cli/sync-daemon.ts`, the same-origin header
   pattern, and the default-on-in-app-server / default-off-in-daemon flag
   split (`src/cli/app-server.ts:139`, `src/cli/sync-daemon.ts:388`).
3. Last-write-wins is acceptable for `PUT /api/config` in v1; the standalone
   app is single-user and the daemon already re-reads config per run.
4. The editor edits a typed subset (sources, projects, display fields,
   timezone); all other fields present in the file, including `identities` and
   `exclude_actors`, round-trip unchanged through PUT.
5. `secrets.env` stays the single token store for the standalone app; the
   sidecar reads it fresh at sync time via `SYMPHONY_SECRETS_FILE` while the
   Tauri shell keeps passing it as spawn env for backward compatibility.

## Sprint 1: Writer-Owned Config Control Plane

**Goal**: Serve and mutate producer config through the writer-owned control
surface with authoritative validation, without touching Docker defaults.
**PR grouping intent**: `group`
**Execution Profile**: `serial`
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test`
- Verify: config GET/PUT and secrets endpoints behave per gate matrix
  (enabled/disabled, header present/missing), invalid configs never reach
  disk, and a token set at runtime is used by the next sync without restart.

### Task 1.1: Config read/write endpoints and capability gate

- **Location**:
  - `src/cli/sync-daemon.ts`
  - `src/cli/app-server.ts`
  - `src/config.ts`
  - `test/sync-daemon.test.ts`
  - `test/app-server.test.ts`
- **Description**: Add `GET /api/config` and `PUT /api/config` to the shared
  control handler. GET returns the current validated config and doubles as the
  UI capability probe; PUT validates the candidate with the same rules as
  `loadConfig`, returns structured field-level errors on rejection, and writes
  atomically (temp file + rename) on success. Gate the surface behind
  `CONFIG_CONTROL_ENABLED` plus a same-origin custom header for mutations,
  defaulting on in `app-server.ts` and off in `sync-daemon.ts`.
- **Dependencies**:
  - none
- **Complexity**: 6
- **Acceptance criteria**:
  - An invalid PUT body returns structured errors and writes nothing to disk.
  - A valid PUT round-trips through GET and the next sync run uses the new
    config without a process restart.
  - Mutations without the same-origin header are rejected with 403.
  - With the flag off (Docker daemon default), config mutations are refused
    and the probe reports the surface disabled.
  - Fields the editor does not own, including `identities` and
    `exclude_actors`, round-trip byte-stable through GET -> PUT.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

### Task 1.2: Write-only secrets surface and fresh token resolution

- **Location**:
  - `src/config.ts`
  - `src/sync-runner.ts`
  - `src/cli/sync-daemon.ts`
  - `src/cli/app-server.ts`
  - `test/config.test.ts`
  - `test/app-server.test.ts`
- **Description**: Introduce `SYMPHONY_SECRETS_FILE`. Token resolution overlays
  a fresh read of the secrets file over `process.env` at sync time, so tokens
  written at runtime apply without restart. Add a write-only secrets surface
  to the control handler: setting/replacing a token for an env-var name is
  allowed; reads only report which names are set, never values. Reuse the same
  capability flag and header gate as Task 1.1.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 5
- **Acceptance criteria**:
  - No endpoint ever returns a token value; list responses carry env-var names
    and a set/unset flag only.
  - A token set through the surface is used by the next sync run without a
    process restart.
  - The secrets file is created with owner-only permissions when missing and
    preserves unrelated entries on update.
  - Sources with unset tokens keep the existing skip-with-warning behavior.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

### Task 1.3: Control-plane hardening and regression pass

- **Location**:
  - `src/cli/sync-daemon.ts`
  - `test/sync-daemon.test.ts`
  - `test/app-server.test.ts`
- **Description**: Harden the new surface: bounded request bodies, malformed
  JSON handling, concurrent PUT behavior (last write wins, no torn file), and
  config edits landing while a sync run is active (the active run finishes on
  the old config; the next run picks up the new one). Extend the daemon/app
  server test matrix to cover the full gate combinations.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 4
- **Acceptance criteria**:
  - Oversized or malformed bodies produce clean 4xx errors, never crashes or
    partial writes.
  - Concurrent PUTs leave a valid, fully written config file.
  - A config edit during an active sync run does not disturb that run and is
    honored by the next run.
  - Existing sync-control behavior is unchanged across the test matrix.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

## Sprint 2: Capability-Gated Sources Editor In Settings

**Goal**: Let the UI read and edit producer config when the server advertises
the capability, with clear separation from browser-local view preferences.
**PR grouping intent**: `group`
**Execution Profile**: `serial`
**Demo/Validation**:
- Command(s): `pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: Settings shows the Sources editor only when the probe succeeds,
  validation errors render field-level, and the post-save sync affordance
  triggers a source-scoped run.

### Task 2.1: Config client and capability probe

- **Location**:
  - `packages/ui/src/contract.ts`
  - `packages/ui/src/model.ts`
  - `packages/ui/test/model.test.ts`
- **Description**: Add a typed client for the config and secrets surfaces
  (GET/PUT with the same-origin header, structured error decoding) and a
  capability probe that drives editor visibility, following the existing
  sync-control client pattern and honoring the configurable server base URL.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 4
- **Acceptance criteria**:
  - Probe failure (404/403/disabled/network) hides the editor without console
    errors and without affecting existing Settings behavior.
  - Validation errors from PUT decode into a field-addressable structure.
  - The client never logs or stores token values beyond the in-flight request.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm run typecheck`

### Task 2.2: Settings -> Sources editor section

- **Location**:
  - `packages/ui/src/components/SettingsPage.tsx`
  - `packages/ui/src/components/SourcesEditor.tsx`
  - `packages/ui/src/styles.css`
- **Description**: Add a capability-gated Sources section to Settings: list
  sources and their projects from `GET /api/config`; add/remove sources and
  projects; edit display name and color; set/replace a source token through
  the write-only surface (showing set/unset status only). Keep the section
  visually distinct from browser-local view preferences so users understand
  what changes the daemon versus the browser.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 6
- **Acceptance criteria**:
  - The editor renders only when the capability probe succeeds.
  - Server-side validation errors surface next to the offending field; the
    save flow never claims success on a rejected PUT.
  - Token inputs are write-only: existing values are never displayed.
  - `identities` / `exclude_actors` are not editable and survive a save
    unchanged.
  - Browser-local view preferences keep working unchanged when the editor is
    hidden.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run build`

### Task 2.3: Post-save sync flow and removal semantics

- **Location**:
  - `packages/ui/src/components/SourcesEditor.tsx`
  - `packages/ui/src/components/SyncControls.tsx`
  - `packages/ui/src/contract.ts`
- **Description**: After a save that adds a source or project, offer a
  source-scoped sync through the existing sync control plane and reload the
  contract in place on completion. After a removal, state that syncing stops
  but historical data is retained (no sweep means no tombstones; purge is
  future work).
- **Dependencies**:
  - Task 2.2
- **Complexity**: 4
- **Acceptance criteria**:
  - The post-save sync affordance appears only when sync control is available
    and targets the affected source.
  - Removal messaging is explicit about retained historical data.
  - Route, search, filters, and time range are preserved across the post-save
    reload, matching existing manual-sync behavior.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm run typecheck`

### Task 2.4: UI tests and render smoke

- **Location**:
  - `packages/ui/test/`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Cover the client, probe, and editor behavior with unit
  tests, and extend render smoke to assert Settings renders correctly in the
  capability-absent case (static contract serving, editor hidden, no console
  errors).
- **Dependencies**:
  - Task 2.3
- **Complexity**: 3
- **Acceptance criteria**:
  - Unit tests cover probe-driven visibility, error decoding, write-only token
    handling, and post-save flows.
  - Render smoke passes with the editor hidden and zero console errors.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

## Sprint 3: Standalone Onboarding And Decision Record

**Goal**: Ship the capability in the standalone app with a real first-run
onboarding, and record the architecture decisions.
**PR grouping intent**: `group`
**Execution Profile**: `serial`
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test && pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: a fresh standalone install reaches a populated board through
  in-app onboarding only, and DESIGN.md records the decision set.

### Task 3.1: Standalone capability and secrets wiring

- **Location**:
  - `packages/desktop-standalone/src-tauri/src/main.rs`
  - `packages/desktop-standalone/README.md`
  - `src/cli/app-server.ts`
- **Description**: Wire the standalone sidecar: `CONFIG_CONTROL_ENABLED`
  defaults on in app-server mode, `SYMPHONY_SECRETS_FILE` points at the data
  directory's `secrets.env`, and the first-run seed becomes an empty-sources
  config suitable for onboarding instead of a template that requires hand
  editing. Verify the adopt-existing-daemon path still behaves.
- **Dependencies**:
  - Task 2.4
- **Complexity**: 4
- **Acceptance criteria**:
  - A fresh install exposes the config capability without any manual file
    edits; tokens set in-app land in `secrets.env`.
  - Existing installs with a populated config keep working unchanged.
  - The standalone README documents the in-app flow and demotes hand-editing
    to a fallback.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

### Task 3.2: First-run onboarding empty state

- **Location**:
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/components/SettingsPage.tsx`
  - `packages/ui/src/styles.css`
- **Description**: When the contract is absent or empty, the config capability
  is present, and no sources are configured, render an onboarding empty state
  that guides the user to Settings -> Sources: add the first source, set its
  token, run the first sync.
- **Dependencies**:
  - Task 3.1
- **Complexity**: 4
- **Acceptance criteria**:
  - The onboarding state appears only in the empty-config-with-capability
    case; web/Docker users with an empty contract see existing behavior.
  - Completing onboarding lands the user on a populated board without leaving
    the app.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 3.3: Docs, devlog, and final validation

- **Location**:
  - `docs/DESIGN.md`
  - `README.md`
  - `packages/desktop-standalone/README.md`
  - `docs/devlog/2026-06.md`
- **Description**: Add the DESIGN.md decision record for the writer-owned
  config plane (capability split, Docker stays file-based by default, secrets
  write-only semantics, JSON-not-TOML rationale), update README control-plane
  docs, write the devlog entry, and run the full validation suite plus the
  standalone rebuild/open smoke.
- **Dependencies**:
  - Task 3.2
- **Complexity**: 3
- **Acceptance criteria**:
  - DESIGN.md records the decision set with rationale.
  - README documents the config control plane next to sync control, including
    the Docker default-off stance.
  - Devlog records the shipped flow, issue/PR refs, and validation evidence.
  - Full validation passes; the standalone rebuild/install/open smoke runs via
    the `project-rebuild-open-standalone-app` flow or is explicitly waived.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run build`
  - `pnpm --filter @symphony-board/ui run smoke`
  - `git diff --check`

## Final Definition Of Done

- A standalone user can go from fresh install to a populated board entirely
  in-app: add a source, set a token, trigger the first sync.
- Invalid configs are rejected with field-level errors and never written;
  valid edits apply without restart.
- No endpoint or UI surface ever exposes a stored token value.
- Docker deployment behavior is unchanged by default; the UI hides the editor
  where the capability is absent.
- `identities` / `exclude_actors` and editor-unknown fields round-trip
  unchanged through the editor's save path.
- The contract is untouched; DESIGN.md records the writer-owned config plane
  and JSON-not-TOML decisions; all plan validation commands pass or carry an
  explicit waiver.
