---
name: project-rebuild-open-app
description: >
  Rebuild, install, and open the local macOS desktop app.
argument-hint: "[--no-install] [--no-open] [--wait-seconds N]"
allowed-tools: Bash, Read
---

# Project Rebuild Open App

Use this skill when local UI, desktop, or app-icon changes need to be rebuilt
into the macOS Tauri app and opened for manual inspection.

## Contract

Prereqs:

- Run inside the `symphony-board` git work tree.
- macOS is required for `.app` bundle install/open behavior.
- `fnm`, Node 24, `pnpm`, Rust/Tauri build tooling, and `open` are available.
- `packages/desktop/src-tauri/tauri.conf.json` points at the app icon assets.

Inputs:

- Optional:
  - `--no-install` - build the app and open the built bundle in place instead
    of replacing `/Applications/Symphony Board.app`.
  - `--no-open` - build and install only.
  - `--wait-seconds N` - seconds to wait before checking for the app process
    after `open`; default `3`.

Outputs:

- Runs `fnm exec --using 24 pnpm desktop:build`.
- Produces the release bundle under
  `packages/desktop/src-tauri/target/release/bundle/macos/Symphony Board.app`.
- By default replaces `/Applications/Symphony Board.app` with the fresh bundle.
- Opens the app unless `--no-open` is passed.

Exit codes:

- `0`: success
- `1`: command failed or a prerequisite is missing
- `2`: usage error or invalid inputs

Failure modes:

- Required local tooling is unavailable.
- The Tauri build fails.
- The expected `.app` bundle is missing after build.
- Install or `open` fails.
- The process is not detected after opening.

## Scripts

- `.agents/skills/project-rebuild-open-app/scripts/project-rebuild-open-app.sh`
  owns the implementation.
- `.agents/scripts/rebuild-open-app.sh` is a thin project wrapper.

## Workflow

1. Run the skill-owned script from the repo root:
   `bash .agents/scripts/rebuild-open-app.sh`.
2. The script builds the desktop package with Node 24 through `fnm`.
3. Unless `--no-install` is passed, it quits any running Symphony Board app,
   removes the previous `/Applications/Symphony Board.app`, and copies in the
   freshly built bundle.
4. Unless `--no-open` is passed, it opens the selected app bundle and checks
   for the `symphony-board-desktop` process.

## Boundary

This is a project-local skill. It must not mutate runtime-kit manifests,
rendered product output, global runtime homes, credentials, sessions, or cache
state. It intentionally replaces only `/Applications/Symphony Board.app` during
the default install path.
