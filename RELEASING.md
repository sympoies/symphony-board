# Releasing

`symphony-board` ships two public container images to the GitHub Container
Registry (GHCR):

| Image | Purpose |
| --- | --- |
| `ghcr.io/sympoies/symphony-board` | Backend sync / emit daemon, the sole writer |
| `ghcr.io/sympoies/symphony-board-web` | Read-only nginx UI sidecar |

The repository and published images are public. Runtime secrets, local config,
SQLite stores, and emitted contracts are supplied by the operator at runtime and
are not baked into the images.

## Versioning

Releases use app SemVer tags, for example `v0.1.0`. The root `package.json`
version is the default app version. The emitted contract version is independent:
consumers branch on `contract_version` in the JSON envelope, not on the app or
image tag.

Published image tags:

| Image | Version tag | Rolling tag |
| --- | --- |
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

## Image Workflow

Creating a GitHub Release publishes both images through
`.github/workflows/publish-image.yml`:

1. Build `linux/amd64` images for smoke tests.
2. Smoke-test the backend image with the validator and a no-token dry-run emit.
3. Smoke-test the UI image through nginx with a mounted contract file.
4. Build and push `linux/amd64,linux/arm64` images to GHCR.
5. Verify anonymous public GHCR manifests for the version tag and `latest`.

If anonymous manifest verification fails, treat the release as incomplete: the
image is not publicly pullable yet.

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
