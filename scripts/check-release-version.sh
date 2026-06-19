#!/usr/bin/env bash
#
# Gate a release tag against the repo's version files BEFORE any release artifact
# is published. publish-image.yml runs its `publish` (GHCR board/web images) and
# `desktop` (macOS bundles) jobs in parallel with no ordering between them, so a
# tag that drifts from package.json must fail a prerequisite job — otherwise the
# `publish` job moves the public `:<version>` / `:latest` GHCR tags before the
# `desktop` packaging step trips on the drift, leaving a partially published
# release (containers moved, desktop assets missing).
#
# Asserts, in order:
#   1. Every release-shipped per-app version file matches root package.json
#      (delegated to check-app-versions.sh).
#   2. The release tag matches root package.json — closing the chain
#      tag == package.json == per-app files == bundled .app.
#
# Usage: scripts/check-release-version.sh <tag>   (tag with or without leading v)
set -euo pipefail
unset CDPATH

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

die() {
  echo "check-release-version: error: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] || die "usage: check-release-version.sh <tag>"

tag_version="${1#v}"
if [[ ! "$tag_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then
  die "tag must be SemVer without build metadata, with optional leading v: $1"
fi

command -v jq >/dev/null 2>&1 || die "required command not found: jq"
pkg_version="$(jq -r '.version' package.json)"
if [ -z "$pkg_version" ] || [ "$pkg_version" = "null" ]; then
  die "could not read .version from root package.json"
fi

# (1) per-app version files vs root package.json.
bash "$repo_root/scripts/check-app-versions.sh"

# (2) the release tag itself vs root package.json.
if [ "$tag_version" != "$pkg_version" ]; then
  die "requested release version v$tag_version does not match package.json version v$pkg_version"
fi

echo "OK: release tag v$tag_version matches package.json and all per-app version files."
