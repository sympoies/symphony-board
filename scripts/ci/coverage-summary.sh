#!/usr/bin/env bash
# Emit a Markdown coverage summary (total + worst-covered files) from an LCOV
# file. Written to $GITHUB_STEP_SUMMARY (and posted as a sticky PR comment by
# CI). Adapted from nils-cli with a per-file breakdown. LCOV-generic.
set -euo pipefail

lcov_path="${1:-coverage/lcov.info}"
summary_path="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

write_summary() {
  cat >>"$summary_path"
}

if [[ ! -f "$lcov_path" ]]; then
  write_summary <<EOF
## Coverage

Coverage summary unavailable (missing \`$lcov_path\`).
EOF
  exit 0
fi

read -r total_lh total_lf < <(
  awk -F: '
    $1 == "LH" { lh += $2 }
    $1 == "LF" { lf += $2 }
    END { printf "%d %d\n", lh, lf }
  ' "$lcov_path"
)

percent="$(
  awk -v lh="$total_lh" -v lf="$total_lf" 'BEGIN {
    if (lf == 0) { print "0.00"; exit }
    printf "%.2f", (lh / lf) * 100
  }'
)"

# Per-file rows, worst coverage first (the actionable part for reviewers).
rows="$(
  awk -F: '
    $1 == "SF" { f = $2 }
    $1 == "LF" { lf[f] = $2 }
    $1 == "LH" { lh[f] = $2 }
    END {
      for (k in lf) {
        p = (lf[k] == 0) ? 100 : (lh[k] / lf[k]) * 100
        printf "%012.4f\t%s\t%d\t%d\t%.1f\n", p, k, lh[k], lf[k], p
      }
    }
  ' "$lcov_path" | sort | awk -F'\t' '{ printf "| `%s` | %d/%d | %s%% |\n", $2, $3, $4, $5 }'
)"

write_summary <<EOF
## Coverage

Combined line coverage: **$percent%** ($total_lh/$total_lf lines hit).

> The badge / gate measure the **logic layer** (backend \`src/**/*.ts\` + the UI
> \`.ts\` view-model). The \`.tsx\` component layer is gated by the headless
> \`render-smoke\` (a pass/fail CI check), not folded into this %.

<details><summary>Per-file (worst first)</summary>

| File | Lines | Coverage |
| --- | --- | --- |
$rows

</details>
EOF
