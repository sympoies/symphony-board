# Provider Links Contract And UI Source

- Status: decisions settled; ready for L2 plan tracking.
- Date: 2026-06-09
- Source: user UI review, current repo docs, current source code, and live
  local `data/contract.json` inspection.
- Intended next step: open an L2 plan-tracking issue from this bundle.

## Execution

- Recommended plan: docs/plans/2026-06-09-provider-links-contract-ui/2026-06-09-provider-links-contract-ui-plan.md
- Recommended execution state: docs/plans/2026-06-09-provider-links-contract-ui/2026-06-09-provider-links-contract-ui-execution-state.md
- Status: decisions settled; plan tracking is the next step.
- Next-task source: this document.

## Problem

The UI exposes useful Activity and Repo Analytics data, but several rows that
read as navigational surfaces are plain text. Repo Analytics repo names do not
link to the provider repo. Activity rows link only when the producer fills
`activities[].url`; commits, item transitions, and reviews generally do, while
pushes, repository events, and GitLab project-event-derived issue/MR/comment
rows often do not.

The work should not ship a UI-only partial fix. The contract, producer URL
semantics, route model, UI, docs, sample contract, and smoke assertions should
move together so the product has one coherent link contract.

## User Decisions

- [U1] Repo Analytics repo names should be linkable.
- [U2] Activity rows such as "push main" should navigate to a useful provider
  destination, such as the GitHub/GitLab commits, compare, branch, or commit
  page for that push.
- [U3] Contract support should be identified clearly and included in the same
  implementation pass; do not first implement only the parts that avoid a
  contract change.
- [U4] The desired execution path is an L2 plan-tracking issue, then one
  complete implementation.

## Confirmed Repository Facts

- [F1] `README.md` defines the product surface as the versioned JSON contract
  plus read-only UI, with raw provider payloads and canonical SQLite rows
  separated from the consumer contract.
- [F2] `docs/CONTRACT.md` documents `activities[]` as timestamped
  developer-significant records with open `kind` / `action`, optional
  `target_*` metadata, `summary`, provider-specific `details`, and a nullable
  `url`.
- [F3] `packages/contract/types.ts` currently defines `RepoMetricDTO` with
  `source_id`, `project_path`, `window`, `totals`, `series`, `top_actors`, and
  `data_quality`; there is no repo URL field.
- [F4] `packages/contract/types.ts` currently defines `ActivityDTO.url` but no
  separate `target_url`.
- [F5] `packages/ui/src/components/ActivityFeed.tsx` already renders the
  activity title as an external anchor when `activity.url` is present.
- [F6] `packages/ui/src/components/RepoAnalyticsPage.tsx` renders the repo name
  as plain text and metric cells as plain numbers.
- [F7] `src/sources/gitlab.ts` normalizes GitLab project events with `url:
  null`, even when the event contains enough repo path / iid / ref / commit
  data to build useful provider destinations.
- [F8] `src/sources/github.ts` normalizes GitHub repository activity rows with
  `url: null`, while commit activity already carries `commit.html_url`.
- [F9] The current local `data/contract.json` is contract `3.1.1`, generated
  on 2026-06-09, with 9,960 activities and 14 repo metric rows.

## Link Coverage Snapshot

Inspection of the current local `data/contract.json` showed:

| Activity kind | Linked rows | Total rows |
| --- | ---: | ---: |
| `commit` | 5,418 | 5,418 |
| `change_request` | 2,806 | 2,984 |
| `issue` | 404 | 447 |
| `review` | 6 | 6 |
| `push` | 0 | 1,029 |
| `comment` | 0 | 56 |
| `repository` | 0 | 20 |

Largest missing URL groups:

| Activity kind/action | Missing rows |
| --- | ---: |
| `push/pushed` | 741 |
| `push/created` | 157 |
| `push/deleted` | 131 |
| `change_request/opened` | 91 |
| `change_request/accepted` | 75 |
| `comment/commented` | 56 |
| `issue/opened` | 24 |
| `issue/closed` | 19 |
| `change_request/closed` | 12 |
| `repository/joined` | 11 |
| `repository/created` | 7 |
| `repository/left` | 2 |

## Decisions

- Treat this as an additive contract pass targeting contract `3.2.0`.
- Add `repo_metrics[].repo_url` as an optional, nullable provider repo URL.
  Repo Analytics should not guess repo roots in UI code when the producer can
  derive canonical provider URLs from `source.host`, `source.kind`, and
  `project_path`.
