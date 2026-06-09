# Plan: Provider Links Contract And UI

## Overview

Add a coherent provider-link contract and UI pass for Activity and Repo
Analytics. The implementation should make useful provider destinations available
from the producer, expose the needed additive contract fields, and render both
external provider links and source-aware internal drill-down links in the UI.

This is not a UI-only patch. Contract, producer, routing, UI, docs, sample
contract, and smoke coverage should land together.

## Read First

- Primary source: docs/plans/2026-06-09-provider-links-contract-ui/2026-06-09-provider-links-contract-ui-discussion-source.md
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope

- In scope:
  - Add optional contract fields for provider repo URLs and, if needed, a
    secondary activity target URL.
  - Bump the contract minor version and update docs/schema/types.
  - Emit canonical repo URLs for `repo_metrics[]`.
  - Emit Activity row URLs for reliable GitHub repository activity and GitLab
    project event destinations.
  - Preserve null URLs where a provider event is ambiguous.
  - Add source-aware UI route parameters and filters for Activity and Commits
    drill-down links.
  - Link Repo Analytics repo names externally and metric cells internally.
  - Extend model tests, source tests, contract tests, sample contract, and render
    smoke.
- Out of scope:
  - Provider write actions.
  - UI-triggered sync control.
  - Live provider calls in automated tests.
  - Full comment/review text retention.
  - Traffic/views/clones/deployment analytics.

## Assumptions

1. Contract `3.2.0` can be additive because new fields are optional or nullable.
2. The producer can derive repo root URLs from `source.kind`, `source.host`, and
   `project_path` without storing new DB columns.
3. Activity row `url` remains the primary click destination. A separate
   `target_url` is added only when the implementation needs a secondary
   destination distinct from the row URL.
4. Comments stay unlinked unless source fixtures prove a reliable permalink or
   target issue/MR URL.
5. Source-aware internal links should not break existing hash routes; older
   route URLs with only `repo` continue to work as best-effort filters.

## Sprint 1: Contract And Producer Link Semantics

**Goal**: Freeze additive link fields and make reliable provider destinations
available in emitted contracts.
**PR grouping intent**: `group`
**Execution Profile**: `serial`
**Demo/Validation**:
- Command(s): `pnpm run typecheck && pnpm test`
- Verify: contract version, schema, type, and source fixture tests cover repo
  URLs and activity URL emission without live provider calls.

### Task 1.1: Define additive contract link fields

- **Location**:
  - `docs/CONTRACT.md`
  - `docs/DESIGN.md`
  - `README.md`
  - `packages/contract/types.ts`
  - `packages/contract/contract.schema.json`
  - `packages/contract/README.md`
  - `src/contract/version.ts`
