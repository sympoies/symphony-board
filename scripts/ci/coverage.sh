#!/usr/bin/env bash
# Combined line-coverage gate for the monorepo. Mirrors nils-cli's
# `cargo llvm-cov --fail-under-lines`: collect coverage, emit one merged LCOV
# (consumed by coverage-badge.sh / coverage-summary.sh), and FAIL when the
# combined line % is below the floor.
#
# What counts toward the number (deliberately — see docs/DESIGN.md / README):
#   * backend root package — every `src/**/*.ts`, incl. the thin CLI entrypoints
#     and glue (counted honestly as 0% when untested, so they pull the number
#     down rather than hide).
#   * UI package — only the pure `.ts` view-model (model / viewconfig /
#     spotlight / contract). The `.tsx` COMPONENT layer is NOT a coverage % here:
#     V8 coverage of the Vite bundle remaps to ~100%-if-loaded (meaningless), so
#     the components are gated by the headless `render-smoke` (a hard pass/fail
#     CI check) instead.
#
# c8 runs under the repo's pinned Node (via node_modules), NOT via `pnpm exec`
# (some local pnpm installs resolve a different Node major).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FLOOR="${COVERAGE_FAIL_UNDER_LINES:-85}"
C8=(node "$ROOT/node_modules/c8/bin/c8.js")
NODE_TEST=(node --disable-warning=ExperimentalWarning --test)

rm -rf coverage
mkdir -p coverage

echo "==> backend coverage (src/**/*.ts, incl. CLI/glue)"
# `*/types.ts` and `src/db/store.ts` are pure type-declaration modules (no
# executable code) — c8 --all would otherwise count their lines as 0%, an
# artifact rather than a real gap. `src/db/postgres.ts` IS executable, but its
# gate is the live-Postgres run (scripts/ci/pg-e2e.sh: the conformance suite
# with the pg driver registered + test/e2e/pg-live.test.ts, the CI `pg` job) —
# this Docker-free default run would count it 0% as an artifact of the
# environment, the same reasoning that keeps `.tsx` with render-smoke.
"${C8[@]}" --all --src src -n 'src/**/*.ts' -x 'src/**/*.d.ts' \
  -x 'src/model/types.ts' -x 'src/sources/types.ts' -x 'src/db/store.ts' \
  -x 'src/db/postgres.ts' \
  --reporter=lcovonly --report-dir=coverage/backend \
  "${NODE_TEST[@]}" test/*.test.ts

echo "==> ui view-model coverage (src/**/*.ts only — .tsx is render-smoke's gate)"
( cd packages/ui && "${C8[@]}" --all --src src -n 'src/**/*.ts' -x 'src/**/*.d.ts' \
  --reporter=lcovonly --report-dir="$ROOT/coverage/ui" \
  "${NODE_TEST[@]}" test/*.test.ts )

# One merged LCOV: the badge + summary + gate all read this.
cat coverage/backend/lcov.info coverage/ui/lcov.info > coverage/lcov.info

# Combined line gate. awk sums LH/LF across every SF record (both packages).
awk -F: -v floor="$FLOOR" '
  $1 == "LH" { lh += $2 }
  $1 == "LF" { lf += $2 }
  END {
    pct = (lf == 0) ? 0 : (lh / lf) * 100
    printf "==> combined line coverage: %.2f%% (%d/%d), floor %.2f%%\n", pct, lh, lf, floor
    if (pct + 1e-9 < floor) {
      printf "coverage gate FAILED: %.2f%% < %.2f%%\n", pct, floor > "/dev/stderr"
      exit 1
    }
    print "coverage gate PASSED"
  }
' coverage/lcov.info
