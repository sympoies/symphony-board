#!/usr/bin/env bash
# POST a repository_dispatch to a downstream repo and require GitHub to accept
# it.
#
# The point of this script is the status assertion. `curl -f` fails only on
# 4xx/5xx, so a 3xx exits 0 — and 3xx is exactly what GitHub returns for a
# repository that has been renamed or transferred. A downstream repo that moved
# therefore turned every release dispatch into a silent no-op while the workflow
# step went green. That is how the symphony-board deployment sat two releases
# behind with nothing failing anywhere.
#
#   Usage : printf '%s' "$payload" | dispatch-release.sh <owner/repo>
#   Env   : DISPATCH_TOKEN  token with write access to <owner/repo>
#
set -euo pipefail

repo="${1:-}"
if [ -z "$repo" ]; then
  echo "usage: dispatch-release.sh <owner/repo> (payload on stdin)" >&2
  exit 2
fi
case "$repo" in
  */*) ;;
  *) echo "dispatch target must be owner/repo, got '$repo'" >&2; exit 2 ;;
esac
if [ -z "${DISPATCH_TOKEN:-}" ]; then
  echo "DISPATCH_TOKEN is required to dispatch to $repo" >&2
  exit 2
fi

payload="$(cat)"
if [ -z "$payload" ]; then
  echo "no dispatch payload on stdin" >&2
  exit 2
fi

# `-w %{http_code}` already prints 000 when curl never connects, and curl then
# exits non-zero. Appending another fallback here would concatenate a SECOND
# 000 and yield "000000", matching nothing — so swallow the status and
# normalise only genuinely empty output.
status="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $DISPATCH_TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${repo}/dispatches" \
    -d "$payload" 2>/dev/null
)" || true
[ -n "$status" ] || status=000

if [ "$status" = 204 ]; then
  echo "dispatched to $repo (HTTP 204)"
  exit 0
fi

echo "dispatch to $repo returned HTTP $status, expected 204" >&2
case "$status" in
  3??)
    echo "a 3xx means that repository was renamed or transferred; the dispatch" >&2
    echo "was NOT delivered. Point the dispatch repository variable at its" >&2
    echo "current owner/name." >&2
    ;;
  401 | 403 | 404)
    echo "check that the dispatch token still has write access to $repo." >&2
    ;;
  000)
    echo "no HTTP response at all — the request never reached GitHub." >&2
    ;;
esac
exit 1
