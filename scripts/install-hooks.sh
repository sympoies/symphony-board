#!/usr/bin/env bash
#
# Install this repository's lefthook git hooks. Wired as the package `prepare`
# script, so `pnpm install` keeps giving a fresh clone its pre-push gate.
#
# This is a wrapper rather than a bare `lefthook install` because of hosts that
# manage `core.hooksPath` globally (a company-wide commit-msg policy hook, for
# example). lefthook refuses to install while that key is set — whatever it
# points at, including the repository's own hooks directory — and `pnpm`
# records the failed `prepare` as a failed install, so every later
# `pnpm <script>` re-runs the install and fails again. A fresh worktree on such
# a host cannot run the test suite or push at all.
#
# Neither escape lefthook offers is acceptable here (both verified):
#
#   --reset-hooks-path  unsets core.hooksPath, disabling the host's policy hook
#                       for every repository on the machine.
#   --force             writes nothing to .git/hooks and OVERWRITES whatever the
#                       managed hooks directory holds, after which this repo's
#                       pre-push runs in every repository on the machine.
#
# What a chaining host dispatcher actually needs is lefthook's hooks in the
# repository's own hooks directory — exactly where a plain install puts them.
# So hide the global config from lefthook for the duration of the install: the
# hooks land in .git/hooks, the managed path keeps pointing where it did, and
# the dispatcher chains into them on the next push.
#
set -euo pipefail
unset CDPATH

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# `prepare` is invoked with the package's bin directory on PATH; a hand run is
# not, so add it here and the script works either way.
PATH="$repo_root/node_modules/.bin:$PATH"
export PATH

# `prepare` also runs where there is no checkout to install into (a tarball
# install, an image build). Nothing to do, and not an error.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "install-hooks: not a git work tree; skipping hook installation"
  exit 0
fi

if ! command -v lefthook >/dev/null 2>&1; then
  echo "install-hooks: error: lefthook not found on PATH or in node_modules/.bin." >&2
  echo "  Run 'pnpm install' (which invokes this script through 'prepare')." >&2
  exit 1
fi

# A repo-local override is a deliberate choice by whoever set it, and no
# override of ours can work around it. Fail loudly: silently skipping is how a
# pre-push gate disappears without anyone noticing.
if local_path="$(git config --local --get core.hooksPath 2>/dev/null)" && [ -n "$local_path" ]; then
  echo "install-hooks: error: this repository sets core.hooksPath locally ($local_path)." >&2
  echo "  lefthook cannot install while it is set. Unset it with" >&2
  echo "    git config --local --unset core.hooksPath" >&2
  echo "  and re-run 'pnpm install', or install the hooks into that path yourself." >&2
  exit 1
fi

if [ -n "$(git config --get core.hooksPath 2>/dev/null || true)" ]; then
  # Managed from outside the repository. GIT_CONFIG_GLOBAL only affects the
  # lefthook process, so the host's configuration is untouched before and after.
  echo "install-hooks: core.hooksPath is managed outside this repo; installing into the repository hooks dir"
  GIT_CONFIG_GLOBAL=/dev/null exec lefthook install
fi

exec lefthook install
