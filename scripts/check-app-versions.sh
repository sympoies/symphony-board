#!/usr/bin/env bash
#
# Assert the release-shipped apps carry the SAME version as the root
# package.json. The release bump is manual and edits each app's version files by
# hand, so an app can silently lag the release — most recently `android`
# (PR #263), whose APKs kept advertising 1.1.4 while the release moved to 1.1.6.
# This gate fails CI on any such drift.
#
#   Source of truth : root package.json `.version`.
#   Checked apps    : packages/{desktop,desktop-standalone,android}, each across
#                     package.json + src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}.
#   NOT checked     : packages/ui (shared lib, pinned 0.1.0) and packages/contract
#                     (its own contract-version line) — intentionally decoupled.
#
set -euo pipefail
unset CDPATH

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

root_version="$(jq -r '.version' package.json)"
if [ -z "$root_version" ] || [ "$root_version" = "null" ]; then
  echo "could not read .version from root package.json" >&2
  exit 1
fi

apps=(desktop desktop-standalone android)
drift=0

check() {
  # check <file> <found> <expected>
  if [ "$2" != "$3" ]; then
    printf 'DRIFT  %-56s %-8s (expected %s)\n' "$1" "$2" "$3"
    drift=1
  fi
}

for app in "${apps[@]}"; do
  base="packages/$app"
  crate="symphony-board-$app"

  check "$base/package.json" \
    "$(jq -r '.version' "$base/package.json")" "$root_version"
  check "$base/src-tauri/tauri.conf.json" \
    "$(jq -r '.version' "$base/src-tauri/tauri.conf.json")" "$root_version"
  # [package] is the first table in these crate manifests, so the first
  # top-level `version = "…"` line is the crate version.
  check "$base/src-tauri/Cargo.toml" \
    "$(grep -m1 -E '^version *= *"' "$base/src-tauri/Cargo.toml" | cut -d'"' -f2)" \
    "$root_version"
  # Cargo.lock: the `version` line inside this crate's own [[package]] block.
  check "$base/src-tauri/Cargo.lock" \
    "$(awk -v want="name = \"$crate\"" '
       $0 == want { found = 1; next }
       found && /^version = "/ { gsub(/^version = "|"$/, ""); print; exit }
     ' "$base/src-tauri/Cargo.lock")" \
    "$root_version"
done

if [ "$drift" -ne 0 ]; then
  {
    echo
    echo "Release version drift vs root package.json ($root_version)."
    echo "Bump every per-app version file together when cutting a release:"
    echo "  packages/<app>/package.json"
    echo "  packages/<app>/src-tauri/Cargo.toml"
    echo "  packages/<app>/src-tauri/Cargo.lock   (the symphony-board-<app> entry)"
    echo "  packages/<app>/src-tauri/tauri.conf.json"
  } >&2
  exit 1
fi

echo "OK: desktop, desktop-standalone, android all match root package.json ($root_version)."
