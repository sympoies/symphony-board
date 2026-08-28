#!/usr/bin/env bash
# POST a repository_dispatch to a downstream repo and require GitHub to accept
# it. When a workflow/name expectation is supplied, also require the correlated
# downstream run to finish successfully.
#
# The point of this script is the status assertion. `curl -f` fails only on
# 4xx/5xx, so a 3xx exits 0 — and 3xx is exactly what GitHub returns for a
# repository that has been renamed or transferred. A downstream repo that moved
# therefore turned every release dispatch into a silent no-op while the workflow
# step went green. That is how the symphony-board deployment sat two releases
# behind with nothing failing anywhere.
#
#   Usage : printf '%s' "$payload" | dispatch-release.sh <owner/repo>
#   Env   : DISPATCH_TOKEN             token with dispatch and Actions read access
#           DISPATCH_EXPECT_WORKFLOW    downstream workflow file name (optional)
#           DISPATCH_EXPECT_RUN_NAME    exact correlated run name (paired)
#           DISPATCH_EXPECT_TIMEOUT_SECONDS (default 1200)
#           DISPATCH_EXPECT_POLL_SECONDS    (default 5)
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

expect_workflow="${DISPATCH_EXPECT_WORKFLOW:-}"
expect_run_name="${DISPATCH_EXPECT_RUN_NAME:-}"
if [ -n "$expect_workflow" ] || [ -n "$expect_run_name" ]; then
  if [ -z "$expect_workflow" ] || [ -z "$expect_run_name" ]; then
    echo "DISPATCH_EXPECT_WORKFLOW and DISPATCH_EXPECT_RUN_NAME must be set together" >&2
    exit 2
  fi
  case "$expect_workflow" in
    *[!A-Za-z0-9._-]*)
      echo "DISPATCH_EXPECT_WORKFLOW must be a workflow file name" >&2
      exit 2
      ;;
  esac
  command -v jq >/dev/null || {
    echo "jq is required when downstream workflow observation is enabled" >&2
    exit 2
  }
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
else
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
fi

if [ -z "$expect_workflow" ]; then
  exit 0
fi

timeout_seconds="${DISPATCH_EXPECT_TIMEOUT_SECONDS:-1200}"
poll_seconds="${DISPATCH_EXPECT_POLL_SECONDS:-5}"
case "$timeout_seconds:$poll_seconds" in
  *[!0-9:]* | :* | *:)
    echo "dispatch observation timeout and poll values must be non-negative integers" >&2
    exit 2
    ;;
esac

response="$(mktemp)"
trap 'rm -f "$response"' EXIT
deadline=$((SECONDS + timeout_seconds))
observed_run_id=""

while :; do
  runs_status="$(
    curl -sS -o "$response" -w '%{http_code}' \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer $DISPATCH_TOKEN" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${repo}/actions/workflows/${expect_workflow}/runs?event=repository_dispatch&per_page=100" \
      2>/dev/null
  )" || true
  [ -n "$runs_status" ] || runs_status=000
  if [ "$runs_status" != 200 ]; then
    echo "downstream workflow lookup returned HTTP $runs_status, expected 200" >&2
    echo "check that the dispatch token can read Actions runs in $repo." >&2
    exit 1
  fi

  match="$(
    jq -c --arg title "$expect_run_name" '
      .workflow_runs
      | map(select(.event == "repository_dispatch" and .display_title == $title))
      | first // empty
    ' "$response"
  )"
  if [ -n "$match" ]; then
    run_id="$(jq -r '.id' <<<"$match")"
    run_status="$(jq -r '.status' <<<"$match")"
    conclusion="$(jq -r '.conclusion // ""' <<<"$match")"
    run_url="$(jq -r '.html_url' <<<"$match")"
    if [ "$run_id" != "$observed_run_id" ]; then
      echo "observed downstream workflow run: $run_url"
      observed_run_id="$run_id"
    fi
    if [ "$run_status" = completed ]; then
      if [ "$conclusion" = success ]; then
        echo "downstream workflow completed successfully: $run_url"
        exit 0
      fi
      echo "downstream workflow concluded ${conclusion:-without a conclusion}: $run_url" >&2
      exit 1
    fi
  fi

  if (( SECONDS >= deadline )); then
    echo "matching downstream workflow run was not observed successfully before timeout: $expect_run_name" >&2
    exit 1
  fi
  sleep "$poll_seconds"
done
