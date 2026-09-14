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

Cut the GitHub Release:

```sh
scripts/release.sh --execute
```

This returns once the Release exists and its `publish-image` run has started,
printing that run's URL. It does not wait for the run, because the workflow
decides completeness itself: it verifies the public GHCR manifests and that the
desktop assets reached the Release, so a green run means the release is done and
a red one means it is not. Watch the run, not your terminal.

It does still confirm the run exists, because that is the one failure CI cannot
report: if Actions is disabled, the workflow is broken on `main`, or a
concurrency group is holding it, there is no red run to notice — there is no
run. `--timeout` bounds that wait.

Pass `--wait` to block on the workflow and run the same verification locally
— the old default. It takes tens of minutes because of the emulated
`linux/arm64` build, and losing that wait is what `--resume` was written for.

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

### Resuming An Interrupted Release

`--execute --wait` creates the GitHub Release and then waits for
`publish-image.yml`, which takes tens of minutes because of the emulated
`linux/arm64` build. If that wait dies — the terminal is closed, the session
ends, Ctrl+C — the Release is already published but nothing verified it, and
neither other mode recovers:
`--execute` refuses to run again because the Release exists, and `--verify-only`
reads GHCR immediately, so it fails while the workflow is still in flight.

`--resume` is that recovery path. It mutates nothing: it reads the released
commit from the Release, re-attaches to the `publish-image` run for that commit,
waits for it, and then runs the same verification the interrupted run never
reached. It takes the prerelease flag from the Release too, rather than asking
you to retype `--prerelease`: resume exists precisely because the original
invocation's flags are gone, and getting that one wrong would check a `latest`
belonging to some earlier release and still report this one complete.

The default `--execute` no longer has that wait to lose, so this is now a
recovery path for `--wait` runs and a way to attach to a release someone else
cut — not something an ordinary release needs.

Resume needs a Release this script cut. `--execute` records the commit, while a
Release created any other way records a branch name instead, which can never
match a workflow run. Resume says so immediately rather than waiting out the
discovery timeout.

```sh
scripts/release.sh --resume --version v0.1.0
```

Use `--verify-only` when the workflow has already finished and you only want to
re-check the published artifacts; use `--resume` when it may still be running.
A release that was never verified is incomplete, so always close out with one of
the two.

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

Completeness:

8. The `release-complete` job checks that all three desktop assets actually
   reached the Release. Together with step 5 this makes a green run mean the
   release carries every artifact, which is why `release.sh --execute` no longer
   has to wait and verify locally.

Optional downstream dispatch:

9. If `DEPLOY_DISPATCH_REPOSITORY` is configured, the publish job dispatches the
   release after public GHCR manifests are verified.
10. If `HOMEBREW_TAP_DISPATCH_REPOSITORY` is configured, the workflow dispatches
    the release after both the publish and desktop jobs complete, so the tap can
    read the macOS SHA256SUMS asset.

### Testing A Change To The Workflow

`publish-image.yml` used to run only on `release: published`, so every edit to
it shipped unverified — one of them, an arm64 build that died under QEMU, cost
v1.22.0 its images before anyone noticed. It now also accepts a manual run:

```sh
gh workflow run publish-image.yml --ref <branch> -f tag=v1.23.0
```

The run builds and smoke-tests the named existing tag and publishes nothing:
no GHCR push, no asset upload, no deploy or Homebrew dispatch, and `latest`
stays put. Pass `-f push=true` to make it a real publication of that tag,
which is the recovery path for a release whose images failed to build.

`tag` must name a tag that already exists. It is free text and every job checks
that ref out, so the jobs check out `refs/tags/<tag>` and the version gate
refuses anything origin does not carry as a tag — otherwise anyone with write
access could push a branch called `v9.9.9`, give it a matching `package.json`,
and have its `Dockerfile` and packaging scripts built and published as if they
were a release.

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