- Keep using existing `activities[].url` as the primary row destination:
  commit page, issue/PR/MR page, review permalink, compare page, branch/tag
  page, repository page, or final commit page depending on event semantics.
- Add optional `activities[].target_url` only if implementation needs to expose
  a secondary destination distinct from the event's own row URL. It should be
  additive and nullable, and UI support should be conservative.
- Do not synthesize a URL for comments when the raw provider event does not
  expose a reliable comment permalink or an unambiguous target issue/MR URL.
  Preserve `url: null` for these rows until the source can prove the target.
- Make internal drill-down links source-aware. A `project_path` alone is not a
  stable route key because GitHub and GitLab sources may both contain the same
  path.
- Extend URL-backed UI route filters only as far as needed for drill-down:
  source, repo, activity kind/action, and commit branch. Avoid browser-local
  hidden state for links emitted from Repo Analytics.
- Keep automated tests provider-fixture based. Do not hit live provider APIs in
  the implementation tests.

## Link Rules To Implement

Provider repo:

- GitHub repo: `https://<host>/<owner>/<repo>`.
- GitLab project: `https://<host>/<namespace>/<project>`.
- Emit this as `repo_metrics[].repo_url` and use it for Repo Analytics repo
  names and repository activity rows.

Activity rows:

- Existing commit rows keep linking to provider commit URLs.
- Existing item-transition rows keep linking to provider issue/PR/MR URLs.
- Existing review rows keep linking to review permalinks when available, falling
  back to the target change request URL when that is the best available stable
  destination.
- Push rows with both before/from and after/to SHAs should link to the provider
  compare page for that range.
- Push rows for new branches/tags should link to the branch/tag page when the
  ref still exists; otherwise link to `commit_to` when present.
- Push rows for deleted branches/tags should not link to a deleted ref. Link to
  `commit_from` when present; otherwise leave the row unlinked.
- GitLab project-event `issue` and `change_request` rows with a known
  `target_iid` should link to `/-/issues/<iid>` or
  `/-/merge_requests/<iid>`.
- GitLab `change_request/accepted` should link to the merge request page even
  if the action vocabulary remains `accepted`.
- Repository `created`, `joined`, and `left` rows should link to the repo page
  when the project path is known.

## Scope

In scope:

- Contract schema/types/docs/version additions for repo URLs and optional
  secondary activity target URLs.
- Producer URL helpers shared by GitHub/GitLab source normalization and
  contract repo metric emission.
- GitHub repository activity URL emission.
- GitLab project event URL emission.
- UI external links in Repo Analytics and Activity.
- Source-aware route filters and internal drill-down links from Repo Analytics
  to Activity and Commits.
- Sample contract refresh, model tests, source tests, contract tests, UI build,
  and render smoke.

Out of scope:

- Provider write actions.
- UI-triggered provider sync.
- Live provider fetches in automated tests.
- Full comment body retention or unbounded comment/review directories in the
  contract.
- Traffic, views, clone, deployment, or CI-run analytics.
- Replacing the existing Board/Graph relationship deep-link model.

## Acceptance Criteria

- Repo Analytics repo names link to provider repo pages when `repo_url` is
  present, and degrade to plain text when it is absent.
- Repo Analytics metric cells provide internal drill-down links for commits,
  activity, issues, PR/MRs, merged PR/MRs, and reviews without relying on
  ambiguous project-path-only routing.
- Activity rows link for commits, item transitions, reviews, push events, repo
  events, and GitLab issue/MR project events when the target is reliable.
- The implementation avoids false links for ambiguous comments and deleted refs.
- The contract docs explain the difference between row URL, target URL, and repo
  URL.
- The sample contract validates at the new version and render smoke verifies the
  new anchors.

## Validation Plan

- `plan-tooling validate --file docs/plans/2026-06-09-provider-links-contract-ui/2026-06-09-provider-links-contract-ui-plan.md --format text --explain`
- `pnpm run typecheck`
- `pnpm test`
- `pnpm --filter @symphony-board/ui run test`
- `pnpm --filter @symphony-board/ui run build`
- `pnpm run validate --in packages/ui/public/contract.json`
- `pnpm --filter @symphony-board/ui run smoke`
- `git diff --check`
- Optional when source URL helpers change provider fetch shape:
  `node src/cli/sync.ts --dry-run` with configured local tokens, or an explicit
  waiver if tokens/network are unavailable.

## Retention Intent

This plan source is a tracked implementation artifact. Keep it until the plan
is completed and archived; promote only final contract/link semantics into
`docs/CONTRACT.md`, `docs/DESIGN.md`, README surfaces, and devlog.

