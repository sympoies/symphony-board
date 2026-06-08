#!/usr/bin/env bash
# Cut and verify the symphony-board public GHCR image release.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/release.sh [options]

Options:
  --execute              Create the GitHub Release. Required for mutation.
  --dry-run              Print the release plan without creating anything.
                         This is the default.
  --verify-only          Only verify published GHCR image tags.
  --version VERSION      SemVer, with or without leading v.
                         Defaults to package.json version.
  --title TITLE          GitHub Release title. Defaults to the tag.
  --prerelease           Mark the GitHub Release as a prerelease and skip
                         latest verification.
  --no-wait              Do not wait for the publish-image workflow.
  --timeout SECONDS      Workflow discovery timeout. Defaults to 120.
  --skip-main-check      Skip branch and origin/main ancestry checks.
  --skip-clean-check     Skip the clean-worktree check.
  --skip-public-verify   Skip anonymous GHCR manifest verification.
  -h, --help             Show this help.

Examples:
  scripts/release.sh --dry-run
  scripts/release.sh --execute --version 0.1.0
  scripts/release.sh --verify-only --version v0.1.0
USAGE
}

die() {
  echo "release: error: $*" >&2
  exit 1
}

info() {
  echo "release: $*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

json_token() {
  python3 -c 'import json, sys
data = json.load(sys.stdin)
print(data.get("token") or data.get("access_token") or "")'
}

json_platforms() {
  python3 -c 'import json, sys
data = json.load(sys.stdin)
items = data.get("manifests") or []
platforms = []
for item in items:
    platform = item.get("platform") or {}
    os = platform.get("os")
    arch = platform.get("architecture")
    if os and arch:
        platforms.append(f"{os}/{arch}")
if not platforms:
    platform = data.get("platform") or {}
    os = platform.get("os")
    arch = platform.get("architecture")
    if os and arch:
        platforms.append(f"{os}/{arch}")
print(" ".join(platforms))'
}

json_matching_run_id() {
  local target_sha="$1"
  JSON_MATCH_TARGET_SHA="$target_sha" python3 -c '
import json
import os
import sys

target_sha = os.environ["JSON_MATCH_TARGET_SHA"]
runs = json.load(sys.stdin)
for run in runs:
    if run.get("headSha") == target_sha:
        print(run.get("databaseId") or "")
        break
'
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

repo_slug_from_git() {
  local remote
  remote="$(git config --get remote.origin.url || true)"
  case "$remote" in
    git@github.com:*.git)
      remote="${remote#git@github.com:}"
      printf '%s\n' "${remote%.git}"
      ;;
    git@github.com:*)
      printf '%s\n' "${remote#git@github.com:}"
      ;;
    https://github.com/*.git)
      remote="${remote#https://github.com/}"
      printf '%s\n' "${remote%.git}"
      ;;
    https://github.com/*)
      printf '%s\n' "${remote#https://github.com/}"
      ;;
    *)
      return 1
      ;;
  esac
}

repo_slug() {
  local slug
  slug="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [ -n "$slug" ]; then
    printf '%s\n' "$slug"
    return 0
  fi
  repo_slug_from_git
}

verify_public_manifest() {
  local image_path="$1"
  local tag="$2"
  local token manifest platforms

  token="$(curl -fsSL \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:${image_path}:pull" |
    json_token)"
  [ -n "$token" ] || die "could not fetch anonymous GHCR pull token for $image_path"

  manifest="$(curl -fsSL \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${image_path}/manifests/${tag}")" ||
    die "anonymous GHCR manifest read failed for ghcr.io/${image_path}:${tag}"

  platforms="$(printf '%s' "$manifest" | json_platforms)"
  case " $platforms " in
    *" linux/amd64 "*) ;;
    *) die "ghcr.io/${image_path}:${tag} missing linux/amd64 platform (platforms: ${platforms:-none})" ;;
  esac
  case " $platforms " in
    *" linux/arm64 "*) ;;
    *) die "ghcr.io/${image_path}:${tag} missing linux/arm64 platform (platforms: ${platforms:-none})" ;;
  esac

  info "verified public GHCR manifest: ghcr.io/${image_path}:${tag} platforms=${platforms}"
}

