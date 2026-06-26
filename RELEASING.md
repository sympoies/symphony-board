# Releasing

Creating a GitHub Release publishes two artifact sets: public container images
to the GitHub Container Registry (GHCR) for the Docker stack, and unsigned macOS
desktop app bundles attached to the Release.

Container images (GHCR):

| Image | Purpose |
| --- | --- |
| `ghcr.io/sympoies/symphony-board` | Backend sync / emit daemon, the sole writer |
| `ghcr.io/sympoies/symphony-board-web` | Read-only nginx UI sidecar |

The repository and published images are public. Runtime secrets, local config,
SQLite/Postgres stores, and emitted contracts are supplied by the operator at
runtime and are not baked into the images.

Desktop assets (attached to the GitHub Release), built on a native Apple
Silicon macOS runner so the standalone app bundles a matching Node sidecar:

| Asset | Architecture |
| --- | --- |
| `Symphony-Board-vX.Y.Z-macos-arm64-unsigned.zip` | Apple Silicon |
| `Symphony-Board-Standalone-vX.Y.Z-macos-arm64-unsigned.zip` | Apple Silicon |

These are unsigned, un-notarized app bundles; see the root README's "Build The
macOS App" section for installing them with `scripts/install-release-app.sh`.

## Versioning

Releases use app SemVer tags, for example `v0.1.0`. The root `package.json`
version is the default app version. The emitted contract version is independent:
consumers branch on `contract_version` in the JSON envelope, not on the app or
image tag.

The Tauri apps each carry their own version metadata that must be bumped in
lockstep with the root version. For `app` in `desktop`, `desktop-standalone`,
and `android`, bump all four of `packages/<app>/package.json`,
`packages/<app>/src-tauri/Cargo.toml`, `packages/<app>/src-tauri/Cargo.lock`
(the `symphony-board-<app>` entry), and
`packages/<app>/src-tauri/tauri.conf.json`. `scripts/check-app-versions.sh` —
the CI `check` gate, also `pnpm run check:app-versions` — fails the build if any
drifts, so a forgotten file is caught before release. `packages/ui` (a shared
library pinned at `0.1.0`) and `packages/contract` (its own version) are
intentionally excluded.

Published image tags:

| Image | Version tag | Rolling tag |
| --- | --- | --- |
| Backend | `ghcr.io/sympoies/symphony-board:0.1.0` | `ghcr.io/sympoies/symphony-board:latest` |
| UI | `ghcr.io/sympoies/symphony-board-web:0.1.0` | `ghcr.io/sympoies/symphony-board-web:latest` |

The `latest` tag is updated only for non-prerelease GitHub Releases.

## Cutting A Release

The release script refuses to publish from a dirty tree, from a non-`main`
branch, or from a local `main` that differs from `origin/main`.

Preview the release plan:

```sh
scripts/release.sh --dry-run
```

Cut the GitHub Release, wait for the image workflow, and verify public GHCR
manifests:

```sh
scripts/release.sh --execute
```

Use an explicit version when needed:

```sh
scripts/release.sh --dry-run --version 0.1.0
scripts/release.sh --execute --version 0.1.0
```

The project-local `$release` dispatcher is wired to the same script:

```sh
agent-run exec --cwd "$PWD" -- ./.agents/scripts/release.sh --dry-run
agent-run exec --cwd "$PWD" -- ./.agents/scripts/release.sh --execute
```

To verify already-published images without creating a release:

```sh
scripts/release.sh --verify-only --version v0.1.0
```

## Release Workflow

Creating a GitHub Release runs `.github/workflows/publish-image.yml`, which
publishes both the container images and the desktop assets.

Container images:

1. Build `linux/amd64` images for smoke tests.
2. Smoke-test the backend image with the validator and a no-token dry-run emit.
3. Smoke-test the UI image through nginx with a mounted contract file.
4. Build and push `linux/amd64,linux/arm64` images to GHCR.
5. Verify anonymous public GHCR manifests for the version tag and `latest`.

If anonymous manifest verification fails, treat the release as incomplete: the
image is not publicly pullable yet.

Desktop assets (the `desktop` job, in parallel):

6. On the native Apple Silicon macOS runner (`macos-26`), run
   `scripts/package-desktop-release.sh` to build both the thin-client and
   standalone apps for arm64.
7. Upload the two resulting unsigned `.zip` bundles to the GitHub Release with
   `gh release upload --clobber`.

Building on a native arm64 runner is what lets the standalone app bundle the
matching Node sidecar for Apple Silicon Macs.

## Pulling And Running

Published images can run with the same runtime mounts as the local build. Set
`SYMPHONY_IMAGE_TAG` to select a version:

```sh
SYMPHONY_IMAGE_TAG=0.1.0 docker compose -f docker/compose.yaml pull
SYMPHONY_IMAGE_TAG=0.1.0 docker compose -f docker/compose.yaml up -d --no-build
```

Local development can still rebuild from source:

```sh
docker compose -f docker/compose.yaml up -d --build
```
