#!/usr/bin/env bash
# Install a downloaded, unsigned symphony-board macOS release (.zip or .app).
#
# The GitHub Release assets are intentionally unsigned and un-notarized (their
# names end in -unsigned.zip; the bundles carry only an adhoc signature), so
# macOS quarantines them on download and Gatekeeper refuses to open them. This
# script strips the quarantine flag (recursively, so an embedded sidecar binary
# is cleared too), installs the bundle into /Applications, and opens it.
#
# Handles both desktop variants identically:
#   - thin client   "Symphony Board.app"            (needs a running backend)
#   - standalone     "Symphony Board Standalone.app" (self-contained)

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-release-app.sh [PATH] [options]

PATH:
  Path to a downloaded release .zip or an extracted .app. When omitted, the
  newest "Symphony-Board-*.zip" or "Symphony Board*.app" in ~/Downloads is used.

Options:
  --no-install           Do not copy into /Applications; prepare and open the
                         bundle where it is (a .zip is extracted beside itself).
  --no-open              Prepare/install only; do not open the app.
  --resign               Re-apply an adhoc signature (codesign --force --deep
                         --sign -) after stripping quarantine. Use only if the
                         app reports "is damaged"; not needed in the common case.
  --downloads-dir DIR    Directory to auto-discover from. Defaults to ~/Downloads.
  -h, --help             Show this help.

Examples:
  scripts/install-release-app.sh
  scripts/install-release-app.sh ~/Downloads/Symphony-Board-v1.1.0-macos-arm64-unsigned.zip
  scripts/install-release-app.sh "~/Downloads/Symphony Board.app" --no-install
USAGE
}

die() {
  echo "install-release-app: error: $*" >&2
  exit 1
}

info() {
  echo "install-release-app: $*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

input=""
downloads_dir="$HOME/Downloads"
do_install=1
do_open=1
do_resign=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-install)
      do_install=0
      shift
      ;;
    --no-open)
      do_open=0
      shift
      ;;
    --resign)
      do_resign=1
      shift
      ;;
    --downloads-dir)
      [ "$#" -ge 2 ] || die "--downloads-dir requires a value"
      downloads_dir="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      [ -z "$input" ] || die "unexpected extra argument: $1"
      input="$1"
      shift
      ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "macOS is required for .app install behavior"

need_command ditto
need_command xattr
need_command open
need_command /usr/libexec/PlistBuddy
if [ "$do_resign" -eq 1 ]; then
  need_command codesign
fi

# Resolve the input: explicit PATH, or the newest matching artifact in the
# downloads directory.
if [ -z "$input" ]; then
  [ -d "$downloads_dir" ] || die "downloads dir not found: $downloads_dir"
  newest=""
  newest_mtime=0
  while IFS= read -r -d '' candidate; do
    mtime="$(stat -f '%m' "$candidate")"
    if [ "$mtime" -gt "$newest_mtime" ]; then
      newest_mtime="$mtime"
      newest="$candidate"
    fi
  done < <(find "$downloads_dir" -maxdepth 1 \
    \( -name 'Symphony-Board-*.zip' -o -iname 'Symphony Board*.app' \) -print0)
  [ -n "$newest" ] ||
    die "no Symphony-Board-*.zip or Symphony Board*.app found in $downloads_dir; pass a PATH"
  input="$newest"
  info "auto-selected newest artifact: $input"
fi

[ -e "$input" ] || die "input not found: $input"

# Materialize a real .app directory (source_app), extracting a .zip if needed.
staging=""
cleanup() {
  if [ -n "$staging" ]; then
    rm -rf "$staging"
  fi
}
trap cleanup EXIT

case "$input" in
  *.zip)
    [ -f "$input" ] || die "not a file: $input"
    staging="$(mktemp -d "${TMPDIR:-/tmp}/symphony-install.XXXXXX")"
    info "extracting $input"
    ditto -x -k "$input" "$staging"
    source_app="$(find "$staging" -maxdepth 2 -name '*.app' -type d | head -1)"
    [ -n "$source_app" ] || die "no .app found inside $input"
    ;;
  *.app)
    [ -d "$input" ] || die "not an app bundle: $input"
    source_app="$input"
    ;;
  *)
    die "unsupported input (expected a .zip or .app): $input"
    ;;
esac

app_name="$(basename "$source_app")"

# Decide where the bundle we operate on / open will live.
if [ "$do_install" -eq 1 ]; then
  final_app="/Applications/$app_name"
  if [ "$source_app" != "$final_app" ]; then
    info "installing to $final_app"
    rm -rf "$final_app"
    ditto "$source_app" "$final_app"
  fi
elif [ -n "$staging" ]; then
  # --no-install on a .zip: persist the extracted app beside the zip.
  final_app="$(cd "$(dirname "$input")" && pwd)/$app_name"
  if [ "$source_app" != "$final_app" ]; then
    info "extracting in place to $final_app"
    rm -rf "$final_app"
    ditto "$source_app" "$final_app"
  fi
else
  # --no-install on an .app: operate in place.
  final_app="$source_app"
fi

info "clearing quarantine on $final_app"
xattr -dr com.apple.quarantine "$final_app" 2>/dev/null || true

if [ "$do_resign" -eq 1 ]; then
  info "re-applying adhoc signature"
  codesign --force --deep --sign - "$final_app"
fi

# Identify the variant for an accurate post-install note.
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$final_app/Contents/Info.plist" 2>/dev/null || true)"
case "$bundle_id" in
  *.standalone)
    info "variant: standalone (self-contained; bundled daemon + SQLite)"
    info "  data lives under ~/Library/Application Support/com.sympoies.symphony-board.standalone/"
    ;;
  com.sympoies.symphony-board)
    info "variant: thin client"
    info "  it connects to a running symphony-board server (default http://localhost:8080/);"
    info "  start the Docker stack or set the server under Settings -> Server, or it shows nothing."
    ;;
  *)
    info "variant: unknown bundle id '${bundle_id:-<none>}'"
    ;;
esac

if [ "$do_open" -eq 1 ]; then
  info "opening $final_app"
  open "$final_app"
else
  info "ready: $final_app"
fi
