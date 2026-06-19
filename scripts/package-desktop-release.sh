#!/usr/bin/env bash
# Build and package unsigned macOS desktop app bundles for a GitHub Release.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/package-desktop-release.sh [options]

Options:
  --version VERSION      Release version, with or without leading v.
                         Defaults to package.json version.
  --target TRIPLE        Optional Rust target triple, for example
                         aarch64-apple-darwin or x86_64-apple-darwin.
  --out-dir DIR          Output directory. Defaults to dist/release.
  --skip-build           Package already-built app bundles.
  -h, --help             Show this help.
USAGE
}

die() {
  echo "package-desktop-release: error: $*" >&2
  exit 1
}

info() {
  echo "package-desktop-release: $*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

package_version() {
  node -e 'const p = require("./package.json"); if (!p.version) process.exit(1); console.log(p.version)'
}

normalize_version() {
  local raw="$1"
  raw="${raw#v}"
  if [[ ! "$raw" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then
    die "version must be SemVer without build metadata, with optional leading v: $1"
  fi
  printf '%s\n' "$raw"
}

target_label() {
  case "$1" in
    aarch64-apple-darwin)
      printf '%s\n' "macos-arm64"
      ;;
    x86_64-apple-darwin)
      printf '%s\n' "macos-x64"
      ;;
    "")
      local host arch
      host="$(rustc -vV | awk '/^host:/ {print $2}')"
      case "$host" in
        aarch64-apple-darwin) arch="macos-arm64" ;;
        x86_64-apple-darwin) arch="macos-x64" ;;
        *) arch="${host:-macos}" ;;
      esac
      printf '%s\n' "$arch"
      ;;
    *)
      printf '%s\n' "$1" | tr -c 'A-Za-z0-9._-' '-'
      ;;
  esac
}

app_bundle_path() {
  local package="$1"
  local app_name="$2"
  local target="$3"
  local target_dir="target/release"
  if [ -n "$target" ]; then
    target_dir="target/$target/release"
  fi
  printf '%s\n' "$package/src-tauri/$target_dir/bundle/macos/$app_name.app"
}

build_app() {
  local package_filter="$1"
  local target="$2"
  local args=(--filter "$package_filter" exec tauri build --bundles app)
  if [ -n "$target" ]; then
    args+=(--target "$target")
  fi
  pnpm "${args[@]}"
}

zip_app() {
  local app_path="$1"
  local zip_path="$2"
  [ -d "$app_path" ] || die "expected app bundle missing: $app_path"
  rm -f "$zip_path"
  ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"
  [ -s "$zip_path" ] || die "zip was not created: $zip_path"
}

version=""
target=""
out_dir="dist/release"
skip_build=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      version="$(normalize_version "$2")"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || die "--target requires a value"
      target="$2"
      shift 2
      ;;
    --out-dir)
      [ "$#" -ge 2 ] || die "--out-dir requires a value"
      out_dir="$2"
      shift 2
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  die "current directory is not inside a git work tree"
cd "$repo_root"

need_command ditto
need_command git
need_command jq
need_command node
need_command pnpm
need_command rustc
need_command shasum

# Refuse to package a release whose version files drift. The bundled .app
# version comes from each app's src-tauri/tauri.conf.json (read by `tauri
# build`), NOT from --version, which only names the output zip — so a stale
# tauri.conf.json (or a tag ahead of package.json) would ship a bundle
# advertising the wrong version under a v<tag> zip. The push/PR `ci` workflow and
# publish-image.yml's version-gate job run this check, but re-assert it here at
# the point the artifacts are actually built.
#
# With --version (the release path passes GITHUB_REF_NAME) gate the full chain
# tag == package.json == per-app files via the shared script. Without it (local
# packaging) there is no tag to compare, so check only the per-app files and take
# the version from package.json.
if [ -n "$version" ]; then
  "$repo_root/scripts/check-release-version.sh" "$version"
else
  "$repo_root/scripts/check-app-versions.sh"
  version="$(normalize_version "$(package_version)")"
fi

label="$(target_label "$target")"
mkdir -p "$out_dir"

info "version=$version"
info "target=${target:-host}"
info "label=$label"
info "out_dir=$out_dir"

if [ "$skip_build" -eq 0 ]; then
  build_app "@symphony-board/desktop" "$target"
  build_app "@symphony-board/desktop-standalone" "$target"
fi

thin_app="$(app_bundle_path "packages/desktop" "Symphony Board" "$target")"
standalone_app="$(app_bundle_path "packages/desktop-standalone" "Symphony Board Standalone" "$target")"
thin_zip="$out_dir/Symphony-Board-v${version}-${label}-unsigned.zip"
standalone_zip="$out_dir/Symphony-Board-Standalone-v${version}-${label}-unsigned.zip"
sum_file="$out_dir/SHA256SUMS-v${version}-${label}.txt"

zip_app "$thin_app" "$thin_zip"
zip_app "$standalone_app" "$standalone_zip"

(
  cd "$out_dir"
  shasum -a 256 "$(basename "$thin_zip")" "$(basename "$standalone_zip")" >"$(basename "$sum_file")"
)

info "wrote $thin_zip"
info "wrote $standalone_zip"
info "wrote $sum_file"
