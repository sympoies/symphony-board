#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  project-rebuild-open-standalone-app.sh [options]

Options:
  --no-install       Build only; open the built bundle in place.
  --no-open          Build/install without opening the app.
  --wait-seconds N   Seconds to wait before checking the process (default: 3).
  -h, --help         Show this help.
USAGE
}

install_app=1
open_app=1
wait_seconds=3

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --no-install)
      install_app=0
      shift
      ;;
    --no-open)
      open_app=0
      shift
      ;;
    --wait-seconds)
      if [ "$#" -lt 2 ] || ! [[ "${2:-}" =~ ^[0-9]+$ ]]; then
        echo "error: --wait-seconds requires a non-negative integer" >&2
        usage >&2
        exit 2
      fi
      wait_seconds="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  repo_root="$(cd "$script_dir/../../../.." && pwd)"
fi

cd "$repo_root"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: this helper installs/opens a macOS .app bundle and requires Darwin" >&2
  exit 1
fi

if ! command -v fnm >/dev/null 2>&1; then
  echo "error: fnm is required; this repo builds with Node from .node-version" >&2
  exit 1
fi

if ! command -v rustc >/dev/null 2>&1; then
  echo "error: rustc is required; the standalone build bundles the host-triple Node sidecar" >&2
  exit 1
fi

app_src="$repo_root/packages/desktop-standalone/src-tauri/target/release/bundle/macos/Symphony Board Standalone.app"
app_dst="/Applications/Symphony Board Standalone.app"
app_to_open="$app_src"

stop_installed_sidecar() {
  local pattern='Symphony Board Standalone\.app/Contents/MacOS/node .*backend/src/cli/app-server\.ts'
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  printf '[rebuild-open-standalone-app] stopping stale standalone sidecar(s): %s\n' "$(echo "$pids" | tr '\n' ' ')"
  # The sidecar can outlive the Tauri shell during local rebuilds; if it keeps
  # port 8787 open the new app adopts the stale server instead of the fresh one.
  kill $pids 2>/dev/null || true
  for _ in {1..20}; do
    if ! pgrep -f "$pattern" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  kill -9 $pids 2>/dev/null || true
}

printf '[rebuild-open-standalone-app] building standalone desktop bundle\n'
fnm exec --using 24 pnpm desktop-standalone:build

if [ ! -d "$app_src" ]; then
  echo "error: expected built app bundle was not found: $app_src" >&2
  exit 1
fi

if [ "$install_app" -eq 1 ]; then
  printf '[rebuild-open-standalone-app] installing %s\n' "$app_dst"
  osascript -e 'quit app "Symphony Board Standalone"' >/dev/null 2>&1 || true
  stop_installed_sidecar
  rm -rf "$app_dst"
  cp -R "$app_src" "$app_dst"
  touch "$app_dst"
  app_to_open="$app_dst"
else
  printf '[rebuild-open-standalone-app] skipping install; using built bundle\n'
fi

if [ "$open_app" -eq 1 ]; then
  printf '[rebuild-open-standalone-app] opening %s\n' "$app_to_open"
  if ! open "$app_to_open"; then
    printf '[rebuild-open-standalone-app] open failed; retrying with a fresh app instance\n'
    sleep 2
    open -n "$app_to_open"
  fi
  sleep "$wait_seconds"

  if pgrep -fl 'symphony-board-desktop-standalone|Symphony Board Standalone' >/dev/null; then
    printf '[rebuild-open-standalone-app] app process detected\n'
  else
    echo "error: app process was not detected after open" >&2
    exit 1
  fi
else
  printf '[rebuild-open-standalone-app] skipping open\n'
fi

printf '[rebuild-open-standalone-app] done\n'
