#!/usr/bin/env bash
# Seed a throwaway GitHub fixture repo with issues + PRs spanning every state and
# edge lifecycle the contract models, so the UI can be reviewed against real
# pipeline output:
#
#   items:  open / closed / merged
#   edges:  declared (open PR closes open issue)   -> "in progress"
#           fulfilled (merged PR closed its issue)
#           broken    (closed-unmerged PR referenced an open issue)
#   plus: scoped + plain labels, a draft PR.
#
# Requires: gh (authenticated). Run once against a FRESH repo:
#   scripts/fixtures/seed-github-fixture.sh [owner/repo]   (default: graysurf/symphony-board-fixture)
set -euo pipefail

REPO="${1:-graysurf/symphony-board-fixture}"
echo "seeding $REPO ..."

num() { grep -oE '[0-9]+$'; }  # extract the trailing #N from a gh-printed URL

# --- labels ---------------------------------------------------------------
gh label create bug              --repo "$REPO" --color d73a4a --description "Something is broken"  --force >/dev/null
gh label create enhancement      --repo "$REPO" --color a2eeef --description "New capability"        --force >/dev/null
gh label create "priority::high" --repo "$REPO" --color b60205 --description "Scoped: priority high" --force >/dev/null
gh label create "priority::low"  --repo "$REPO" --color 0e8a16 --description "Scoped: priority low"  --force >/dev/null

# --- issues (numbered first; issues and PRs share the numbering) -----------
i_abandon=$(gh issue create --repo "$REPO" --title "Rate-limit handling drops requests" --body "Edge fails under load." --label bug | num)
i_fixed=$(gh issue create --repo "$REPO" --title "Crash on an empty config file" --body "Null deref when sources is empty." --label bug | num)
i_progress=$(gh issue create --repo "$REPO" --title "Add CSV export of the board" --body "Users want a CSV dump." --label enhancement --label "priority::high" | num)
i_doc=$(gh issue create --repo "$REPO" --title "Document the contract envelope" --body "Write CONTRACT.md examples." --label enhancement --label "priority::low" | num)
i_closed=$(gh issue create --repo "$REPO" --title "Support SVN sources" --body "Out of scope." | num)
i_open=$(gh issue create --repo "$REPO" --title "Investigate intermittent CI flake" --body "Happens ~1/20 runs." --label bug | num)
gh issue close "$i_closed" --repo "$REPO" --reason "not planned" >/dev/null
echo "issues: abandon=#$i_abandon fixed=#$i_fixed progress=#$i_progress doc=#$i_doc closed=#$i_closed open=#$i_open"

# --- a local clone to push PR branches ------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gh repo clone "$REPO" "$TMP" -- -q
cd "$TMP"
DEFAULT="$(git branch --show-current)"

mkpr_branch() { # <branch> <file> <content> <commit-msg>
  git checkout -q "$DEFAULT"
  git checkout -qB "$1"
  printf '%s\n' "$3" > "$2"
  git add "$2"
  git commit -qm "$4"
  git push -q -u origin "$1"
}

# fulfilled: merge a PR that closes i_fixed
mkpr_branch fix-fulfilled fix-config.txt "guard empty config" "fix: guard empty config"
pr_ful=$(gh pr create --repo "$REPO" --base "$DEFAULT" --head fix-fulfilled \
  --title "Guard against an empty config" --body "Closes #$i_fixed" --label bug | num)
gh pr merge "$pr_ful" --repo "$REPO" --merge >/dev/null

# declared (in progress): open PR closes the open i_progress, left open
mkpr_branch feat-declared csv-export.txt "wip csv export" "feat: start CSV export"
pr_dec=$(gh pr create --repo "$REPO" --base "$DEFAULT" --head feat-declared \
  --title "Implement CSV export" --body "Closes #$i_progress" --label enhancement --label "priority::high" | num)

# declared via a DRAFT PR closing i_doc (exercises is_draft)
mkpr_branch docs-draft contract-examples.txt "draft docs" "docs: contract examples (draft)"
pr_draft=$(gh pr create --repo "$REPO" --base "$DEFAULT" --head docs-draft \
  --title "Document the contract (WIP)" --body "Closes #$i_doc" --draft --label "priority::low" | num)

# broken: a PR that referenced i_abandon, then closed unmerged
mkpr_branch fix-broken ratelimit.txt "abandoned attempt" "fix: rate-limit (abandoned)"
pr_brk=$(gh pr create --repo "$REPO" --base "$DEFAULT" --head fix-broken \
  --title "Abandoned rate-limit fix" --body "Closes #$i_abandon" --label bug | num)
gh pr close "$pr_brk" --repo "$REPO" >/dev/null

echo "PRs: fulfilled=#$pr_ful(merged) declared=#$pr_dec(open) draft=#$pr_draft(draft) broken=#$pr_brk(closed)"
echo "done. expected lifecycles: fulfilled(1) declared(2) broken(0-1, depends on GitHub keeping closingIssuesReferences on a closed PR)"