wait_for_publish_run() {
  local repo="$1"
  local tag="$2"
  local timeout="$3"
  local target_sha="$4"
  local start now run_id run_url runs_json

  start="$(date +%s)"
  while :; do
    runs_json="$(gh run list \
      --repo "$repo" \
      --workflow publish-image.yml \
      --event release \
      --branch "$tag" \
      --limit 20 \
      --json databaseId,headSha,url)"
    run_id="$(printf '%s' "$runs_json" | json_matching_run_id "$target_sha")"
    if [ -n "$run_id" ]; then
      run_url="$(gh run view "$run_id" --repo "$repo" --json url --jq .url)"
      info "publish workflow: $run_url"
      gh run watch "$run_id" --repo "$repo" --exit-status
      return 0
    fi

    now="$(date +%s)"
    if [ $((now - start)) -ge "$timeout" ]; then
      die "publish-image workflow did not appear within ${timeout}s for $tag at $target_sha"
    fi
    sleep 5
  done
}

mode="dry-run"
version=""
title=""
prerelease=0
wait_for_workflow=1
timeout=120
skip_main_check=0
skip_clean_check=0
skip_public_verify=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --execute)
      mode="execute"
      shift
      ;;
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --verify-only)
      mode="verify-only"
      shift
      ;;
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      version="$(normalize_version "$2")"
      shift 2
      ;;
    --title)
      [ "$#" -ge 2 ] || die "--title requires a value"
      title="$2"
      shift 2
      ;;
    --prerelease)
      prerelease=1
      shift
      ;;
    --no-wait)
      wait_for_workflow=0
      shift
      ;;
    --timeout)
      [ "$#" -ge 2 ] || die "--timeout requires a value"
      timeout="$2"
      case "$timeout" in
        '' | *[!0-9]*)
          die "--timeout must be a positive integer"
          ;;
      esac
      [ "$timeout" -gt 0 ] || die "--timeout must be greater than zero"
      shift 2
      ;;
    --skip-main-check)
      skip_main_check=1
      shift
      ;;
    --skip-clean-check)
      skip_clean_check=1
      shift
      ;;
    --skip-public-verify)
      skip_public_verify=1
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

need_command git
need_command gh
need_command curl
need_command node
need_command python3

repo="$(repo_slug)" || die "could not resolve GitHub repository slug"
if [ -z "$version" ]; then
  version="$(normalize_version "$(package_version)")"
fi
tag="v$version"
title="${title:-$tag}"
web_repo="${repo}-web"

if [ "$skip_clean_check" -eq 0 ] && [ "$mode" = "execute" ]; then
  git diff --quiet || die "worktree has unstaged changes"
  git diff --cached --quiet || die "worktree has staged changes"
fi

if [ "$skip_main_check" -eq 0 ] && [ "$mode" = "execute" ]; then
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ "$branch" = "main" ] || die "release must run from main (current: ${branch:-detached})"
  git fetch origin main --quiet
  local_head="$(git rev-parse HEAD)"
  remote_head="$(git rev-parse origin/main)"
  [ "$local_head" = "$remote_head" ] ||
    die "local main is not aligned with origin/main (HEAD=$local_head origin/main=$remote_head)"
fi

info "repo=$repo"
info "tag=$tag"
info "image=ghcr.io/${repo}:${version}"
info "web_image=ghcr.io/${web_repo}:${version}"
if [ "$prerelease" -eq 0 ]; then
  info "latest=ghcr.io/${repo}:latest"
  info "web_latest=ghcr.io/${web_repo}:latest"
fi

if [ "$mode" = "dry-run" ]; then
  info "dry-run: would create GitHub Release $tag titled '$title'"
  info "dry-run: would wait for publish-image.yml and verify public GHCR manifests"
  exit 0
fi

if [ "$mode" = "execute" ]; then
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    die "GitHub Release already exists: $tag"
  fi
  if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    die "remote tag already exists: $tag"
  fi

  target_sha="$(git rev-parse HEAD)"
  args=(release create "$tag" --repo "$repo" --target "$target_sha" --generate-notes --title "$title")
  if [ "$prerelease" -eq 1 ]; then
    args+=(--prerelease)
  fi
  gh "${args[@]}"
  release_url="$(gh release view "$tag" --repo "$repo" --json url --jq .url)"
  info "created GitHub Release: $release_url"

  if [ "$wait_for_workflow" -eq 1 ]; then
    wait_for_publish_run "$repo" "$tag" "$timeout" "$target_sha"
  else
    info "skipped workflow wait"
    if [ "$skip_public_verify" -eq 0 ]; then
      info "skipped public GHCR verification because --no-wait was set; run --verify-only after publish-image completes"
      skip_public_verify=1
    fi
  fi
fi

if [ "$skip_public_verify" -eq 0 ]; then
  verify_public_manifest "$repo" "$version"
  verify_public_manifest "$web_repo" "$version"
  if [ "$prerelease" -eq 0 ]; then
    verify_public_manifest "$repo" "latest"
    verify_public_manifest "$web_repo" "latest"
  fi
else
  info "skipped public GHCR verification"
fi

info "complete"
