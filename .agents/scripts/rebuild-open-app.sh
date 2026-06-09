#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$repo_root/.agents/skills/project-rebuild-open-app/scripts/project-rebuild-open-app.sh" "$@"
