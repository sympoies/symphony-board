---
name: project-rebuild-open-standalone-app
description: >
  Rebuild, install, and open the standalone macOS desktop app (UI + bundled
  sync daemon).
argument-hint: "[--no-install] [--no-open] [--wait-seconds N]"
allowed-tools: Bash, Read
---

# Project Rebuild Open Standalone App

Use this skill when backend, UI, desktop, or app-icon changes need to be
rebuilt into the standalone macOS Tauri app (`packages/desktop-standalone`:
the UI plus the bundled Node sidecar running `src/cli/app-server.ts`) and
opened for manual inspection. For the thin-client app, use
`project-rebuild-open-app` instead.

## Contract

Prereqs:

- Run inside the `symphony-board` git work tree.
- macOS is required for `.app` bundle install/open behavior.
- `fnm`, Node 24, `pnpm`, Rust/Tauri build tooling, and `open` are available
  (the build copies the active Node 24 binary in as the host-triple sidecar).
- `packages/desktop-standalone/src-tauri/tauri.conf.json` points at the app
  icon assets.

Inputs:

- Optional:
  - `--no-install` - build the app and open the built bundle in place instead
    of replacing `/Applications/Symphony Board Standalone.app`.
  - `--no-open` - build and install only.
  - `--wait-seconds N` - seconds to wait before checking for the app process
    after `open`; default `3`.

Outputs:

- Runs `fnm exec --using 24 pnpm desktop-standalone:build`.
- Produces the release bundle under
  `packages/desktop-standalone/src-tauri/target/release/bundle/macos/Symphony Board Standalone.app`.
- By default replaces `/Applications/Symphony Board Standalone.app` with the
  fresh bundle.
- Opens the app unless `--no-open` is passed. On launch the app seeds and uses
  `~/Library/Application Support/com.sympoies.symphony-board.standalone/`
  (config, secrets.env, SQLite store, logs) and serves on `127.0.0.1:8787`.

Exit codes:

- `0`: success
- `1`: command failed or a prerequisite is missing
- `2`: usage error or invalid inputs

Failure modes:

- Required local tooling is unavailable.
- The Tauri or UI build fails.
- The expected `.app` bundle is missing after build.
- Install or `open` fails.
- The process is not detected after opening.

## Scripts

- `.agents/skills/project-rebuild-open-standalone-app/scripts/project-rebuild-open-standalone-app.sh`
  owns the implementation.
- `.agents/scripts/rebuild-open-standalone-app.sh` is a thin project wrapper.

## Workflow

1. Run the skill-owned script from the repo root:
   `bash .agents/scripts/rebuild-open-standalone-app.sh`.
2. The script builds the standalone desktop package with Node 24 through
   `fnm` (which also refreshes the bundled Node sidecar and the standalone UI
   dist).
3. Unless `--no-install` is passed, it quits any running Symphony Board
   Standalone app, removes the previous
   `/Applications/Symphony Board Standalone.app`, and copies in the freshly
   built bundle.
4. Unless `--no-open` is passed, it opens the selected app bundle and checks
   for the `symphony-board-desktop-standalone` process.

## Boundary

This is a project-local skill. It must not mutate runtime-kit manifests,
rendered product output, global runtime homes, credentials, sessions, or cache
state. It intentionally replaces only
`/Applications/Symphony Board Standalone.app` during the default install path.
The app's own data dir
(`~/Library/Application Support/com.sympoies.symphony-board.standalone/`) is
runtime state owned by the app; this skill never edits it.