- **Description**: Add optional provider-link fields to the contract, bump the
  contract minor version, and document link semantics for repo URLs, Activity
  row URLs, and optional secondary target URLs.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - `repo_metrics[].repo_url` is optional or nullable and documented as the
    canonical provider repo page.
  - `activities[].target_url` is added only if implementation needs a secondary
    destination and is optional or nullable.
  - `activities[].url` remains the primary row click destination.
  - Contract versioning follows `docs/CONTRACT.md` additive minor rules.
  - Older consumers can ignore the new fields.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`

### Task 1.2: Add provider URL helpers and repo metric URLs

- **Location**:
  - `src/contract/build.ts`
  - `src/sources/types.ts`
  - `src/sources/github.ts`
  - `src/sources/gitlab.ts`
  - `test/contract.test.ts`
  - `test/repo-metrics.test.ts`
- **Description**: Add shared helpers for provider repo, issue, change request,
  commit, compare, branch, and tag URLs where the provider kind and host make
  the destination deterministic. Use the helpers to emit `repo_url` in repo
  metric rows.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 5
- **Acceptance criteria**:
  - GitHub and GitLab repo metric rows carry provider repo URLs when
    `project_path` is known.
  - Unknown or malformed project paths leave `repo_url` null instead of
    inventing a broken URL.
  - URL construction handles nested GitLab namespaces.
  - Tests cover GitHub, GitLab.com, and self-hosted GitLab hosts.
- **Validation**:
  - `pnpm test`
  - `pnpm run typecheck`

### Task 1.3: Emit Activity URLs for reliable event destinations

- **Location**:
  - `src/sources/github.ts`
  - `src/sources/gitlab.ts`
  - `src/model/activity.ts`
  - `test/sources.test.ts`
  - `test/contract.test.ts`
- **Description**: Populate `activities[].url` for reliable provider event
  destinations: GitHub repository activity, GitLab push events, GitLab issue
  and merge-request project events, and repository-level events. Preserve null
  URLs for ambiguous comments and deleted refs without a commit fallback.
- **Dependencies**:
  - Task 1.2
- **Complexity**: 6
- **Acceptance criteria**:
  - Push rows with before/from and after/to SHAs link to provider compare pages.
  - New branch/tag rows link to a ref page or commit fallback.
  - Deleted branch/tag rows link to the last commit when present and never link
    to a deleted ref.
  - GitLab issue and merge-request events with known `target_iid` link to the
    provider item page.
  - Repository events link to repo pages when the project path is known.
  - Comment events remain unlinked unless fixtures prove a reliable target.
- **Validation**:
  - `pnpm test`
  - `pnpm run typecheck`

### Task 1.4: Refresh sample contract and contract documentation

- **Location**:
  - `packages/ui/public/contract.json`
  - `docs/CONTRACT.md`
  - `docs/DESIGN.md`
  - `README.md`
  - `packages/contract/README.md`
- **Description**: Re-emit or update the sample contract so UI tests and smoke
  can exercise the new link fields, and keep documentation aligned with the
  shipped semantics.
- **Dependencies**:
  - Task 1.3
- **Complexity**: 3
- **Acceptance criteria**:
  - Sample contract validates at the new version.
  - Docs describe which Activity categories link and which intentionally do not.
  - Docs distinguish provider repo URL, Activity row URL, and optional target
    URL.
  - No secrets, local config, SQLite DBs, or runtime data are committed.
- **Validation**:
  - `pnpm run validate --in packages/ui/public/contract.json`
  - `git diff --check`

## Sprint 2: Source-Aware UI Links And Drill-Down

**Goal**: Render external provider links and internal drill-down routes without
ambiguous project-path-only filters.
**PR grouping intent**: `group`
**Execution Profile**: `serial`
**Demo/Validation**:
- Command(s): `pnpm --filter @symphony-board/ui run test && pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke`
- Verify: Repo Analytics repo names and metric cells link correctly, and
  Activity/Commits route filters are source-aware.

### Task 2.1: Extend hash routes for source-aware drill-down

- **Location**:
  - `packages/ui/src/model.ts`
  - `packages/ui/src/App.tsx`
  - `packages/ui/src/components/Controls.tsx`
  - `packages/ui/test/model.test.ts`
- **Description**: Extend the hash route model so Activity and Commits can be
  opened with source, repo, activity kind/action, and branch filters from
  internal links. Preserve existing route behavior where practical.
- **Dependencies**:
  - Task 1.4
- **Complexity**: 5
- **Acceptance criteria**:
  - Commits filtering can distinguish two sources with the same `project_path`.
  - Activity drill-down can filter by source, repo, kind, and action from the
    URL.
  - Existing `#/commits?repo=<project_path>` links still behave as best-effort
    filters.
  - Search, range, visibility, and settings behavior remain unchanged.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm run typecheck`

### Task 2.2: Add Repo Analytics external and internal links

- **Location**:
  - `packages/ui/src/components/RepoAnalyticsPage.tsx`
  - `packages/ui/src/model.ts`
  - `packages/ui/src/styles.css`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Link repo names to `repo_url` and metric cells to
  source-aware Activity or Commits routes for the current date range.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 5
- **Acceptance criteria**:
  - Repo names render as external anchors only when `repo_url` is present.
  - `Commits` links to the Commits page filtered by source, repo, and current
    range.
  - `Activity`, `Issues`, `PR/MRs`, `Merged`, and `Reviews` link to the Activity
    page filtered by source, repo, kind/action, and current range.
  - Zero counts do not produce misleading links.
  - Anchors have accessible labels and do not destabilize table layout.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run build`

### Task 2.3: Render Activity link affordances conservatively

- **Location**:
  - `packages/ui/src/components/ActivityFeed.tsx`
  - `packages/ui/src/model.ts`
  - `packages/ui/src/styles.css`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Keep the existing title-link behavior for `activity.url`,
  add any needed secondary target affordance, and ensure unlinked ambiguous rows
  still read clearly.
- **Dependencies**:
  - Task 2.1
- **Complexity**: 4
- **Acceptance criteria**:
  - Rows with `activity.url` remain title links.
  - Rows with only a secondary `target_url` render a clear, compact secondary
    link without pretending it is the event permalink.
  - Ambiguous comment rows remain readable with no false destination.
  - Virtualized row dimensions remain stable.
- **Validation**:
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run smoke`

### Task 2.4: Final validation, docs, and devlog

- **Location**:
  - `docs/devlog/2026-06.md`
  - `docs/CONTRACT.md`
  - `docs/DESIGN.md`
  - `README.md`
  - `packages/ui/README.md`
  - `packages/contract/README.md`
  - `packages/ui/scripts/render-smoke.mjs`
- **Description**: Complete documentation and retained devlog evidence for the
  link contract, then run the full validation suite expected for contract,
  source, and UI changes.
- **Dependencies**:
  - Task 2.2
  - Task 2.3
- **Complexity**: 4
- **Acceptance criteria**:
  - Devlog records the shipped link semantics, issue/PR refs, and validation.
  - Contract and design docs match implemented behavior.
  - Render smoke asserts repo link, metric drill-down, push URL, and retained
    unlinked ambiguous comments.
  - Final validation evidence is ready for PR delivery and plan closeout.
- **Validation**:
  - `pnpm run typecheck`
  - `pnpm test`
  - `pnpm --filter @symphony-board/ui run test`
  - `pnpm --filter @symphony-board/ui run build`
  - `pnpm run validate --in packages/ui/public/contract.json`
  - `pnpm --filter @symphony-board/ui run smoke`
  - `git diff --check`

## Final Definition Of Done

- Contract, producer, UI, docs, sample contract, and smoke coverage land
  together.
- Activity link coverage improves for every reliable event category identified
  in the source snapshot.
- No provider-ambiguous comment or deleted-ref URL is fabricated.
- All plan validation and implementation validation commands pass, or any
  skipped live-provider dry-run is explicitly waived with the reason.

