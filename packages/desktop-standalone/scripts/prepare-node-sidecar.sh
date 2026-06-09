#!/usr/bin/env bash
# Copy the active Node 24 runtime in as the Tauri sidecar binary
# (src-tauri/binaries/node-<host-target-triple>). Tauri bundles it as
# Contents/MacOS/node next to the app executable, where main.rs finds it.
#
# The backend runs TypeScript directly under Node 24 type stripping with
# node:sqlite built in, so the runtime binary plus the bundled source tree is
# the whole backend — no build step, no node_modules.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "prepare-node-sidecar: node not found on PATH (fnm use; see .node-version)" >&2
  exit 1
fi
node_bin="$(command -v node)"
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "prepare-node-sidecar: need Node >= 24, have $(node --version) (fnm use)" >&2
  exit 1
fi

triple="$(rustc -vV | awk '/^host:/ {print $2}')"
if [ -z "$triple" ]; then
  echo "prepare-node-sidecar: could not determine host target triple from rustc" >&2
  exit 1
fi

mkdir -p src-tauri/binaries
cp -f "$node_bin" "src-tauri/binaries/node-$triple"
chmod +x "src-tauri/binaries/node-$triple"
echo "prepare-node-sidecar: node $(node --version) -> src-tauri/binaries/node-$triple"
