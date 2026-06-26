import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityDTO, ActivityDailyDTO, AggregateDTO, ContractEnvelope, EdgeDTO, ItemDTO, RepoMetricDTO, RepoMetricSeriesPointDTO, ReviewThreadCommentDTO, ReviewThreadDTO, SourceDTO } from "@symphony-board/contract";
import {
  DEFAULT_TIME_RANGE_DAYS,
  DEFAULT_TIME_RANGE_PRESET_ID,
  TIME_RANGE_PRESETS,
  ACTIVITY_ROW_GAP_PX,
  ACTIVITY_ROW_HEIGHT_PX,
  VIEW_SCOPES,
  VIEW_SCOPE_LABEL,
  activeTimeRangePresetId,
  preferredDefaultTimeRange,
  staticContractTimeRange,
  rangeQueryWindow,
  timeRangeForPreset,
  timeRangeForDays,
  presetBeyondLoadedWindow,
  timeRangeToIso,
  isDateOnly,
  normalizeTimeRange,
  routeTimeRange,
  emptyFilters,
  activityRouteMatches,
  activityMatches,
  activityDisplay,
  reviewThreadsLabel,
  itemReviewMatches,
  reviewActivityIsUnresolved,
  activityVirtualRange,
  liveDetailNavigation,
  liveEventKey,
  buildCommitRows,
  commitVirtualRange,
  filterActivitiesByRange,
  buildActivityHeatmap,
  buildActivityHeatmapFromDaily,
  activityDailyExtent,
  buildActivityTrend,
  activitySummaryKindCounts,
  ACTIVITY_SUMMARY_KINDS,
  isCommitActivity,
  filterCommits,
  commitBranches,
  commitBranchOptions,
  commitBody,
  commitMessage,
  commitSha,
  commitShortSha,
  commitRepoOptions,
  itemInTimeRange,
  activityInTimeRange,
  itemMatches,
  indexItems,
  mergeActivityIndex,
  resolveEdges,
  edgeMatches,
  computeStats,
  computeGlobalStats,
  findContractScopedStats,
  boardWindowEdges,
  computeBoardWindowStats,
  computeGraphStats,
  relativeTime,
  reviewThreadDisplayTime,
  reviewSortFromRoute,
  compareReviewThreadsRecent,
  compareReviewThreadsGrouped,
  reviewThreadComparator,
  reviewResolution,
  resetsIn,
  pluralize,
  buildGraph,
  buildAdjacency,
  focusSubgraph,
  relatedItems,
  cutoffIso,
  repoKey,
  deriveRepos,
  deriveRepoOptions,
  applyVisibility,
  repoMetricMatches,
  repoCoverage,
  repoTrend,
  sortRepoMetrics,
  sourceDisplayName,
  visibleHeaderSources,
  deriveStatuses,
  spotlight,
  columnCollapsed,
  itemIsPrimaryWindow,
  buildColorIndex,
  resolveRepoColor,
  isHexColor,
  compareGraphNodes,
  parseHashRoute,
  buildHashRoute,
  contractTopLevelCounts,
  contractSectionSizes,
  contractSourceHealth,
  formatBytes,
  runDuration,
  graphFocusHref,
  applyRouteSearch,
  relationCounts,
  relationCountOf,
  graphWindowEdgesInRange,
  graphOverviewVisibility,
  graphCanvasEmptyReason,
  isSyncRunActive,
  syncProducedFreshData,
  liveSourceStatus,
  syncRunSummary,
  type ResolvedEdge,
  type GraphNode,
  type SyncRunStatus,
  configProjectPath,
  configWithProject,
  configWithSource,
  configWithSourcePatch,
  configWithoutProject,
  configWithoutSource,
  sourcesNeedingSync,
  suggestSourceDefaults,
  sourceTokenEnvs,
  isSourceTokenSet,
  NEW_CONFIG_DB_PATH,
  type ConfigDocument,
  type ConfigProjectEntry,
  type ConfigSourceDoc,
  type LiveEvent,
} from "../src/model.ts";

function item(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "github:github.com|X", source_id: "github:github.com", external_id: "X", kind: "issue",
    project_path: "o/r", iid: 1, url: "https://x", title: "Title", state: "open", state_raw: "OPEN",
    state_reason: null, is_draft: null, author: "a", created_at: null, updated_at: null, closed_at: null,
    merged_at: null, labels: [], review_state: null, ci_state: null, merge_state: null, review_threads: null,
    milestone: null, demand: 0, last_seen_at: null, ...over,
  };
}

const edge = (from: string, to: string, lifecycle: EdgeDTO["lifecycle"] = null, type = "relates"): EdgeDTO => ({
  type,
  from,
  to,
  from_state: null,
  to_state: null,
  lifecycle,
});

function activity(over: Partial<ActivityDTO> = {}): ActivityDTO {
  // 4.0.0 dropped `id`/`summary`; identity is source_id|external_id (see activityKey).
  return {
    source_id: "github:github.com", external_id: "A1", kind: "issue",
    action: "closed", project_path: "o/r", target_kind: "issue", target_ref: "github:github.com|X",
    target_iid: 13, title: "Closed issue", url: "https://x", actor: "dev-a",
    occurred_at: "2026-06-07T00:00:00Z", details: { sha: "abc1234" },
    first_seen_at: "2026-06-07T00:00:00Z", last_seen_at: "2026-06-07T00:00:00Z", ...over,
  };
}

function reviewThread(over: Partial<ReviewThreadDTO> = {}): ReviewThreadDTO {
  return {
    id: "github:github.com|THREAD",
    source_id: "github:github.com",
    external_id: "THREAD",
    project_path: "o/r",
    target_ref: "github:github.com|PR",
    target_iid: 42,
    title: "Review target",
    url: "https://example.com/thread",
    is_resolved: true,
    is_outdated: false,
    resolved_by: "maintainer",
    path: "src/app.ts",
    line: 12,
    start_line: null,
    comments_total: 2,
    comments: [],
    last_seen_at: "2026-06-10T11:55:00Z",
    ...over,
  };
}

function reviewComment(over: Partial<ReviewThreadCommentDTO> = {}): ReviewThreadCommentDTO {
  // updated_at is null by default so created_at is the comment instant
  // (reviewThreadCommentInstant prefers updated_at when present).
  return {
    id: "c",
    author: "reviewer",
    avatar_url: null,
    body: "comment",
    url: null,
    created_at: "2026-06-10T08:00:00Z",
    updated_at: null,
    ...over,
  };
}

function repoMetric(over: Partial<RepoMetricDTO> = {}): RepoMetricDTO {
  const totals = {
    items_active: 2,
    items_opened: 1,
    items_closed: 0,
    change_requests_opened: 1,
    change_requests_closed: 0,
    change_requests_merged: 1,
    activities: 4,
    activity_score: 8,
    commits: 2,
    pushes: 1,
    comments: 1,
    reviews: 0,
    approvals: 0,
    edge_declared: 0,
    edge_fulfilled: 1,
    edge_broken: 0,
    by_item_state: { open: 1, merged: 1 },
    by_item_kind: { issue: 1, change_request: 1 },
    by_activity_kind: { commit: 2, push: 1, comment: 1 },
    by_activity_action: { committed: 2, pushed: 1, commented: 1 },
    by_edge_type: { closes: 1 },
    by_edge_lifecycle: { fulfilled: 1 },
    by_review_state: {},
    by_ci_state: { passing: 1 },
    by_merge_state: { mergeable: 1 },
    by_label_scope: { workflow: 1 },
  };
  return {
    source_id: "github:github.com",
    project_path: "o/r",
    window: {
      kind: "time_range",
      basis: "repo_activity",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-07T23:59:59.999Z",
      bucket: "day",
    },
    totals,
    series: [
      {
        bucket_start: "2026-06-01T00:00:00.000Z",
        bucket_end: "2026-06-01T23:59:59.999Z",
        stats: totals,
      },
    ],
    top_actors: [
      {
        actor: "alice",
        actor_key: "provider-user:github:github.com:alice",
        display_name: "alice",
        activities: 2,
        commits: 2,
        items_opened: 1,
        change_requests_merged: 0,
      },
    ],
    data_quality: { activity_available: true, observed_since: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-20T00:00:00.000Z", notes: [] },
    ...over,
  };
}

test("itemMatches applies source/state/kind/search filters (AND)", () => {
  const it = item({ title: "Flaky test", author: "dev-a", labels: [{ name: "bug", scope: null, color: null }] });
  assert.equal(itemMatches(it, emptyFilters()), true);
  assert.equal(itemMatches(it, { ...emptyFilters(), states: new Set(["closed"]) }), false);
  assert.equal(itemMatches(it, { ...emptyFilters(), kinds: new Set(["issue"]) }), true);
  assert.equal(itemMatches(it, { ...emptyFilters(), search: "flaky" }), true, "search is case-insensitive");
  assert.equal(itemMatches(it, { ...emptyFilters(), search: "bug" }), true, "search hits labels");
  assert.equal(itemMatches(it, { ...emptyFilters(), search: "nope" }), false);
});

test("itemReviewMatches / itemMatches honor the review-thread lens (threads, unresolved)", () => {
  const open = item({ kind: "change_request", review_threads: { open: 2, total: 3 } });
  const resolved = item({ kind: "change_request", review_threads: { open: 0, total: 4 } });
  const noThreads = item({ kind: "change_request", review_threads: { open: 0, total: 0 } });
  const issue = item({ kind: "issue", review_threads: null });

  // "threads" = has any resolvable thread (total>0).
  assert.equal(itemReviewMatches(open, new Set(["threads"])), true);
  assert.equal(itemReviewMatches(resolved, new Set(["threads"])), true);
  assert.equal(itemReviewMatches(noThreads, new Set(["threads"])), false);
  assert.equal(itemReviewMatches(issue, new Set(["threads"])), false);

  // "unresolved" = open>0.
  assert.equal(itemReviewMatches(open, new Set(["unresolved"])), true);
  assert.equal(itemReviewMatches(resolved, new Set(["unresolved"])), false);

  // empty lens = no constraint; OR within the set (both selected = superset).
  assert.equal(itemReviewMatches(resolved, new Set()), true);
  assert.equal(itemReviewMatches(resolved, new Set(["threads", "unresolved"])), true);

  // wired through itemMatches alongside the other dimensions.
  assert.equal(itemMatches(open, { ...emptyFilters(), reviews: new Set(["unresolved"]) }), true);
  assert.equal(itemMatches(resolved, { ...emptyFilters(), reviews: new Set(["unresolved"]) }), false);
});

test("itemMatches honors the exact-repo lens (irepo), with no prefix collision", () => {
  const inRepo = item({ project_path: "o/r" });
  const sibling = item({ project_path: "o/r2" });
  const nullPath = item({ project_path: null });
  // exact project_path match — "o/r" must NOT match "o/r2" (shared prefix).
  assert.equal(itemMatches(inRepo, { ...emptyFilters(), repos: new Set(["o/r"]) }), true);
  assert.equal(itemMatches(sibling, { ...emptyFilters(), repos: new Set(["o/r"]) }), false, "no prefix collision");
  assert.equal(itemMatches(nullPath, { ...emptyFilters(), repos: new Set(["o/r"]) }), false, "null path never matches a repo pin");
  // empty repo lens = no constraint
  assert.equal(itemMatches(inRepo, { ...emptyFilters(), repos: new Set() }), true);
  // emptyFilters seeds an empty repo set
  assert.equal(emptyFilters().repos.size, 0);
});

test("parseHashRoute / buildHashRoute round-trip the irepo exact-repo pin", () => {
  const route = parseHashRoute(buildHashRoute({ page: "board", irepo: "o/r" }));
  assert.equal(route.irepo, "o/r");
  assert.ok(buildHashRoute({ page: "board", irepo: "o/r" }).includes("irepo=o%2Fr"), "irepo is percent-encoded");
  assert.equal(parseHashRoute(buildHashRoute({ page: "board" })).irepo, null, "absent irepo round-trips to null");
});

test("graphFocusHref threads an optional lens into the focus deep link", () => {
  const href = graphFocusHref(item({ id: "github:github.com|42" }), { isource: "x", irepo: "o/r" });
  const route = parseHashRoute(href);
  assert.equal(route.page, "graph");
  assert.equal(route.focus, "github:github.com|42");
  assert.equal(route.isource, "x");
  assert.equal(route.irepo, "o/r");
  assert.ok(href.includes("isource=x"));
  assert.ok(href.includes("irepo=o%2Fr"));
  // no lens supplied -> a bare focus link
  assert.equal(parseHashRoute(graphFocusHref(item({ id: "github:github.com|7" }))).irepo, null);
});

test("reviewActivityIsUnresolved resolves the target PR's current open-thread count", () => {
  const byId = new Map<string, ItemDTO>([
    ["github:github.com|PR_open", item({ id: "github:github.com|PR_open", kind: "change_request", review_threads: { open: 1, total: 1 } })],
    ["github:github.com|PR_done", item({ id: "github:github.com|PR_done", kind: "change_request", review_threads: { open: 0, total: 2 } })],
  ]);
  const reviewOpen = activity({ kind: "review", action: "reviewed", target_ref: "github:github.com|PR_open" });
  const reviewDone = activity({ kind: "review", action: "approved", target_ref: "github:github.com|PR_done" });
  const reviewMissing = activity({ kind: "review", action: "reviewed", target_ref: "github:github.com|gone" });
  const nonReview = activity({ kind: "issue", action: "closed", target_ref: "github:github.com|PR_open" });

  assert.equal(reviewActivityIsUnresolved(reviewOpen, byId), true);
  assert.equal(reviewActivityIsUnresolved(reviewDone, byId), false);
  assert.equal(reviewActivityIsUnresolved(reviewMissing, byId), false, "target not in window -> not unresolved");
  assert.equal(reviewActivityIsUnresolved(nonReview, byId), false, "only review rows qualify");
});

test("reviewActivityIsUnresolved must resolve against the full contract, not a range projection", () => {
  // Regression guard for the historical-range unresolved lens: a review that
  // occurred in-range on a PR whose `updated_at` is later than the range is
  // dropped from the /api/range projection, yet the PR still carries open
  // threads. Resolving against the range-projected index hides it; resolving
  // against the full visible contract keeps it. App builds the activity index
  // from the full contract for exactly this reason.
  const prLate = item({ id: "github:github.com|PR_late", kind: "change_request", review_threads: { open: 2, total: 5 } });
  const reviewInRange = activity({ kind: "review", action: "reviewed", target_ref: "github:github.com|PR_late" });

  const rangeProjection = new Map<string, ItemDTO>(); // PR updated after the range -> omitted
  const fullContract = new Map<string, ItemDTO>([[prLate.id, prLate]]);

  assert.equal(reviewActivityIsUnresolved(reviewInRange, rangeProjection), false, "range projection omits the later-updated PR -> wrongly resolved");
  assert.equal(reviewActivityIsUnresolved(reviewInRange, fullContract), true, "full contract retains the PR -> correctly unresolved");
});

test("mergeActivityIndex unions full-contract and range-projection items (neither alone suffices)", () => {
  // Static items[] is 90-day windowed; the /api/range projection covers a custom
  // range. Each set can hold a review target the other omits, so the activity
  // index must union both, not replace one with the other.
  const inStaticWindow = item({ id: "g|PR_recent", kind: "change_request", review_threads: { open: 1, total: 1 } });
  const onlyInRange = item({ id: "g|PR_old", kind: "change_request", review_threads: { open: 3, total: 3 } });
  const full = new Map<string, ItemDTO>([[inStaticWindow.id, inStaticWindow]]);
  const range = new Map<string, ItemDTO>([[onlyInRange.id, onlyInRange]]);

  const merged = mergeActivityIndex(full, range);
  assert.equal(merged.size, 2);
  // A review on a PR only in the static window resolves...
  assert.equal(reviewActivityIsUnresolved(activity({ kind: "review", action: "reviewed", target_ref: "g|PR_recent" }), merged), true);
  // ...and one on a PR only in the range projection (range predates the window) also resolves.
  assert.equal(reviewActivityIsUnresolved(activity({ kind: "review", action: "reviewed", target_ref: "g|PR_old" }), merged), true);

  // On overlap the /api/range projection wins: it reads the canonical store live
  // at request time, whereas the static contract is an emitted file that can lag
  // after a background sync, so the range row carries the current review_threads.
  const overlapFull = item({ id: "g|dup", kind: "change_request", review_threads: { open: 0, total: 2 } });
  const overlapRange = item({ id: "g|dup", kind: "change_request", review_threads: { open: 9, total: 9 } });
  const dup = mergeActivityIndex(new Map([[overlapFull.id, overlapFull]]), new Map([[overlapRange.id, overlapRange]]));
  assert.equal(dup.get("g|dup")?.review_threads?.open, 9, "live range projection wins on overlap");
});

test("itemMatches: multi-term AND + exact #iid (so a 'repo #iid' search pins one item)", () => {
  const it13 = item({ id: "g|13", project_path: "owner/repo", iid: 13, title: "Add thing" });
  const it130 = item({ id: "g|130", project_path: "owner/repo", iid: 130, title: "Other" });
  const otherRepo = item({ id: "g|x", project_path: "owner/other", iid: 13, title: "Elsewhere" });
  const f = (search: string) => ({ ...emptyFilters(), search });
  // terms are AND'd, NOT matched as one contiguous substring
  assert.equal(itemMatches(it13, f("add thing")), true, "both words present -> match");
  assert.equal(itemMatches(it13, f("thing add")), true, "order-independent");
  assert.equal(itemMatches(it13, f("add nope")), false, "one missing term fails the AND");
  // a numeric iid term is an EXACT match, never a substring
  assert.equal(itemMatches(it13, f("#13")), true);
  assert.equal(itemMatches(it130, f("#13")), false, "#13 must not match #130");
  assert.equal(itemMatches(item({ iid: null }), f("#13")), false, "no iid never matches a #<n> term");
  assert.equal(itemMatches(it13, f("#")), false, "a bare # is not a number term -> substring miss");
  assert.equal(itemMatches(item({ iid: 0 }), f("#0")), true, "iid 0 matches #0 (guard is != null, not truthiness)");
  assert.equal(itemMatches(it13, f("#013")), false, "leading zeros do not widen the iid match");
  // the "repo #iid" token pins exactly one item even across repos sharing an iid
  assert.equal(itemMatches(it13, f("owner/repo #13")), true);
  assert.equal(itemMatches(it130, f("owner/repo #13")), false, "same repo, wrong iid");
  assert.equal(itemMatches(otherRepo, f("owner/repo #13")), false, "same iid, wrong repo");
});

test("activityMatches applies source/kind/search filters with exact target #iid", () => {
  const a13 = activity({ project_path: "owner/repo", target_iid: 13, title: "Closed issue" });
  const a130 = activity({ external_id: "A130", project_path: "owner/repo", target_iid: 130 });
  const otherRepo = activity({ external_id: "B13", project_path: "owner/other", target_iid: 13 });
  const f = (search: string) => ({ ...emptyFilters(), search });

  assert.equal(activityMatches(a13, emptyFilters()), true);
  assert.equal(activityMatches(a13, { ...emptyFilters(), sources: new Set(["gitlab:gitlab.com"]) }), false);
  assert.equal(activityMatches(a13, { ...emptyFilters(), kinds: new Set(["issue"]) }), true);
  // search is multi-term AND over title/actor/project/target/details (4.0.0
  // dropped `summary`, so the haystack no longer includes producer prose).
  assert.equal(activityMatches(a13, f("closed owner/repo")), true, "activity search is multi-term AND");
  assert.equal(activityMatches(a13, f("abc1234")), true, "search includes provider details");
  assert.equal(activityMatches(a13, f("#13")), true);
  assert.equal(activityMatches(a130, f("#13")), false, "#13 must not match #130");
  assert.equal(activityMatches(otherRepo, f("owner/repo #13")), false, "same iid, wrong repo");
});

test("activityMatches search includes the structured action and kind (4.0.0 dropped summary)", () => {
  // 4.0.0 dropped `summary`, which used to carry action prose. Action-only terms
  // must still match via the structured action/kind fields.
  const approved = activity({ external_id: "AP", action: "approved", kind: "review", title: "PR five update", target_kind: null, target_ref: null, details: null });
  const forcePush = activity({ external_id: "FP", action: "force_pushed", kind: "push", title: "branch main updated", target_kind: null, target_ref: null, details: null });
  const f = (search: string) => ({ ...emptyFilters(), search });

  assert.equal(activityMatches(approved, f("approved")), true, "action term matches when absent from title/details");
  assert.equal(activityMatches(approved, f("review")), true, "kind term matches");
  assert.equal(activityMatches(forcePush, f("force pushed")), true, "multi-word action matches term-by-term via force_pushed");
  assert.equal(activityMatches(approved, f("merged")), false, "an unrelated action term still does not match");
});

test("activityRouteMatches applies source-aware repo, kind, and action filters", () => {
  const row = activity({ source_id: "gitlab:gitlab.com", project_path: "group/project", kind: "change_request", action: "merged" });
  const route = {
    source: "gitlab:gitlab.com",
    repo: "group/project",
    kind: "change_request",
    action: "closed,merged",
  };
  assert.equal(activityRouteMatches(row, route), true);
  assert.equal(activityRouteMatches(row, { ...route, source: "github:github.com" }), false);
  assert.equal(activityRouteMatches(row, { ...route, repo: "other/project" }), false);
  assert.equal(activityRouteMatches(row, { ...route, kind: "issue" }), false);
  assert.equal(activityRouteMatches(row, { ...route, action: "opened,closed" }), false);
});

test("activityRouteMatches accepts comma-list source/repo/kind/action (multi-select chips)", () => {
  const gl = activity({ source_id: "gitlab:gitlab.com", project_path: "group/project", kind: "change_request", action: "merged" });
  const gh = activity({ source_id: "github:github.com", project_path: "owner/repo", kind: "issue", action: "opened" });
  // A comma list is OR within a dimension — the same parse a multi-select chip
  // set produces, so chips and the content filter never disagree.
  const route = {
    source: "github:github.com,gitlab:gitlab.com",
    repo: "owner/repo,group/project",
    kind: "issue,change_request",
    action: "opened,merged",
  };
  assert.equal(activityRouteMatches(gl, route), true, "second value in each list matches");
  assert.equal(activityRouteMatches(gh, route), true, "first value in each list matches");
  assert.equal(activityRouteMatches(gl, { ...route, repo: "owner/repo" }), false, "repo dropped from the set excludes the row");
  assert.equal(
    activityRouteMatches(activity({ project_path: null }), { source: null, repo: "owner/repo", kind: null, action: null }),
    false,
    "a null project_path never matches a repo filter",
  );
});

test("filterCommits keeps only commit records, optionally pinned to one repo", () => {
  const commitA = activity({
    id: "github:github.com|c1",
    external_id: "c1",
    kind: "commit",
    action: "committed",
    project_path: "owner/repo",
    details: {
      sha: "aaaaaaaaaaaaaaaa",
      refs: ["refs/heads/main", "feature/x"],
      body: "Explain the change\n\nMore detail",
    },
  });
  const commitB = activity({ id: "gitlab:gitlab.com|c2", external_id: "c2", source_id: "gitlab:gitlab.com", kind: "commit", action: "committed", project_path: "grp/proj", details: { sha: "bbbbbbbbbbbbbbbb", branch: "main" } });
  const commitC = activity({ id: "gitlab:gitlab.com|c3", external_id: "c3", source_id: "gitlab:gitlab.com", kind: "commit", action: "committed", project_path: "owner/repo", details: { sha: "cccccccccccccccc", branch: "main" } });
  const issueEvent = activity({ id: "github:github.com|i1", external_id: "i1", kind: "issue", action: "closed", project_path: "owner/repo" });
  const all = [commitA, issueEvent, commitB, commitC];

  assert.equal(isCommitActivity(commitA), true);
  assert.equal(isCommitActivity(issueEvent), false);
  assert.equal(commitSha(commitA), "aaaaaaaaaaaaaaaa");
  assert.equal(commitShortSha(commitA), "aaaaaaaa");
  assert.equal(commitMessage(commitA), "Closed issue");
  assert.equal(commitBody(commitA), "Explain the change\n\nMore detail");
  assert.equal(commitBody(commitB), null);
  assert.deepEqual(commitBranches(commitA), ["feature/x", "main"]);
  // no repo -> every commit, no non-commit
  assert.deepEqual(filterCommits(all, null).map((a) => a.id), ["github:github.com|c1", "gitlab:gitlab.com|c2", "gitlab:gitlab.com|c3"]);
  // whitespace-only repo is treated as no filter
  assert.deepEqual(filterCommits(all, "   ").map((a) => a.id), ["github:github.com|c1", "gitlab:gitlab.com|c2", "gitlab:gitlab.com|c3"]);
  // exact repo match (the picker offers a closed set), so a partial path matches nothing
  assert.deepEqual(filterCommits(all, "grp/proj").map((a) => a.id), ["gitlab:gitlab.com|c2"]);
  assert.deepEqual(filterCommits(all, "owner/repo", null, "github:github.com").map((a) => a.id), ["github:github.com|c1"]);
  assert.deepEqual(filterCommits(all, "owner/repo", null, "gitlab:gitlab.com").map((a) => a.id), ["gitlab:gitlab.com|c3"]);
  assert.deepEqual(filterCommits(all, "grp").map((a) => a.id), [], "partial repo path is not a fuzzy match");
  assert.deepEqual(filterCommits(all, null, "main").map((a) => a.id), ["github:github.com|c1", "gitlab:gitlab.com|c2", "gitlab:gitlab.com|c3"]);
  assert.deepEqual(filterCommits(all, "owner/repo", "feature/x").map((a) => a.id), ["github:github.com|c1"]);
  assert.deepEqual(filterCommits(all, "grp/proj", "feature/x").map((a) => a.id), []);
});

test("commit repo and branch options count only commits, busiest first", () => {
  const mk = (id: string, project_path: string, source_id = "github:github.com", kind = "commit") =>
    activity({ id, external_id: id, source_id, kind, action: kind === "commit" ? "committed" : "closed", project_path, details: { refs: ["main"] } });
  const commits = [
    mk("c1", "owner/repo"),
    activity({ id: "c2", external_id: "c2", kind: "commit", action: "committed", project_path: "owner/repo", details: { refs: ["main", "release"] } }),
    activity({ id: "c3", external_id: "c3", source_id: "gitlab:gitlab.com", kind: "commit", action: "committed", project_path: "grp/proj", details: { branch: "release" } }),
    activity({ id: "c3b", external_id: "c3b", source_id: "gitlab:gitlab.com", kind: "commit", action: "committed", project_path: "owner/repo", details: { branch: "main" } }),
    mk("i1", "owner/repo", "github:github.com", "issue"), // not a commit -> ignored
    activity({ id: "c4", external_id: "c4", kind: "commit", action: "committed", project_path: null }), // no repo -> ignored
  ];
  const options = commitRepoOptions(commits);
  assert.deepEqual(options, [
    { project_path: "owner/repo", source_id: "github:github.com", count: 2 },
    { project_path: "grp/proj", source_id: "gitlab:gitlab.com", count: 1 },
    { project_path: "owner/repo", source_id: "gitlab:gitlab.com", count: 1 },
  ]);
  assert.deepEqual(commitBranchOptions(commits), [
    { branch: "main", count: 3 },
    { branch: "release", count: 2 },
  ]);
});

test("activityDisplay promotes work-item titles instead of showing only #iid", () => {
  const display = activity({
    kind: "change_request",
    action: "merged",
    target_kind: "change_request",
    target_iid: 297,
    title: "docs(heuristic): record session closeout findings",
    summary: "Merged change request #297",
  });

  assert.equal(
    activityDisplay(display).title,
    "change request #297 · docs(heuristic): record session closeout findings",
  );
});

test("reviewThreadsLabel summarizes open/resolved threads and hides the empty case", () => {
  assert.equal(reviewThreadsLabel({ open: 2, total: 3 }), "2 open threads");
  assert.equal(reviewThreadsLabel({ open: 1, total: 1 }), "1 open thread");
  assert.equal(reviewThreadsLabel({ open: 0, total: 4 }), "threads resolved");
  assert.equal(reviewThreadsLabel({ open: 0, total: 0 }), null);
  assert.equal(reviewThreadsLabel(null), null);
});

test("activityDisplay adds a review-resolution chip only for review rows with threads", () => {
  const review = activity({
    kind: "review",
    action: "reviewed",
    target_kind: "change_request",
    target_iid: 191,
    title: "fix(ui): reflect Activity drill-down filters",
    summary: "Reviewed change request #191",
    details: null,
  });
  // With unresolved threads on the target -> chip present.
  assert.deepEqual(activityDisplay(review, { reviewThreads: { open: 1, total: 1 } }).chips, ["1 open thread"]);
  // Resolved -> "threads resolved".
  assert.deepEqual(activityDisplay(review, { reviewThreads: { open: 0, total: 2 } }).chips, ["threads resolved"]);
  // No thread data -> no chip.
  assert.deepEqual(activityDisplay(review, { reviewThreads: null }).chips, []);
  assert.deepEqual(activityDisplay(review).chips, []);
  // A non-review row with thread data passed in -> never shows the chip.
  const nonReview = activity({ kind: "issue", action: "closed", details: null });
  assert.deepEqual(activityDisplay(nonReview, { reviewThreads: { open: 3, total: 3 } }).chips, []);
});

test("activityDisplay exposes commit and ref details without fake #iid labels", () => {
  const commit = activity({
    kind: "commit",
    action: "committed",
    target_kind: "commit",
    target_iid: null,
    title: "chore(deploy): update test full-flow agent id",
    summary: "Committed 4eae5cc5 in gim/manifest/livekit-agents-deploy",
    details: {
      sha: "4eae5cc5e61eee22e269035e5c5055d47c34dd98",
      message: "chore(deploy): update test full-flow agent id",
    },
  });
  assert.equal(activityDisplay(commit).title, "commit 4eae5cc5 · chore(deploy): update test full-flow agent id");
  assert.deepEqual(activityDisplay(commit).chips, ["sha 4eae5cc5"]);

  const createdBranch = activity({
    kind: "branch",
    action: "created",
    target_kind: "branch",
    target_iid: null,
    title: "feature/link-ui",
    summary: "created branch feature/link-ui in owner/repo",
    details: {
      ref: "refs/heads/feature/link-ui",
      before: "0000000000000000000000000000000000000000",
      after: "abc1234def5678",
    },
  });
  assert.deepEqual(activityDisplay(createdBranch).chips, ["ref feature/link-ui", "to abc1234d"]);

  const deletedPush = activity({
    kind: "push",
    action: "deleted",
    target_kind: "push",
    target_iid: 1936,
    title: "livekit-agents-deploy",
    summary: "deleted push livekit-agents-deploy in gim/manifest/livekit-agents-deploy",
    details: {
      ref: "chore/deploy-test-full-flow-agent-9001",
      commit_from: "4eae5cc5e61eee22e269035e5c5055d47c34dd98",
      commit_to: "0000000000000000000000000000000000000000",
    },
  });
  const pushDisplay = activityDisplay(deletedPush);
  assert.equal(pushDisplay.title, "branch chore/deploy-test-full-flow-agent-9001");
  assert.equal([...pushDisplay.meta, ...pushDisplay.chips].some((part) => part.includes("#1936")), false);
  assert.deepEqual(pushDisplay.chips, ["ref chore/deploy-test-full-flow-agent-9001", "from 4eae5cc5"]);
});

test("rangeQueryWindow reads the loaded window back from range_query, else null (range-as-download landing convergence)", () => {
  // The #488 linchpin: a /api/range projection echoes its requested window as
  // zoned day-bounds in range_query; rangeQueryWindow maps them back to calendar
  // days so App can use it as staticRange. That makes the landing range == staticRange
  // (customRange false) and keeps the range-keyed load effect from re-firing — the
  // convergence that replaces the old refetch loop. Returns null (-> the
  // staticContractTimeRange fallback) for the contract.json fast-path / uploaded envs.
  const base = {
    contract_version: "4.0.0",
    generated_at: "2026-06-08T12:00:00Z",
    generator: "t",
    sources: [],
    items: [],
    edges: [],
  };
  const utcEnv = { ...base, range_query: { kind: "time_range", timezone: "UTC", from: "2026-05-10T00:00:00.000Z", to: "2026-06-08T23:59:59.999Z" } } as unknown as ContractEnvelope;
  assert.deepEqual(rangeQueryWindow(utcEnv), { from: "2026-05-10", to: "2026-06-08" }, "UTC day-bounds map back to their calendar days");
  // tz is threaded: in Asia/Taipei (UTC+8) the instant 18:00Z is already the next
  // local day, so both bounds re-zone to 2026-06-09.
  const tpeEnv = { ...base, timezone: "Asia/Taipei", range_query: { kind: "time_range", timezone: "Asia/Taipei", from: "2026-06-08T18:00:00.000Z", to: "2026-06-08T18:00:00.000Z" } } as unknown as ContractEnvelope;
  assert.deepEqual(rangeQueryWindow(tpeEnv), { from: "2026-06-09", to: "2026-06-09" }, "Taipei re-zones the instants to the local calendar day");
  // Fallback-to-null branches (App then uses staticContractTimeRange):
  assert.equal(rangeQueryWindow(base as unknown as ContractEnvelope), null, "no range_query -> null");
  assert.equal(rangeQueryWindow({ ...base, range_query: { kind: "time_range", timezone: "UTC", from: 0, to: 0 } } as unknown as ContractEnvelope), null, "non-string bounds -> null");
  assert.equal(rangeQueryWindow({ ...base, range_query: { kind: "time_range", timezone: "UTC", from: "nope", to: "nope" } } as unknown as ContractEnvelope), null, "unparseable bounds -> null");
});

test("date ranges are route-backed and filter inclusive timestamp bounds", () => {
  const env: ContractEnvelope = {
    contract_version: "2.0.0",
    generated_at: "2026-06-08T12:00:00Z",
    generator: "t",
    sources: [],
    items: [],
    edges: [],
    item_window: {
      scope: "boardWindow",
      window: { kind: "active_since", basis: "item_updated_at", since: "2026-03-10T00:00:00.000Z", days: 90, edge_filter: null },
      primary_items: 0,
      edge_endpoint_items: 0,
      total_items: 0,
      truncated: false,
    },
  };
  const range = { from: "2026-06-01", to: "2026-06-07" };

  assert.equal(DEFAULT_TIME_RANGE_DAYS, 90);
  assert.equal(DEFAULT_TIME_RANGE_PRESET_ID, "this-week");
  assert.deepEqual(TIME_RANGE_PRESETS.map((preset) => preset.label), ["today", "yesterday", "this week", "last week", "1w", "1mo", "3mo", "6mo", "1y"]);
  assert.deepEqual(
    TIME_RANGE_PRESETS.filter((preset) => preset.group === "calendar").map((preset) => preset.id),
    ["today", "yesterday", "this-week", "last-week"],
  );
  assert.deepEqual(
    TIME_RANGE_PRESETS.filter((preset) => preset.group === "rolling").map((preset) => preset.id),
    ["1w", "1mo", "3mo", "6mo", "1y"],
  );
  assert.deepEqual(staticContractTimeRange(env), { from: "2026-03-10", to: "2026-06-08" });
  assert.deepEqual(preferredDefaultTimeRange(env, "this-week"), { from: "2026-06-07", to: "2026-06-08" });
  assert.deepEqual(timeRangeForPreset("today", Date.parse("2026-06-08T12:00:00Z")), { from: "2026-06-08", to: "2026-06-08" });
  assert.deepEqual(timeRangeForPreset("yesterday", Date.parse("2026-06-08T12:00:00Z")), { from: "2026-06-07", to: "2026-06-07" });
  // 2026-06-07 is a Sunday, so the week start coincides with today and the single-day
  // range matches both `today` and `this-week`; the preferred preset wins the tie.
  assert.equal(activeTimeRangePresetId({ from: "2026-06-07", to: "2026-06-07" }, Date.parse("2026-06-07T12:00:00Z"), "this-week"), "this-week");
  assert.equal(activeTimeRangePresetId({ from: "2026-06-07", to: "2026-06-07" }, Date.parse("2026-06-07T12:00:00Z"), "today"), "today");
  // 2026-06-07 is a Sunday — the start of its own week, so "this week" is just today.
  assert.deepEqual(timeRangeForPreset("this-week", Date.parse("2026-06-07T12:00:00Z")), { from: "2026-06-07", to: "2026-06-07" });
  // 2026-06-11 is a Thursday: this week starts on the prior Sunday.
  assert.deepEqual(timeRangeForPreset("this-week", Date.parse("2026-06-11T12:00:00Z")), { from: "2026-06-07", to: "2026-06-11" });
  // 2026-06-11 is a Thursday: last week is the previous full Sunday..Saturday.
  assert.deepEqual(timeRangeForPreset("last-week", Date.parse("2026-06-11T12:00:00Z")), { from: "2026-05-31", to: "2026-06-06" });
  // On a Sunday, the current week just started: last week ends yesterday (Saturday).
  assert.deepEqual(timeRangeForPreset("last-week", Date.parse("2026-06-14T12:00:00Z")), { from: "2026-06-07", to: "2026-06-13" });
  // On a Saturday, the current week is complete; last week is still the one before.
  assert.deepEqual(timeRangeForPreset("last-week", Date.parse("2026-06-13T12:00:00Z")), { from: "2026-05-31", to: "2026-06-06" });
  assert.deepEqual(timeRangeForPreset("1w", Date.parse("2026-06-08T12:00:00Z")), { from: "2026-06-02", to: "2026-06-08" }, "1w is exactly 7 days ending today (today and the 6 before)");
  assert.deepEqual(timeRangeForPreset("6mo", Date.parse("2026-06-08T12:00:00Z")), { from: "2025-12-11", to: "2026-06-08" }, "6mo is exactly 180 days ending today");
  assert.deepEqual(timeRangeForPreset("1y", Date.parse("2026-06-08T12:00:00Z")), { from: "2025-06-09", to: "2026-06-08" }, "1y is exactly 365 days ending today");
  // timeRangeForDays is the rolling-window primitive shared by the rolling presets
  // and the mobile board-scope window: exactly N calendar days ending today.
  assert.deepEqual(timeRangeForDays(1, Date.parse("2026-06-08T12:00:00Z")), { from: "2026-06-08", to: "2026-06-08" }, "1 day = today only");
  assert.deepEqual(timeRangeForDays(3, Date.parse("2026-06-08T12:00:00Z")), { from: "2026-06-06", to: "2026-06-08" }, "3 days = today and the 2 before");
  assert.deepEqual(timeRangeForDays(7, Date.parse("2026-06-08T12:00:00Z")), timeRangeForPreset("1w", Date.parse("2026-06-08T12:00:00Z")), "7 days matches the 1w rolling preset");
  assert.deepEqual(timeRangeForDays(0, Date.parse("2026-06-08T12:00:00Z")), { from: "2026-06-08", to: "2026-06-08" }, "days clamps to >= 1");
  // presetBeyondLoadedWindow disables quick presets that reach before the loaded
  // board window (Board data). windowFrom null = no cap (Full board).
  assert.equal(presetBeyondLoadedWindow({ from: "2026-03-01", to: "2026-06-08" }, "2026-05-10"), true, "a preset starting before the loaded window is out of range");
  assert.equal(presetBeyondLoadedWindow({ from: "2026-05-20", to: "2026-06-08" }, "2026-05-10"), false, "a preset within the loaded window is allowed");
  assert.equal(presetBeyondLoadedWindow({ from: "2026-05-10", to: "2026-06-08" }, "2026-05-10"), false, "a preset starting exactly at the window edge is allowed");
  assert.equal(presetBeyondLoadedWindow({ from: "2025-01-01", to: "2026-06-08" }, null), false, "null windowFrom (Full board) never caps");
  assert.equal(isDateOnly("2026-06-07"), true);
  assert.equal(isDateOnly("2026-02-31"), false);
  assert.deepEqual(normalizeTimeRange(range), range);
  assert.equal(normalizeTimeRange({ from: "2026-06-08", to: "2026-06-07" }), null);
  assert.deepEqual(routeTimeRange(parseHashRoute("#/activity?from=2026-06-01&to=2026-06-07")), range);
  assert.equal(routeTimeRange(parseHashRoute("#/activity?from=2026-06-01&to=not-a-date")), null);

  assert.equal(itemInTimeRange(item({ updated_at: "2026-06-01T00:00:00Z" }), range), true);
  assert.equal(itemInTimeRange(item({ updated_at: "2026-06-07T23:59:59Z" }), range), true, "upper bound accepts ISO without milliseconds");
  assert.equal(itemInTimeRange(item({ updated_at: "2026-06-08T00:00:00Z" }), range), false);

  const activities = [
    activity({ id: "start", external_id: "start", occurred_at: "2026-06-01T00:00:00Z" }),
    activity({ id: "end", external_id: "end", occurred_at: "2026-06-07T23:59:59Z" }),
    activity({ id: "old", external_id: "old", occurred_at: "2026-05-31T23:59:59Z" }),
  ];
  assert.equal(activityInTimeRange(activities[1]!, range), true);
  assert.deepEqual(filterActivitiesByRange(activities, range).map((a) => a.id), ["end", "start"]);

  const recent = item({ id: "recent", updated_at: "2026-06-07T23:59:59Z" });
  const old = item({ id: "old", updated_at: "2026-05-31T23:59:59Z" });
  const resolved: ResolvedEdge[] = [
    { edge: edge("recent", "old", "fulfilled", "closes"), from: recent, to: old },
    { edge: edge("old", "missing", null, "mentions"), from: old, to: null },
    { edge: edge("external-a", "external-b", null, "relates"), from: null, to: null },
  ];
  assert.deepEqual(graphWindowEdgesInRange(resolved, range).map((re) => re.edge.type), ["closes", "relates"]);
});

test("time-range presets and filtering honor a configured timezone", () => {
  // 2026-06-08T20:00Z is already 2026-06-09 04:00 in Asia/Taipei (+08:00),
  // so the local calendar day is the 9th while UTC is still the 8th.
  const now = Date.parse("2026-06-08T20:00:00Z");
  assert.deepEqual(timeRangeForPreset("today", now, "UTC"), { from: "2026-06-08", to: "2026-06-08" });
  assert.deepEqual(timeRangeForPreset("today", now, "Asia/Taipei"), { from: "2026-06-09", to: "2026-06-09" });
  assert.deepEqual(timeRangeForPreset("yesterday", now, "UTC"), { from: "2026-06-07", to: "2026-06-07" });
  assert.deepEqual(timeRangeForPreset("yesterday", now, "Asia/Taipei"), { from: "2026-06-08", to: "2026-06-08" });
  // Tuesday 2026-06-09 in Taipei → week starts Sunday the 7th.
  assert.deepEqual(timeRangeForPreset("this-week", now, "Asia/Taipei"), { from: "2026-06-07", to: "2026-06-09" });
  assert.deepEqual(timeRangeForPreset("last-week", now, "Asia/Taipei"), { from: "2026-05-31", to: "2026-06-06" });
  assert.deepEqual(timeRangeForPreset("1w", now, "Asia/Taipei"), { from: "2026-06-03", to: "2026-06-09" });
  assert.equal(activeTimeRangePresetId({ from: "2026-06-09", to: "2026-06-09" }, now, "today", "Asia/Taipei"), "today");

  // A date-only range expands at the zone's day boundaries, not UTC midnight.
  assert.deepEqual(timeRangeToIso({ from: "2026-06-09", to: "2026-06-09" }, "Asia/Taipei"), {
    from: "2026-06-08T16:00:00.000Z",
    to: "2026-06-09T15:59:59.999Z",
  });
  // An item at 2026-06-08T20:00Z (= 06-09 04:00 Taipei) is outside the UTC 06-09
  // day but inside the Taipei 06-09 day.
  const dayRange = { from: "2026-06-09", to: "2026-06-09" };
  const it = item({ updated_at: "2026-06-08T20:00:00Z" });
  assert.equal(itemInTimeRange(it, dayRange, "UTC"), false);
  assert.equal(itemInTimeRange(it, dayRange, "Asia/Taipei"), true);
});

test("filterActivitiesByRange sorts by instant across timezone offsets", () => {
  const range = { from: "2026-06-08", to: "2026-06-08" };
  const activities = [
    activity({ id: "gitlab-local", external_id: "gitlab-local", occurred_at: "2026-06-08T16:59:35.000+08:00" }),
    activity({ id: "github-utc", external_id: "github-utc", occurred_at: "2026-06-08T09:45:23Z" }),
  ];

  assert.deepEqual(filterActivitiesByRange(activities, range).map((a) => a.id), ["github-utc", "gitlab-local"]);
});

test("activityVirtualRange renders only the visible rows plus overscan", () => {
  const opts = { count: 100, rowHeight: 10, rowGap: 2, viewportHeight: 25, overscan: 1 };

  assert.deepEqual(activityVirtualRange({ ...opts, scrollTop: 0 }), {
    start: 0,
    end: 5,
    visibleCount: 5,
    totalHeightPx: 1198,
  });
  assert.deepEqual(activityVirtualRange({ ...opts, scrollTop: 120 }), {
    start: 9,
    end: 15,
    visibleCount: 6,
    totalHeightPx: 1198,
  });
  assert.deepEqual(activityVirtualRange({ ...opts, scrollTop: 9999 }), {
    start: 98,
    end: 100,
    visibleCount: 2,
    totalHeightPx: 1198,
  });
});

test("activityVirtualRange clamps empty and invalid inputs", () => {
  assert.deepEqual(activityVirtualRange({ count: 0, scrollTop: 50, viewportHeight: 100 }), {
    start: 0,
    end: 0,
    visibleCount: 0,
    totalHeightPx: 0,
  });

  const bad = activityVirtualRange({ count: Number.NaN, scrollTop: Number.NaN, viewportHeight: Number.NaN });
  assert.equal(bad.start, 0);
  assert.equal(bad.end, 0);
  assert.equal(bad.visibleCount, 0);
  assert.equal(bad.totalHeightPx, 0);

  const defaults = activityVirtualRange({ count: 2, scrollTop: -1, viewportHeight: -1 });
  assert.deepEqual(defaults, {
    start: 0,
    end: 2,
    visibleCount: 2,
    totalHeightPx: 2 * (ACTIVITY_ROW_HEIGHT_PX + ACTIVITY_ROW_GAP_PX) - ACTIVITY_ROW_GAP_PX,
  });
});

function liveEvent(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    seq: 1,
    event_id: "evt-1",
    source_id: "github:github.com",
    provider: "github",
    received_at: "2026-06-21T00:00:00.000Z",
    event_type: "pull_request",
    category: "change_request",
    title: "event",
    ...over,
  };
}

test("liveDetailNavigation finds adjacent events in the filtered feed order", () => {
  const newest = liveEvent({ seq: 3, event_id: "evt-3", title: "newest" });
  const current = liveEvent({ seq: 2, event_id: "evt-2", title: "current" });
  const older = liveEvent({ seq: 1, event_id: "evt-1", title: "older" });

  assert.equal(liveEventKey(current), "github:github.com:evt-2:2");
  assert.deepEqual(liveDetailNavigation([newest, current, older], current), {
    index: 1,
    position: 2,
    total: 3,
    previous: newest,
    next: older,
  });
});

test("liveDetailNavigation disables unavailable edges and ignores stale detail", () => {
  const newest = liveEvent({ seq: 3, event_id: "evt-3" });
  const older = liveEvent({ seq: 2, event_id: "evt-2" });
  const stale = liveEvent({ seq: 99, event_id: "evt-stale" });

  assert.deepEqual(liveDetailNavigation([newest, older], newest), {
    index: 0,
    position: 1,
    total: 2,
    previous: null,
    next: older,
  });
  assert.deepEqual(liveDetailNavigation([newest, older], older), {
    index: 1,
    position: 2,
    total: 2,
    previous: newest,
    next: null,
  });
  assert.deepEqual(liveDetailNavigation([newest, older], stale), {
    index: -1,
    position: 0,
    total: 2,
    previous: null,
    next: null,
  });
});

test("buildCommitRows stacks date separators and expanded-body height into each row offset", () => {
  // Two commits on one UTC day then one on the previous day, so the first and
  // third rows carry a "Commits on <date>" separator and the second does not.
  const commits = [
    activity({ external_id: "c1", kind: "commit", occurred_at: "2026-06-10T10:00:00Z", details: { sha: "a".repeat(16) } }),
    activity({ external_id: "c2", kind: "commit", occurred_at: "2026-06-10T02:00:00Z", details: { sha: "b".repeat(16), body: "Explain it" } }),
    activity({ external_id: "c3", kind: "commit", occurred_at: "2026-06-09T20:00:00Z", details: { sha: "c".repeat(16) } }),
  ];
  // Rows are keyed on activityKey = source_id|external_id (4.0.0 dropped `id`).
  // Measured heights win for any row: c2 is expanded (measured 200) and c3 is a
  // collapsed row measured at its natural content height (90), exercising the
  // narrow per-row measurement path. c1 has no measurement -> fixed estimate.
  const { rows, totalHeightPx } = buildCommitRows({
    commits,
    rowBodyHeight: 70, // COMMIT_ROW_BODY_HEIGHT_PX
    expandedBodyId: "github:github.com|c2",
    measuredBodyHeights: new Map([["github:github.com|c2", 200], ["github:github.com|c3", 90]]),
    timezone: "UTC",
  });

  // height = bodyHeight + (showDate ? 22 : 0) + 8 gap.
  assert.deepEqual(
    rows.map((r) => ({ index: r.index, offset: r.offset, height: r.height, showDate: r.showDate, expanded: r.expanded })),
    [
      { index: 0, offset: 0, height: 100, showDate: true, expanded: false }, // 70 (estimate) + 22 + 8
      { index: 1, offset: 100, height: 208, showDate: false, expanded: true }, // 200 (measured) + 0 + 8
      { index: 2, offset: 308, height: 120, showDate: true, expanded: false }, // 90 (measured) + 22 + 8
    ],
  );
  assert.equal(totalHeightPx, 428);
  assert.equal(rows[1]!.body, "Explain it");
  assert.equal(rows[0]!.body, null); // no details.body -> never expandable
});

test("commitVirtualRange returns the visible slice plus overscan over variable-height rows", () => {
  const dummy = activity({ id: "x", external_id: "x", kind: "commit", details: { sha: "a".repeat(16) } });
  const rows = Array.from({ length: 30 }, (_, i) => ({
    commit: dummy,
    index: i,
    offset: i * 100,
    height: 100,
    showDate: false,
    body: null,
    expanded: false,
  }));

  // scrollTop 1000 / viewport 250 => rows 10..12 visible, widened by the 8-row overscan.
  assert.deepEqual(commitVirtualRange({ rows, totalHeightPx: 3000, scrollTop: 1000, viewportHeight: 250 }), {
    start: 2,
    end: 21,
    totalHeightPx: 3000,
  });

  // empty + invalid inputs clamp instead of throwing.
  assert.deepEqual(commitVirtualRange({ rows: [], totalHeightPx: 0, scrollTop: 50, viewportHeight: 100 }), {
    start: 0,
    end: 0,
    totalHeightPx: 0,
  });
  assert.deepEqual(commitVirtualRange({ rows: rows.slice(0, 3), totalHeightPx: 300, scrollTop: Number.NaN, viewportHeight: Number.NaN }), {
    start: 0,
    end: 3,
    totalHeightPx: 300,
  });
});

test("resolveEdges + edgeMatches handle tracked and cross-repo endpoints", () => {
  const env: ContractEnvelope = {
    contract_version: "1.0.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [],
    items: [item({ id: "github:github.com|PR", external_id: "PR", kind: "change_request", state: "merged" }), item({ id: "github:github.com|IS", external_id: "IS", state: "closed" })],
    edges: [
      { type: "closes", from: "github:github.com|PR", to: "github:github.com|IS", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" },
      { type: "closes", from: "github:github.com|PR", to: "github:github.com|UNTRACKED", from_state: "merged", to_state: null, lifecycle: "declared" },
    ],
  };
  const resolved = resolveEdges(env, indexItems(env));
  assert.equal(resolved[0]!.from?.external_id, "PR");
  assert.equal(resolved[0]!.to?.external_id, "IS");
  assert.equal(resolved[1]!.to, null, "untracked endpoint resolves to null");
  // both endpoints untracked -> always shown; otherwise must match a resolved end
  assert.equal(edgeMatches(resolved[1]!, { ...emptyFilters(), states: new Set(["open"]) }), false, "merged PR end fails an open-only filter");
  assert.equal(edgeMatches(resolved[0]!, { ...emptyFilters(), states: new Set(["closed"]) }), true, "closed issue end passes");
});

test("v2 window helpers separate primary board items from endpoint extras", () => {
  const primary = item({ id: "primary", window_reasons: ["primary", "edge_endpoint"] });
  const endpoint = item({ id: "endpoint", window_reasons: ["edge_endpoint"] });
  const oldV1 = item({ id: "old-v1" });

  assert.equal(itemIsPrimaryWindow(primary), true);
  assert.equal(itemIsPrimaryWindow(endpoint), false);
  assert.equal(itemIsPrimaryWindow(oldV1), true, "missing reasons means old v1 full item payload");
});

test("deriveRepoOptions uses full v2 repo_stats instead of loaded item counts", () => {
  const env: ContractEnvelope = {
    contract_version: "2.0.0",
    generated_at: "2026-06-08T00:00:00Z",
    generator: "t",
    sources: [],
    items: [item({ id: "loaded", source_id: "github:github.com", project_path: "o/loaded" })],
    edges: [],
    item_window: {
      scope: "boardWindow",
      window: { kind: "active_since", basis: "item_updated_at", since: "2026-03-10T00:00:00.000Z", days: 90, edge_filter: null },
      primary_items: 1,
      edge_endpoint_items: 0,
      total_items: 11,
      truncated: true,
    },
    repo_stats: [
      { source_id: "github:github.com", project_path: "o/loaded", items: 1, by_state: { open: 1 }, by_kind: { issue: 1 } },
      { source_id: "github:github.com", project_path: "o/old", items: 10, by_state: { closed: 10 }, by_kind: { issue: 10 } },
    ],
  };

  assert.deepEqual(
    deriveRepoOptions(env).map((repo) => [repo.project_path, repo.count]),
    [["o/loaded", 1], ["o/old", 10]],
  );
});

test("deriveRepoOptions includes commit-only repos (in repo_metrics, not repo_stats) with count 0", () => {
  const env: ContractEnvelope = {
    contract_version: "3.5.0",
    generated_at: "2026-06-08T00:00:00Z",
    generator: "t",
    sources: [],
    items: [item({ id: "i1", source_id: "github:github.com", project_path: "o/has-items" })],
    edges: [],
    item_window: {
      scope: "boardWindow",
      window: { kind: "active_since", basis: "item_updated_at", since: "2026-03-10T00:00:00.000Z", days: 90, edge_filter: null },
      primary_items: 1,
      edge_endpoint_items: 0,
      total_items: 1,
      truncated: false,
    },
    repo_stats: [
      { source_id: "github:github.com", project_path: "o/has-items", items: 1, by_state: { open: 1 }, by_kind: { issue: 1 } },
    ],
    // o/commits-only has commit activity but NO work-items: it is in repo_metrics
    // but absent from repo_stats. It must still surface in the global source
    // filter (with a 0 item count) so its commits are reachable and toggleable.
    repo_metrics: [
      repoMetric({ source_id: "github:github.com", project_path: "o/commits-only" }),
    ],
  };

  assert.deepEqual(
    deriveRepoOptions(env).map((repo) => [repo.project_path, repo.count]),
    [["o/commits-only", 0], ["o/has-items", 1]],
  );
});

test("deriveRepoOptions surfaces each repo's last_activity_at from repo_metrics", () => {
  const env: ContractEnvelope = {
    contract_version: "3.5.0",
    generated_at: "2026-06-08T00:00:00Z",
    generator: "t",
    sources: [],
    items: [],
    edges: [],
    item_window: {
      scope: "boardWindow",
      window: { kind: "active_since", basis: "item_updated_at", since: "2026-03-10T00:00:00.000Z", days: 90, edge_filter: null },
      primary_items: 0,
      edge_endpoint_items: 0,
      total_items: 0,
      truncated: false,
    },
    repo_stats: [
      { source_id: "github:github.com", project_path: "o/active", items: 3, by_state: { open: 3 }, by_kind: { issue: 3 } },
      { source_id: "github:github.com", project_path: "o/no-metric", items: 1, by_state: { open: 1 }, by_kind: { issue: 1 } },
    ],
    repo_metrics: [
      repoMetric({
        source_id: "github:github.com",
        project_path: "o/active",
        data_quality: { activity_available: true, observed_since: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-21T04:00:00.000Z", notes: [] },
      }),
      repoMetric({
        source_id: "github:github.com",
        project_path: "o/commits-only",
        data_quality: { activity_available: true, observed_since: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-19T00:00:00.000Z", notes: [] },
      }),
    ],
  };

  const byPath = new Map(deriveRepoOptions(env).map((r) => [r.project_path, r.last_activity_at]));
  // A repo with a matching metric carries its last-activity instant ...
  assert.equal(byPath.get("o/active"), "2026-06-21T04:00:00.000Z");
  // ... including a commit-only repo that is absent from repo_stats ...
  assert.equal(byPath.get("o/commits-only"), "2026-06-19T00:00:00.000Z");
  // ... and a repo with no metric falls back to null.
  assert.equal(byPath.get("o/no-metric"), null);
});

test("computeStats counts items by state/kind and edges by lifecycle", () => {
  const items = [item({ state: "open", kind: "issue" }), item({ state: "merged", kind: "change_request" })];
  const stats = computeStats(items, [
    { type: "closes", from: "a|1", to: "b|2", from_state: null, to_state: null, lifecycle: "fulfilled" },
    { type: "relates", from: "a|1", to: "b|3", from_state: null, to_state: null, lifecycle: null },
  ]);
  assert.equal(stats.items, 2);
  assert.deepEqual(stats.byState, { open: 1, merged: 1 });
  assert.deepEqual(stats.byKind, { issue: 1, change_request: 1 });
  assert.deepEqual(stats.byLifecycle, { fulfilled: 1, other: 1 });
});

test("findContractScopedStats uses only exact scope/window/filter matches", () => {
  const aggregates: AggregateDTO[] = [
    {
      scope: "boardWindow",
      window: { kind: "active_since", basis: "item_updated_at", since: "2026-06-01T00:00:00.000Z", days: 7, edge_filter: null },
      stats: { items: 2, by_state: { open: 2 }, by_kind: { issue: 2 }, by_lifecycle: { declared: 1 } },
    },
    {
      scope: "graphWindow",
      window: { kind: "active_since", basis: "edge_endpoint_updated_at", since: "2026-06-01T00:00:00.000Z", days: 7, edge_filter: "no_mentions" },
      stats: { items: 3, by_state: { open: 2, merged: 1 }, by_kind: { issue: 2, change_request: 1 }, by_lifecycle: { fulfilled: 1 } },
    },
  ];

  const board = findContractScopedStats(aggregates, { scope: "boardWindow", since: "2026-06-01" });
  assert.equal(board?.scope, "boardWindow");
  assert.equal(board?.stats.items, 2);
  assert.deepEqual(board?.stats.byLifecycle, { declared: 1 });

  assert.equal(findContractScopedStats(aggregates, { scope: "boardWindow", since: "2026-06-02" }), null, "custom dates fall back to local computation");
  assert.equal(findContractScopedStats(aggregates, { scope: "graphWindow", since: "2026-06-01", edgeFilter: "all" }), null, "edge-filter mismatch falls back");
  assert.equal(findContractScopedStats(aggregates, { scope: "graphWindow", since: "2026-06-01", edgeFilter: "no_mentions" })?.stats.items, 3);
});

test("view scopes are explicit and keep the old full-filter stats available as global", () => {
  assert.deepEqual([...VIEW_SCOPES], ["global", "boardWindow", "graphWindow", "focus"]);
  assert.equal(VIEW_SCOPE_LABEL.boardWindow, "board window");
  const scoped = computeGlobalStats(
    [item({ id: "A", state: "open" }), item({ id: "B", state: "closed" })],
    [edge("A", "B", "fulfilled", "closes")],
  );
  assert.equal(scoped.scope, "global");
  assert.equal(scoped.stats.items, 2);
  assert.deepEqual(scoped.stats.byLifecycle, { fulfilled: 1 });
});

test("computeBoardWindowStats counts windowed items and only relationships touching them", () => {
  const recent = item({ id: "recent", state: "open", kind: "issue", updated_at: "2026-06-07T00:00:00Z" });
  const windowed = [recent];
  const edges = [
    edge("recent", "old", "declared", "closes"),
    edge("old", "other", "fulfilled", "closes"),
    edge("recent", "untracked|external", null, "mentions"),
  ];

  assert.deepEqual(
    boardWindowEdges(windowed, edges).map((e) => e.type),
    ["closes", "mentions"],
    "only relationships with at least one windowed board item are relevant",
  );
  const scoped = computeBoardWindowStats(windowed, edges);
  assert.equal(scoped.scope, "boardWindow");
  assert.equal(scoped.stats.items, 1);
  assert.deepEqual(scoped.stats.byState, { open: 1 });
  assert.deepEqual(scoped.stats.byLifecycle, { declared: 1, other: 1 });
});

test("computeGraphStats follows the graph window and can separately describe focus", () => {
  const recentIssue = item({ id: "recent-issue", state: "open", kind: "issue", updated_at: "2026-06-07T00:00:00Z" });
  const recentPr = item({ id: "recent-pr", state: "merged", kind: "change_request", updated_at: "2026-06-06T00:00:00Z" });
  const oldIssue = item({ id: "old-issue", state: "closed", kind: "issue", updated_at: "2020-01-01T00:00:00Z" });
  const oldPr = item({ id: "old-pr", state: "merged", kind: "change_request", updated_at: "2020-01-01T00:00:00Z" });
  const resolved: ResolvedEdge[] = [
    { edge: edge("recent-pr", "recent-issue", "fulfilled", "closes"), from: recentPr, to: recentIssue },
    { edge: edge("old-pr", "old-issue", "broken", "closes"), from: oldPr, to: oldIssue },
  ];
  const windowedEdges = graphWindowEdgesInRange(resolved, { from: "2026-06-01", to: "2026-06-07" });
  assert.equal(windowedEdges.length, 1);

  const overview = buildGraph(windowedEdges);
  const overviewStats = computeGraphStats(overview, "graphWindow");
  assert.equal(overviewStats.scope, "graphWindow");
  assert.equal(overviewStats.stats.items, 2, "graph stats count rendered nodes");
  assert.deepEqual(overviewStats.stats.byState, { merged: 1, open: 1 });
  assert.deepEqual(overviewStats.stats.byLifecycle, { fulfilled: 1 });

  const focus = focusSubgraph(resolved, "old-issue");
  const focusStats = computeGraphStats(focus, "focus");
  assert.equal(focusStats.scope, "focus");
  assert.equal(focusStats.stats.items, 2, "focus stats describe the focused subgraph, not the overview window");
  assert.deepEqual(focusStats.stats.byLifecycle, { broken: 1 });
});

test("relativeTime renders coarse buckets from an injected now", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");
  assert.equal(relativeTime("2026-06-07T00:00:00Z", now), "3d ago");
  assert.equal(relativeTime("2026-06-09T23:59:40Z", now), "just now");
  assert.equal(relativeTime(null, now), "—");
});

test("reviewThreadDisplayTime prefers the newest synced comment over last_seen_at", () => {
  const thread = reviewThread({
    last_seen_at: "2026-06-10T11:55:00Z",
    comments: [
      {
        id: "c1",
        author: "reviewer",
        avatar_url: null,
        body: "Earlier comment",
        url: null,
        created_at: "2026-06-10T08:00:00Z",
        updated_at: "2026-06-10T08:30:00Z",
      },
      {
        id: "c2",
        author: "maintainer",
        avatar_url: null,
        body: "Latest comment",
        url: null,
        created_at: "2026-06-10T09:00:00Z",
        updated_at: "2026-06-10T09:00:00Z",
      },
    ],
  });

  assert.equal(reviewThreadDisplayTime(thread), "2026-06-10T09:00:00Z");
});

test("reviewThreadDisplayTime falls back to last_seen_at when no comment timestamp is available", () => {
  assert.equal(reviewThreadDisplayTime(reviewThread()), "2026-06-10T11:55:00Z");
});

test("reviewThreadDisplayTime prefers last_comment_at over the (older) comment preview", () => {
  // A long thread: the preview holds only the OLDEST comments, so its newest
  // comment is absent. last_comment_at carries that true instant and must win
  // over both the stale preview and the same-sweep last_seen_at.
  const thread = reviewThread({
    comments_total: 25,
    last_comment_at: "2026-06-24T09:00:00Z",
    last_seen_at: "2026-06-25T00:00:00Z",
    comments: [reviewComment({ id: "old", created_at: "2026-06-01T08:00:00Z" })],
  });
  assert.equal(reviewThreadDisplayTime(thread), "2026-06-24T09:00:00Z");
});

test("reviewThreadDisplayTime lets a newer in-preview comment raise last_comment_at", () => {
  // last_comment_at is the primary key, but an in-preview comment edited AFTER it
  // (rarer, but real) still raises the recency key — last_comment_at is the floor.
  const thread = reviewThread({
    last_comment_at: "2026-06-24T09:00:00Z",
    comments: [reviewComment({ id: "edited", created_at: "2026-06-20T08:00:00Z", updated_at: "2026-06-24T12:00:00Z" })],
  });
  assert.equal(reviewThreadDisplayTime(thread), "2026-06-24T12:00:00Z");
});

// --- Reviews sort -----------------------------------------------------------
//
// The Reviews inbox can sort two ways. "recent" (the default) orders strictly
// by latest comment time across every source, so GitHub and GitLab interleave
// by recency. "grouped" keeps the legacy by-PR layout (unresolved-first, then
// repo + item). reviewSortFromRoute normalizes the URL token; only "grouped"
// leaves the default.

test("reviewSortFromRoute defaults to recency and only 'grouped' selects by-PR", () => {
  assert.equal(reviewSortFromRoute(null), "recent");
  assert.equal(reviewSortFromRoute(undefined), "recent");
  assert.equal(reviewSortFromRoute(""), "recent");
  assert.equal(reviewSortFromRoute("recent"), "recent");
  assert.equal(reviewSortFromRoute("nonsense"), "recent");
  assert.equal(reviewSortFromRoute("grouped"), "grouped");
});

test("compareReviewThreadsRecent orders by latest comment time globally across sources", () => {
  // The multi-source recency case the inbox got wrong: a fresh GitHub thread must
  // outrank a stale GitLab thread regardless of source, repo, or item number —
  // grouped order led with project_path, so every GitLab thread sorted first.
  const freshGithub = reviewThread({
    id: "github:github.com|T_fresh",
    source_id: "github:github.com",
    project_path: "sympoies/symphony-board",
    target_iid: 7,
    comments: [reviewComment({ id: "g1", created_at: "2026-06-23T10:00:00Z" })],
    last_seen_at: "2026-06-23T10:00:00Z",
  });
  const staleGitlab = reviewThread({
    id: "gitlab:gitlab.com|T_stale",
    source_id: "gitlab:gitlab.com",
    project_path: "gitlab-org/labkit",
    target_iid: 999,
    comments: [reviewComment({ id: "l1", created_at: "2026-02-01T10:00:00Z" })],
    last_seen_at: "2026-02-01T10:00:00Z",
  });
  const sorted = [staleGitlab, freshGithub].sort(compareReviewThreadsRecent);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["github:github.com|T_fresh", "gitlab:gitlab.com|T_stale"],
  );
});

test("compareReviewThreadsRecent uses the newest comment, not item iid, within one repo", () => {
  // #519 was commented on more recently than #523, so it sorts first even though
  // its iid is lower — breaking the higher-iid≈newer correlation grouped relied on.
  const newer519 = reviewThread({ id: "t519", target_iid: 519, comments: [reviewComment({ created_at: "2026-06-17T00:00:00Z" })] });
  const older523 = reviewThread({ id: "t523", target_iid: 523, comments: [reviewComment({ created_at: "2026-06-11T00:00:00Z" })] });
  const sorted = [older523, newer519].sort(compareReviewThreadsRecent);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["t519", "t523"],
  );
});

test("compareReviewThreadsRecent ranks a long thread by last_comment_at, not its older preview", () => {
  // The #449 case: an actively-updated thread whose comments_total exceeds the
  // synced preview, so its newest comment is OUTSIDE comments[]. Pre-fix it fell
  // back to a same-sweep last_seen_at and sorted as stale; last_comment_at now
  // carries the true latest-comment time so the busy long thread leads.
  const busyLong = reviewThread({
    id: "t_busy",
    comments_total: 30,
    last_comment_at: "2026-06-24T18:00:00Z",
    last_seen_at: "2026-06-25T00:00:00Z",
    comments: [reviewComment({ id: "old", created_at: "2026-06-01T08:00:00Z" })],
  });
  const quietRecent = reviewThread({
    id: "t_quiet",
    comments_total: 1,
    last_comment_at: "2026-06-22T10:00:00Z",
    last_seen_at: "2026-06-25T00:00:00Z",
    comments: [reviewComment({ id: "c", created_at: "2026-06-22T10:00:00Z" })],
  });
  const sorted = [quietRecent, busyLong].sort(compareReviewThreadsRecent);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["t_busy", "t_quiet"],
  );
});

test("compareReviewThreadsRecent breaks exact-time ties deterministically", () => {
  // Two threads sharing a last_seen_at from the same sweep (no comment instants)
  // must keep a stable, antisymmetric order across renders, not wobble.
  const a = reviewThread({ id: "t_a", project_path: "o/r", target_iid: 2, comments: [], last_seen_at: "2026-06-10T11:55:00Z" });
  const b = reviewThread({ id: "t_b", project_path: "o/r", target_iid: 2, comments: [], last_seen_at: "2026-06-10T11:55:00Z" });
  assert.notEqual(compareReviewThreadsRecent(a, b), 0);
  assert.equal(Math.sign(compareReviewThreadsRecent(a, b)), -Math.sign(compareReviewThreadsRecent(b, a)));
});

test("compareReviewThreadsGrouped keeps unresolved-first, repo + item grouping (legacy by-PR order)", () => {
  const unresolved = reviewThread({ id: "t_open", project_path: "o/r", target_iid: 5, is_resolved: false, comments: [] });
  const resolvedHighIid = reviewThread({ id: "t_done_hi", project_path: "o/r", target_iid: 9, is_resolved: true, comments: [] });
  const resolvedOtherRepo = reviewThread({ id: "t_done_a", project_path: "a/r", target_iid: 1, is_resolved: true, comments: [] });
  const sorted = [resolvedHighIid, unresolved, resolvedOtherRepo].sort(compareReviewThreadsGrouped);
  // unresolved first; then resolved grouped by repo (a/ before o/), item iid desc within a repo.
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["t_open", "t_done_a", "t_done_hi"],
  );
});

test("reviewThreadComparator selects the comparator for the active sort", () => {
  assert.equal(reviewThreadComparator("recent"), compareReviewThreadsRecent);
  assert.equal(reviewThreadComparator("grouped"), compareReviewThreadsGrouped);
});

// reviewResolution drives the thread-detail's trailing "resolved" row: it returns
// null for an unresolved thread (no row), and otherwise a ready-to-render label
// echoing who resolved it (the contract carries no resolved_at, so it is timeless).
test("reviewResolution returns null for an unresolved thread", () => {
  assert.equal(reviewResolution(reviewThread({ is_resolved: false, resolved_by: null })), null);
  // resolved_by present but still open -> no resolution row (open state wins)
  assert.equal(reviewResolution(reviewThread({ is_resolved: false, resolved_by: "someone" })), null);
});

test("reviewResolution labels a resolved thread by its resolver", () => {
  assert.deepEqual(reviewResolution(reviewThread({ is_resolved: true, is_outdated: false, resolved_by: "dobi-bot[bot]" })), {
    by: "dobi-bot[bot]",
    outdated: false,
    label: "Resolved by @dobi-bot[bot]",
  });
});

test("reviewResolution falls back to a generic label when the resolver is unknown", () => {
  assert.deepEqual(reviewResolution(reviewThread({ is_resolved: true, is_outdated: false, resolved_by: null })), {
    by: null,
    outdated: false,
    label: "Marked as resolved",
  });
  // whitespace-only resolver is treated as unknown
  assert.equal(reviewResolution(reviewThread({ is_resolved: true, resolved_by: "  " }))?.by, null);
});

test("reviewResolution flags a resolved-but-outdated thread", () => {
  const r = reviewResolution(reviewThread({ is_resolved: true, is_outdated: true, resolved_by: "maintainer" }));
  assert.equal(r?.outdated, true);
  assert.equal(r?.label, "Resolved by @maintainer");
});

// resetsIn is the future-facing mirror of relativeTime (the rate-limit tab's
// "resets in …"); every branch from an injected now.
test("resetsIn renders a future delta and clamps the past to 'now'", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");
  const at = (sec: number) => new Date(now + sec * 1000).toISOString();
  assert.equal(resetsIn(at(30), now), "in 30s");
  assert.equal(resetsIn(at(5 * 60), now), "in 5m");
  assert.equal(resetsIn(at(90 * 60), now), "in 2h", "rounds to the nearest hour");
  assert.equal(resetsIn(at(0), now), "now");
  assert.equal(resetsIn(at(-120), now), "now", "a past reset clamps to now, never a negative");
  assert.equal(resetsIn(null, now), "—");
  assert.equal(resetsIn(undefined, now), "—");
  assert.equal(resetsIn("not-a-date", now), "not-a-date", "unparseable echoes through");
});

test("pluralize returns the singular only for exactly one, with irregular plurals", () => {
  assert.equal(pluralize(1, "event"), "event");
  assert.equal(pluralize(0, "event"), "events");
  assert.equal(pluralize(2, "event"), "events");
  // default plural is the regular "+s"; pass an explicit plural for irregulars
  assert.equal(pluralize(2, "repo"), "repos");
  assert.equal(pluralize(1, "branch", "branches"), "branch");
  assert.equal(pluralize(3, "branch", "branches"), "branches");
});

test("cutoffIso is deterministic for a fixed now", () => {
  const now = Date.parse("2026-06-07T00:00:00Z");
  assert.equal(cutoffIso(90, now).slice(0, 10), "2026-03-09");
});

test("graphOverviewVisibility keeps mention-only nodes discoverable while the overview canvas is decluttered", () => {
  const issue = item({ id: "issue-345", kind: "issue", state: "open", iid: 345, title: "Mention-only issue", updated_at: "2026-06-14T05:28:48Z" });
  const mentionedPr = item({ id: "pr-343", kind: "change_request", state: "merged", iid: 343, updated_at: "2026-06-14T05:27:16Z" });
  const closedIssue = item({ id: "issue-341", kind: "issue", state: "closed", iid: 341, updated_at: "2026-06-14T05:23:13Z" });
  const closer = item({ id: "pr-339", kind: "change_request", state: "merged", iid: 339, updated_at: "2026-06-14T05:24:00Z" });
  const resolved: ResolvedEdge[] = [
    { edge: edge("issue-345", "pr-343", null, "mentions"), from: issue, to: mentionedPr },
    { edge: edge("pr-339", "issue-341", "fulfilled", "closes"), from: closer, to: closedIssue },
  ];

  const overview = graphOverviewVisibility(resolved, { from: "2026-06-14", to: "2026-06-14" }, "UTC", { showMentions: false, mentionTarget: "all" });
  assert.deepEqual(overview.candidateEdges.map((re) => re.edge.type), ["mentions", "closes"], "the side list indexes all in-range relationships");
  assert.deepEqual(overview.drawnEdges.map((re) => re.edge.type), ["closes"], "the canvas keeps the default no-mentions declutter");
  assert.equal(overview.candidateIds.has("issue-345"), true, "mention-only item remains discoverable in the side list");
  assert.equal(overview.drawnIds.has("issue-345"), false, "mention-only item is not drawn until mentions are enabled");

  const withMentions = graphOverviewVisibility(resolved, { from: "2026-06-14", to: "2026-06-14" }, "UTC", { showMentions: true, mentionTarget: "all" });
  assert.equal(withMentions.drawnIds.has("issue-345"), true, "enabling mentions promotes the same item onto the canvas");
});

test("graphCanvasEmptyReason diagnoses why the overview canvas is empty so the empty state can offer a one-click recovery", () => {
  const issue = item({ id: "issue-345", kind: "issue", state: "closed", iid: 345, updated_at: "2026-06-14T05:28:48Z" });
  const mentionedPr = item({ id: "pr-343", kind: "change_request", state: "merged", iid: 343, updated_at: "2026-06-14T05:27:16Z" });
  const otherIssue = item({ id: "issue-200", kind: "issue", state: "closed", iid: 200, updated_at: "2026-06-14T05:20:00Z" });
  // Two mention edges, one to a PR and one to an issue — the screenshot scenario:
  // in-range candidates exist, but they are all mentions, hidden by default.
  const mentionOnly: ResolvedEdge[] = [
    { edge: edge("issue-345", "pr-343", null, "mentions"), from: issue, to: mentionedPr },
    { edge: edge("issue-345", "issue-200", null, "mentions"), from: issue, to: otherIssue },
  ];
  const range = { from: "2026-06-14", to: "2026-06-14" };

  // Default (mentions off): all candidates are mention links -> tell the user and
  // offer to enable mentions.
  const hidden = graphOverviewVisibility(mentionOnly, range, "UTC", { showMentions: false, mentionTarget: "all" });
  assert.deepEqual(graphCanvasEmptyReason(hidden, { showMentions: false, mentionTarget: "all" }), { kind: "mentions-hidden", hiddenLinks: 2 }, "mentions-off + only mention candidates -> mentions-hidden with the hidden count");

  // Mentions on but filtered to PRs: the two issue-targeted mentions drop out ->
  // tell the user the target filter is hiding them.
  const filtered = graphOverviewVisibility(
    [{ edge: edge("issue-345", "issue-200", null, "mentions"), from: issue, to: otherIssue }],
    range,
    "UTC",
    { showMentions: true, mentionTarget: "change_request" },
  );
  assert.deepEqual(
    graphCanvasEmptyReason(filtered, { showMentions: true, mentionTarget: "change_request" }),
    { kind: "mention-target-filtered", mentionTarget: "change_request", hiddenLinks: 1 },
    "mentions-on but every candidate filtered by target -> mention-target-filtered",
  );

  // The other target arm: with only a PR-targeted mention in range, filtering to
  // issues drops it -> the same diagnosis, carrying the "issue" target.
  const prMention: ResolvedEdge[] = [{ edge: edge("issue-345", "pr-343", null, "mentions"), from: issue, to: mentionedPr }];
  const issueFiltered = graphOverviewVisibility(prMention, range, "UTC", { showMentions: true, mentionTarget: "issue" });
  assert.deepEqual(
    graphCanvasEmptyReason(issueFiltered, { showMentions: true, mentionTarget: "issue" }),
    { kind: "mention-target-filtered", mentionTarget: "issue", hiddenLinks: 1 },
    "filtering to issues hides the PR-targeted mention",
  );

  // Defensive `filtered` fallback — a non-mention candidate that is somehow not
  // drawn with mentions on + target all. Unreachable through
  // graphOverviewVisibility, so build the visibility shape directly.
  const fallback = graphCanvasEmptyReason(
    { candidateEdges: [{ edge: edge("a", "b", null, "closes"), from: null, to: null }], drawnEdges: [], candidateIds: new Set(["a", "b"]), drawnIds: new Set() },
    { showMentions: true, mentionTarget: "all" },
  );
  assert.deepEqual(fallback, { kind: "filtered", hiddenLinks: 1 }, "showMentions + target all + no drawn edges -> filtered fallback");

  // Canvas has drawn edges -> no empty reason (the Flow renders).
  const drawn = graphOverviewVisibility(
    [{ edge: edge("pr-339", "issue-341", "fulfilled", "closes"), from: mentionedPr, to: issue }],
    range,
    "UTC",
    { showMentions: false, mentionTarget: "all" },
  );
  assert.equal(graphCanvasEmptyReason(drawn, { showMentions: false, mentionTarget: "all" }), null, "a non-empty canvas has no empty reason");

  // No candidates at all -> null (the outer "No relationships in this range." owns that).
  const none = graphOverviewVisibility([], range, "UTC", { showMentions: false, mentionTarget: "all" });
  assert.equal(graphCanvasEmptyReason(none, { showMentions: false, mentionTarget: "all" }), null, "no candidates -> outer empty state, not this one");
});

test("buildGraph keeps only edge-connected nodes and flags untracked ends", () => {
  const pr = item({ id: "P", kind: "change_request", state: "merged", updated_at: "2026-06-01T00:00:00Z", url: "https://pr" });
  const iss = item({ id: "I", kind: "issue", state: "closed", created_at: "2026-05-20T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", title: "Closed issue" });
  const oldPr = item({ id: "OP", kind: "change_request", state: "merged", updated_at: "2020-01-01T00:00:00Z" });
  const oldIss = item({ id: "OI", kind: "issue", state: "closed", updated_at: "2020-01-01T00:00:00Z" });
  const edges: ResolvedEdge[] = [
    { edge: { type: "closes", from: "P", to: "I", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" }, from: pr, to: iss },
    { edge: { type: "closes", from: "OP", to: "OI", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" }, from: oldPr, to: oldIss },
    { edge: { type: "closes", from: "P", to: "github:github.com|UNTRACKED", from_state: "merged", to_state: null, lifecycle: "declared" }, from: pr, to: null },
  ];
  const g = buildGraph([edges[0]!, edges[2]!]);
  assert.equal(g.links.length, 2, "the caller supplies the already-windowed edge set");
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(ids.has("P") && ids.has("I") && ids.has("github:github.com|UNTRACKED"));
  assert.ok(!ids.has("OP") && !ids.has("OI"), "nodes outside the window are excluded");
  const untracked = g.nodes.find((n) => n.id === "github:github.com|UNTRACKED");
  assert.equal(untracked?.untracked, true);
  assert.equal(untracked?.label, "UNTRACKED", "untracked label is the bare ref tail");
  assert.equal(untracked?.created_at, null, "untracked node carries no timestamps");
  assert.equal(untracked?.updated_at, null);
  // tracked nodes carry created_at / updated_at through to the node card
  const tracked = g.nodes.find((n) => n.id === "I");
  assert.equal(tracked?.created_at, "2026-05-20T00:00:00Z", "tracked node carries created_at");
  assert.equal(tracked?.updated_at, "2026-06-01T00:00:00Z", "tracked node carries updated_at");
  // ...and the author, for the list-card-style counts row (@author 💬 🔗)
  assert.equal(tracked?.author, "a", "tracked node carries the author");
  assert.equal(untracked?.author, null, "untracked node has no author");
  assert.equal(buildGraph(edges).links.length, 3, "the graph renderer keeps every supplied edge");
});

// The Graph page's focus view: focusSubgraph builds the focused item + its direct
// neighbours and every edge among that set, from the loaded/range edge payload.
// A focus shows every available relationship; the overview graph's mentions
// toggle does not apply in focus.
const redge = (from: string, to: string, type: string): ResolvedEdge => ({
  edge: { type, from, to, from_state: null, to_state: null, lifecycle: type === "closes" ? "fulfilled" : null },
  from: item({ id: from, updated_at: "2020-01-01T00:00:00Z" }),
  to: item({ id: to, updated_at: "2020-01-01T00:00:00Z" }),
});

test("focusSubgraph: a focus shows its full loaded neighbourhood — every edge type", () => {
  const edges: ResolvedEdge[] = [
    redge("A", "F", "closes"),
    redge("B", "F", "mentions"), // a mention TO the focus IS drawn (the overview filters mentions; focus does not)
    redge("A", "B", "relates"), // neighbour–neighbour edge among the kept set is kept too
    redge("A", "Z", "closes"), // Z does not touch the focus -> excluded
  ];
  const g = focusSubgraph(edges, "F");
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["A", "B", "F"], "focus + direct neighbours only (Z dropped)");
  assert.equal(g.links.length, 3, "A-F, B-F, A-B all kept, including the mention");
  assert.ok(g.links.some((l) => l.type === "mentions"), "the mention to the focus is drawn");
});

test("focusSubgraph: a focus with no incident edges yields an empty graph (caller falls back)", () => {
  assert.equal(focusSubgraph([], "F").nodes.length, 0);
  assert.equal(focusSubgraph([redge("X", "Y", "closes")], "F").nodes.length, 0, "no edge touches F -> empty");
});

test("repoKey is collision-proof and deriveRepos handles an empty contract", () => {
  assert.equal(repoKey("github:github.com", "o/a"), repoKey("github:github.com", "o/a"), "stable for equal inputs");
  assert.notEqual(repoKey("github:github.com", null), repoKey("github:github.com", ""), "null path != empty path");
  assert.notEqual(repoKey("a", "b c"), repoKey("a b", "c"), "no separator collision across the (source, path) boundary");
  assert.deepEqual(deriveRepos([]), [], "no items -> no repos");
});

test("sourceDisplayName drops provider prefix from source ids", () => {
  assert.equal(sourceDisplayName("github:github.com"), "github.com");
  assert.equal(sourceDisplayName("gitlab:gitlab.internal"), "gitlab.internal");
  assert.equal(sourceDisplayName("legacy-source"), "legacy-source");
  assert.equal(sourceDisplayName("github:"), "github:");
});

test("visibleHeaderSources follows Settings source visibility", () => {
  const sources: SourceDTO[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok", color: null },
    { source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", display_name: "GitLab", last_success_at: null, last_status: "ok", color: null },
    { source_id: "gitlab:internal", kind: "gitlab", host: "gitlab.internal", display_name: "GitLab (self-hosted)", last_success_at: null, last_status: "ok", color: null },
  ];

  assert.deepEqual(
    visibleHeaderSources(sources, new Set(["github:github.com"])).map((s) => s.source_id),
    ["gitlab:gitlab.com", "gitlab:internal"],
  );
});

test("deriveRepos groups items into (source, project_path) repos with counts, sorted", () => {
  const repos = deriveRepos([
    item({ source_id: "github:github.com", project_path: "o/b" }),
    item({ source_id: "github:github.com", project_path: "o/a" }),
    item({ source_id: "github:github.com", project_path: "o/a" }),
    item({ source_id: "gitlab:gitlab.com", project_path: "g/x" }),
    item({ source_id: "github:github.com", project_path: null }),
  ]);
  assert.deepEqual(
    repos.map((r) => [r.source_id, r.project_path, r.count]),
    [
      ["github:github.com", null, 1], // null path sorts first within the source
      ["github:github.com", "o/a", 2],
      ["github:github.com", "o/b", 1],
      ["gitlab:gitlab.com", "g/x", 1],
    ],
  );
  assert.equal(repos[1]!.key, repoKey("github:github.com", "o/a"));
});

test("applyVisibility drops a hidden repo's items AND every edge touching it", () => {
  const env: ContractEnvelope = {
    contract_version: "1.0.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [],
    items: [
      item({ id: "gh|PR", source_id: "github:github.com", project_path: "o/a", kind: "change_request", state: "merged" }),
      item({ id: "gh|IS", source_id: "github:github.com", project_path: "o/a", state: "closed" }),
      item({ id: "gl|MR", source_id: "gitlab:gitlab.com", project_path: "g/x", kind: "change_request", state: "open" }),
    ],
    edges: [
      { type: "closes", from: "gh|PR", to: "gh|IS", from_state: "merged", to_state: "closed", lifecycle: "fulfilled" }, // both ends in o/a (both hidden)
      { type: "relates", from: "gh|IS", to: "gl|MR", from_state: "closed", to_state: "open", lifecycle: null }, // cross-repo: hidden + visible
      { type: "mentions", from: "gh|PR", to: "gh|EXT", from_state: "merged", to_state: null, lifecycle: null }, // hidden + untracked
      { type: "closes", from: "gl|MR", to: "gh|EXT", from_state: "open", to_state: null, lifecycle: "declared" }, // visible + untracked
    ],
    activities: [
      activity({ id: "gh|A", source_id: "github:github.com", project_path: "o/a" }),
      activity({ id: "gl|A", source_id: "gitlab:gitlab.com", project_path: "g/x" }),
    ],
    repo_metrics: [
      repoMetric({ source_id: "github:github.com", project_path: "o/a" }),
      repoMetric({ source_id: "gitlab:gitlab.com", project_path: "g/x" }),
    ],
  };
  // nothing hidden -> identical reference (cheap no-op)
  assert.equal(applyVisibility(env, new Set()), env);

  const view = applyVisibility(env, new Set([repoKey("github:github.com", "o/a")]));
  assert.deepEqual(view.items.map((i) => i.id), ["gl|MR"], "only the gitlab repo's item survives");
  // every edge touching o/a is dropped — including the hidden->untracked one (an
  // untracked counterpart does NOT rescue an edge whose other end is hidden).
  // Only the visible->untracked "closes" edge survives.
  assert.deepEqual(
    view.edges.map((e) => e.type),
    ["closes"],
    "edges touching the hidden repo are removed; the visible-end + untracked edge stays",
  );
  assert.equal(view.edges[0]!.from, "gl|MR");
  assert.deepEqual(view.activities?.map((a) => a.id), ["gl|A"], "activity rows in hidden repos are removed");
  assert.deepEqual(view.repo_metrics?.map((m) => m.source_id), ["gitlab:gitlab.com"], "repo metrics follow the same visibility boundary");
});

test("repoMetricMatches supports source/state/kind/search filters and sortRepoMetrics ranks active repos", () => {
  const active = repoMetric({
    source_id: "github:github.com",
    project_path: "o/active",
    totals: {
      ...repoMetric().totals,
      activities: 12,
      activity_score: 2,
      items_active: 4,
      by_item_state: { open: 3, merged: 1 },
      by_item_kind: { issue: 3, change_request: 1 },
    },
    top_actors: [{ actor: "alice", actor_key: "provider-user:github:github.com:alice", display_name: "alice", activities: 7, commits: 5, items_opened: 2, change_requests_merged: 1 }],
  });
  const quiet = repoMetric({
    source_id: "gitlab:gitlab.com",
    project_path: "g/quiet",
    totals: {
      ...repoMetric().totals,
      activities: 1,
      activity_score: 20,
      items_active: 1,
      by_item_state: { closed: 1 },
      by_item_kind: { issue: 1 },
    },
    top_actors: [{ actor: "bob", actor_key: "provider-user:gitlab:gitlab.com:bob", display_name: "bob", activities: 1, commits: 0, items_opened: 1, change_requests_merged: 0 }],
  });

  assert.equal(repoMetricMatches(active, emptyFilters()), true);
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), sources: new Set(["gitlab:gitlab.com"]) }), false);
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), states: new Set(["open"]) }), true);
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), states: new Set(["closed"]) }), false);
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), kinds: new Set(["change_request"]) }), true);
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), search: "alice workflow" }), true);
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), search: "missing" }), false);
  // exact-repo lens (irepo) maps onto a repo metric's project_path, no prefix collision.
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), repos: new Set(["o/active"]) }), true);
  assert.equal(repoMetricMatches(active, { ...emptyFilters(), repos: new Set(["o/active2"]) }), false, "exact match, not a prefix");
  assert.deepEqual(sortRepoMetrics([quiet, active]).map((metric) => metric.project_path), ["g/quiet", "o/active"]);
});

test("repoCoverage classifies a window against the repo's all-time activity bounds", () => {
  // window is 2026-06-01 .. 2026-06-07 in the default fixture.
  const win = (over: Partial<RepoMetricDTO["data_quality"]>) =>
    repoCoverage(repoMetric({ data_quality: { activity_available: true, observed_since: "2026-06-01T00:00:00.000Z", last_activity_at: "2026-06-20T00:00:00.000Z", notes: [], ...over } }));

  // observed since the window start, still active past it -> fully covered.
  assert.equal(win({}), "ok");
  // earliest-observed instant sits AFTER the window start -> early counts are missing.
  assert.equal(win({ observed_since: "2026-06-04T00:00:00.000Z" }), "partial");
  // last activity predates the window -> the in-window zeros are real dormancy.
  assert.equal(win({ observed_since: "2026-05-01T00:00:00.000Z", last_activity_at: "2026-05-20T00:00:00.000Z" }), "stale");
  // no activity rows at all -> commit/review metrics are unreliable.
  assert.equal(win({ activity_available: false, observed_since: null, last_activity_at: null }), "no_activity");
  // stale wins over partial when both timestamps fall before the window start.
  assert.equal(win({ observed_since: "2026-05-01T00:00:00.000Z", last_activity_at: "2026-05-31T23:59:59.000Z" }), "stale");
});

test("repoTrend scales bars for an active series and falls back to a flat baseline when idle", () => {
  const baseStats = repoMetric().totals;
  const point = (activity_score: number): RepoMetricSeriesPointDTO => ({
    bucket_start: "2026-06-01T00:00:00.000Z",
    bucket_end: "2026-06-01T23:59:59.999Z",
    stats: { ...baseStats, activity_score },
  });

  // Active repo: bar heights scale to the window max, with a 10% floor so a
  // small non-zero bucket still shows a nub.
  const active = repoTrend([point(10), point(0), point(5)]);
  assert.equal(active.flat, false);
  assert.deepEqual(active.bars.map((bar) => bar.height), [100, 10, 50]);
  assert.deepEqual(active.bars.map((bar) => bar.value), [10, 0, 5]);

  // Idle repo: every bucket is zero -> a single flat baseline, NOT a row of
  // clamped 10% min-height bars that reads as a blank/broken dashed line.
  const idle = repoTrend([point(0), point(0), point(0)]);
  assert.equal(idle.flat, true);
  assert.deepEqual(idle.bars, []);

  // A repo with no observed buckets at all is flat too, never a blank grid.
  assert.equal(repoTrend([]).flat, true);

  // Only the trailing 16 buckets render.
  const many = repoTrend(Array.from({ length: 20 }, (_, i) => point(i + 1)));
  assert.equal(many.bars.length, 16);
});

test("applyVisibility hides a whole source independently of the repo set", () => {
  const env: ContractEnvelope = {
    contract_version: "1.1.0", generated_at: "2026-06-07T00:00:00Z", generator: "t", sources: [],
    items: [
      item({ id: "gh|A", source_id: "github:github.com", project_path: "o/a" }),
      item({ id: "gl|B", source_id: "gitlab:gitlab.com", project_path: "g/x" }),
    ],
    edges: [{ type: "relates", from: "gh|A", to: "gl|B", from_state: "open", to_state: "open", lifecycle: null }],
    activities: [
      activity({ id: "gh|act", source_id: "github:github.com", project_path: "o/a" }),
      activity({ id: "gl|act", source_id: "gitlab:gitlab.com", project_path: "g/x" }),
    ],
  };
  // hide the github SOURCE with an EMPTY repo set: gh|A and the cross-repo edge go.
  const view = applyVisibility(env, new Set(), new Set(["github:github.com"]));
  assert.deepEqual(view.items.map((i) => i.id), ["gl|B"], "the hidden source's item is gone");
  assert.deepEqual(view.edges, [], "the edge touching the hidden source is gone");
  assert.deepEqual(view.activities?.map((a) => a.id), ["gl|act"], "the hidden source's activity is gone");
  // the two layers compose (OR): hide gitlab's repo AND github's source -> nothing.
  const both = applyVisibility(env, new Set([repoKey("gitlab:gitlab.com", "g/x")]), new Set(["github:github.com"]));
  assert.deepEqual(both.items.map((i) => i.id), [], "source-hide and repo-hide compose");
});

test("buildColorIndex + resolveRepoColor resolve override -> repo -> source -> none", () => {
  const env: ContractEnvelope = {
    contract_version: "1.1.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [
      { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GH", last_success_at: null, last_status: "ok", color: "#111111" },
      { source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", display_name: "GL", last_success_at: null, last_status: "ok", color: null },
    ],
    items: [],
    edges: [],
    repos: [{ source_id: "github:github.com", project_path: "o/repo", color: "#222222" }],
  };
  const idx = buildColorIndex(env);
  const none = new Map<string, string>();
  assert.equal(resolveRepoColor("github:github.com", "o/repo", idx, none), "#222222", "repo color beats source color");
  assert.equal(resolveRepoColor("github:github.com", "O/REPO", idx, none), "#222222", "repo match is case-insensitive (GitHub canonicalizes case)");
  assert.equal(resolveRepoColor("github:github.com", "o/other", idx, none), "#111111", "no repo color -> source color");
  assert.equal(resolveRepoColor("gitlab:gitlab.com", "g/x", idx, none), null, "no repo and no source color -> none");
  const ov = new Map([[repoKey("github:github.com", "o/repo"), "#abcdef"]]);
  assert.equal(resolveRepoColor("github:github.com", "o/repo", idx, ov), "#abcdef", "an override beats everything");
});

test("isHexColor accepts #rgb/#rrggbb only; buildColorIndex drops anything else (CSS-sink guard)", () => {
  assert.equal(isHexColor("#abc"), true);
  assert.equal(isHexColor("#A1B2C3"), true);
  for (const bad of ["red", "#abcd", "#12g", "url(https://evil/x)", "#fff; background:url(x)", "", null, 123])
    assert.equal(isHexColor(bad as unknown), false, `rejects ${JSON.stringify(bad)}`);
  // a non-hex color in the contract is dropped, not indexed -> no highlight
  const env: ContractEnvelope = {
    contract_version: "1.1.0", generated_at: "2026-06-07T00:00:00Z", generator: "t",
    sources: [{ source_id: "s", kind: "github", host: "h", display_name: null, last_success_at: null, last_status: null, color: "url(https://evil/x)" }],
    items: [], edges: [],
    repos: [{ source_id: "s", project_path: "o/r", color: "javascript:alert(1)" }],
  };
  const idx = buildColorIndex(env);
  assert.equal(resolveRepoColor("s", "o/r", idx, new Map()), null, "malformed config colors never reach a CSS sink");
});

test("buildAdjacency records both directions per edge and dedupes", () => {
  const re = (from: string, to: string, type: string): ResolvedEdge => ({
    edge: { type, from, to, from_state: null, to_state: null, lifecycle: null },
    from: null,
    to: null,
  });
  const adj = buildAdjacency([
    re("PR", "IS", "closes"),
    re("PR", "IS", "closes"), // duplicate edge -> deduped
    re("PR", "EXT", "mentions"),
  ]);
  // PR sees both its targets, as outgoing
  assert.deepEqual(adj.get("PR"), [
    { ref: "IS", type: "closes", direction: "out" },
    { ref: "EXT", type: "mentions", direction: "out" },
  ]);
  // IS sees PR as an incoming "closes"
  assert.deepEqual(adj.get("IS"), [{ ref: "PR", type: "closes", direction: "in" }]);
  assert.deepEqual(adj.get("EXT"), [{ ref: "PR", type: "mentions", direction: "in" }]);
});

test("buildAdjacency handles empty input, distinct types on one pair, and self-loops", () => {
  const re = (from: string, to: string, type: string): ResolvedEdge => ({
    edge: { type, from, to, from_state: null, to_state: null, lifecycle: null },
    from: null,
    to: null,
  });
  assert.equal(buildAdjacency([]).size, 0, "no edges -> empty map");

  // same pair, two edge types -> both kept (dedupe is per (ref, type, direction))
  const twoTypes = buildAdjacency([re("A", "B", "closes"), re("A", "B", "relates")]);
  assert.deepEqual(twoTypes.get("A"), [
    { ref: "B", type: "closes", direction: "out" },
    { ref: "B", type: "relates", direction: "out" },
  ]);

  // self-loop -> both an out and an in entry on the same ref
  assert.deepEqual(buildAdjacency([re("X", "X", "relates")]).get("X"), [
    { ref: "X", type: "relates", direction: "out" },
    { ref: "X", type: "relates", direction: "in" },
  ]);
});

test("relatedItems gives one card per ref: strongest type wins, mutual -> both", () => {
  const out = relatedItems([
    { ref: "B", type: "mentions", direction: "out" },
    { ref: "B", type: "mentions", direction: "in" }, // mutual mention with B...
    { ref: "B", type: "closes", direction: "in" }, // ...but B also closes -> closes wins (stronger after weaker)
    { ref: "C", type: "mentions", direction: "out" }, // mention only -> stays "out"
    { ref: "D", type: "closes", direction: "in" }, // closes only -> stays "in"
    { ref: "E", type: "mentions", direction: "out" },
    { ref: "E", type: "mentions", direction: "in" }, // mutual mention, no stronger type -> "both"
    { ref: "F", type: "closes", direction: "out" },
    { ref: "F", type: "mentions", direction: "in" }, // weaker after stronger -> dropped
  ]);
  assert.deepEqual(out, [
    { ref: "B", type: "closes", direction: "in" }, // one card; closes beats the mention
    { ref: "C", type: "mentions", direction: "out" },
    { ref: "D", type: "closes", direction: "in" },
    { ref: "E", type: "mentions", direction: "both" },
    { ref: "F", type: "closes", direction: "out" },
  ]);
});

function gnode(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "id", label: "label", repo: "o/r", iid: 1, kind: "issue", state: "open", url: null,
    color: "#000", demand: 0, created_at: null, updated_at: null, untracked: false, ...over,
  };
}

test("compareGraphNodes orders by state bucket then newest-created, not demand", () => {
  const openOld = gnode({ id: "o1", label: "open-old", state: "open", created_at: "2026-01-01T00:00:00Z", demand: 0 });
  const o2 = gnode({ id: "o2", label: "open-newer", state: "open", created_at: "2026-05-01T00:00:00Z" });
  const mergedNew = gnode({ id: "m1", label: "merged-new", state: "merged", created_at: "2026-06-01T00:00:00Z", demand: 99 });
  const closedNew = gnode({ id: "c1", label: "closed-new", state: "closed", created_at: "2026-06-02T00:00:00Z" });
  const c2 = gnode({ id: "c2", label: "closed-older", state: "closed", created_at: "2026-05-01T00:00:00Z" });

  // open beats closed/merged regardless of recency or (high) demand
  assert.ok(compareGraphNodes(openOld, mergedNew) < 0, "open before merged even when older / lower-demand");
  assert.ok(compareGraphNodes(openOld, closedNew) < 0, "open before closed even when older");
  // within a bucket: newest created_at first; closed & merged share one bucket
  assert.ok(compareGraphNodes(o2, openOld) < 0, "newer open before older open");
  assert.ok(compareGraphNodes(mergedNew, c2) < 0, "merged & closed share a bucket, ordered by date");

  const order = [c2, mergedNew, openOld, closedNew, o2].slice().sort(compareGraphNodes).map((n) => n.id);
  assert.deepEqual(order, ["o2", "o1", "c1", "m1", "c2"], "opens (newest→oldest), then closed/merged (newest→oldest)");
});

test("compareGraphNodes: undated nodes sort last in their bucket, with a stable id tie-break", () => {
  const dated = gnode({ id: "d", label: "dated", state: "open", created_at: "2026-01-01T00:00:00Z" });
  const undatedZ = gnode({ id: "zzz", label: "u", state: "open", created_at: null });
  const undatedA = gnode({ id: "aaa", label: "u", state: "open", created_at: null });
  assert.ok(compareGraphNodes(dated, undatedZ) < 0, "a dated node precedes an undated one in the same bucket");
  assert.ok(compareGraphNodes(undatedZ, dated) > 0, "and the relation is symmetric");
  assert.ok(compareGraphNodes(undatedZ, undatedA) > 0, "equal label -> id breaks the tie deterministically ('aaa' < 'zzz')");

  // same bucket + same created_at + same label -> id is the final, stable tie-break
  const t1 = gnode({ id: "b", label: "same", state: "closed", created_at: "2026-03-03T00:00:00Z" });
  const t2 = gnode({ id: "a", label: "same", state: "merged", created_at: "2026-03-03T00:00:00Z" });
  assert.ok(compareGraphNodes(t1, t2) > 0, "same bucket/date/label -> id tie-break stays stable");
});

test("parseHashRoute splits page from optional deep-link and range params", () => {
  const emptyRoute = { focus: null, q: null, source: null, repo: null, branch: null, kind: null, action: null, isource: null, istate: null, ikind: null, ireview: null, irepo: null, unresolved: null, from: null, to: null, preset: null, tab: null, liveDetail: null, reviewDetail: null, reviewSort: null };
  assert.deepEqual(parseHashRoute(""), { page: "", ...emptyRoute }, "empty hash -> app default, no params");
  assert.deepEqual(parseHashRoute("#/"), { page: "", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/board"), { page: "board", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/graph"), { page: "graph", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/settings"), { page: "settings", ...emptyRoute });
  // focus + q are pulled off the hash and percent-decoded
  assert.deepEqual(parseHashRoute("#/graph?focus=github%3Agithub.com%7C42&q=owner%2Frepo%20%2342"), {
    page: "graph",
    ...emptyRoute,
    focus: "github:github.com|42",
    q: "owner/repo #42",
  });
  // the Commits page's repo filter is pulled off the hash and percent-decoded
  assert.deepEqual(parseHashRoute("#/commits?source=gitlab%3Agitlab.com&repo=example-group%2Fsymphony-board-fixture&branch=feature%2Fui"), {
    page: "commits",
    ...emptyRoute,
    source: "gitlab:gitlab.com",
    repo: "example-group/symphony-board-fixture",
    branch: "feature/ui",
  });
  assert.deepEqual(parseHashRoute("#/activity?source=github%3Agithub.com&repo=o%2Fr&kind=issue&action=opened&from=2026-06-01&to=2026-06-07&preset=this-week"), {
    page: "activity",
    ...emptyRoute,
    source: "github:github.com",
    repo: "o/r",
    kind: "issue",
    action: "opened",
    from: "2026-06-01",
    to: "2026-06-07",
    preset: "this-week",
  });
  // params on a non-graph page still parse (App only acts on them for the graph)
  assert.deepEqual(parseHashRoute("#/?focus=x"), { page: "", ...emptyRoute, focus: "x" });
  // empty/absent values are normalized to null
  assert.deepEqual(parseHashRoute("#/graph?focus="), { page: "graph", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/graph?q=%20%20"), { page: "graph", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/commits?source=%20&repo=%20%20&branch=%20"), { page: "commits", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/graph?other=1&preset=bad"), { page: "graph", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/live?liveDetail=1"), { page: "live", ...emptyRoute, liveDetail: "1" });
  assert.deepEqual(parseHashRoute("#/live?liveDetail=%20"), { page: "live", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/reviews?reviewDetail=1"), { page: "reviews", ...emptyRoute, reviewDetail: "1" });
  assert.deepEqual(parseHashRoute("#/reviews?reviewDetail=%20"), { page: "reviews", ...emptyRoute });
  assert.deepEqual(parseHashRoute("#/reviews?reviewSort=grouped"), { page: "reviews", ...emptyRoute, reviewSort: "grouped" });
  assert.deepEqual(parseHashRoute("#/reviews?reviewSort=%20"), { page: "reviews", ...emptyRoute });
});

test("buildHashRoute writes the same route shape parseHashRoute reads", () => {
  assert.equal(buildHashRoute({ page: "" }), "#/");
  assert.equal(buildHashRoute({ page: "board" }), "#/board");
  assert.equal(buildHashRoute({ page: "graph", q: "owner/repo #13" }), "#/graph?q=owner%2Frepo%20%2313");
  assert.equal(buildHashRoute({ page: "activity", from: "2026-06-01", to: "2026-06-07", preset: "this-week" }), "#/activity?from=2026-06-01&to=2026-06-07&preset=this-week");
  assert.equal(
    buildHashRoute({ page: "graph", focus: "github:github.com|42", q: "owner/repo #42" }),
    "#/graph?focus=github%3Agithub.com%7C42&q=owner%2Frepo%20%2342",
  );
  // the Commits page's repo filter round-trips through "?repo="
  assert.equal(
    buildHashRoute({ page: "commits", source: "gitlab:gitlab.com", repo: "example-group/symphony-board-fixture", branch: "feature/ui", preset: "this-week", from: "2026-06-01", to: "2026-06-07" }),
    "#/commits?source=gitlab%3Agitlab.com&repo=example-group%2Fsymphony-board-fixture&branch=feature%2Fui&from=2026-06-01&to=2026-06-07&preset=this-week",
  );
  assert.equal(
    buildHashRoute({ page: "activity", source: "github:github.com", repo: "o/r", kind: "issue", action: "opened", from: "2026-06-01", to: "2026-06-07" }),
    "#/activity?source=github%3Agithub.com&repo=o%2Fr&kind=issue&action=opened&from=2026-06-01&to=2026-06-07",
  );
  assert.equal(buildHashRoute({ page: "settings", q: "  " }), "#/settings");
  assert.equal(buildHashRoute({ page: "live", liveDetail: "1" }), "#/live?liveDetail=1");
  assert.equal(buildHashRoute({ page: "reviews", reviewDetail: "1" }), "#/reviews?reviewDetail=1");
  assert.equal(buildHashRoute({ page: "reviews", reviewSort: "grouped" }), "#/reviews?reviewSort=grouped");
  assert.deepEqual(parseHashRoute(buildHashRoute({ page: "", q: "owner/repo #13" })), {
    page: "",
    source: null,
    focus: null,
    q: "owner/repo #13",
    repo: null,
    branch: null,
    kind: null,
    action: null,
    isource: null,
    istate: null,
    ikind: null,
    ireview: null,
    irepo: null,
    unresolved: null,
    from: null,
    to: null,
    preset: null,
    tab: null,
    liveDetail: null,
    reviewDetail: null,
    reviewSort: null,
  });
  assert.deepEqual(parseHashRoute(buildHashRoute({ page: "board", q: "owner/repo #13" })), {
    page: "board",
    source: null,
    focus: null,
    q: "owner/repo #13",
    repo: null,
    branch: null,
    kind: null,
    action: null,
    isource: null,
    istate: null,
    ikind: null,
    ireview: null,
    irepo: null,
    unresolved: null,
    from: null,
    to: null,
    preset: null,
    tab: null,
    liveDetail: null,
    reviewDetail: null,
    reviewSort: null,
  });
  assert.deepEqual(parseHashRoute(buildHashRoute({ page: "commits", source: "github:github.com", repo: "owner/repo", branch: "main" })), {
    page: "commits",
    focus: null,
    q: null,
    source: "github:github.com",
    repo: "owner/repo",
    branch: "main",
    kind: null,
    action: null,
    isource: null,
    istate: null,
    ikind: null,
    ireview: null,
    irepo: null,
    unresolved: null,
    from: null,
    to: null,
    preset: null,
    tab: null,
    liveDetail: null,
    reviewDetail: null,
    reviewSort: null,
  });
});

test("graphFocusHref round-trips an item's id through parseHashRoute without touching q", () => {
  const it = (over: Partial<ItemDTO>) => item(over);
  for (const over of [
    { id: "github:github.com|42", project_path: "owner/repo", iid: 42 },
    { id: "gitlab:gitlab.com|gid://gitlab/Issue/1", project_path: "grp/sub/proj", iid: 1 },
    { id: "a|b/c:d", project_path: null, iid: null, title: "Bare title", external_id: "b/c:d" },
  ]) {
    const r = parseHashRoute(graphFocusHref(it(over)));
    assert.equal(r.page, "graph");
    assert.equal(r.focus, over.id, `focus round-trips for ${over.id}`);
    assert.equal(r.q, null, `the deep-link leaves the search bar alone for ${over.id}`);
  }
});

test("applyRouteSearch mirrors the route q so search never hides outside the URL", () => {
  const route = (q: string | null) => ({ page: "graph", focus: null, q, source: null, repo: null, branch: null, kind: null, action: null, isource: null, istate: null, ikind: null, ireview: null, irepo: null, unresolved: null, from: null, to: null, preset: null, tab: null, liveDetail: null, reviewDetail: null, reviewSort: null });
  // a present q seeds the search (deep-link narrowing / URL-backed user search)
  assert.equal(applyRouteSearch(emptyFilters(), route("owner/repo #13")).search, "owner/repo #13");
  // an absent q clears search, so navigating to "#/graph" cannot carry a hidden
  // board/deep-link query that is missing from the URL.
  const typed = { ...emptyFilters(), search: "user typed" };
  assert.deepEqual(applyRouteSearch(typed, route(null)), emptyFilters(), "absent q -> clear search");
  // q equal to the current search -> same object (no needless re-render)
  const cur = { ...emptyFilters(), search: "owner/repo #13" };
  assert.equal(applyRouteSearch(cur, route("owner/repo #13")), cur, "unchanged q -> same reference");
  const empty = emptyFilters();
  assert.equal(applyRouteSearch(empty, route(null)), empty, "already-empty search -> same reference");
});

test("relationCounts: one count per distinct neighbour, strongest type wins (board-card relation count)", () => {
  assert.equal(relationCounts([]).size, 0, "no edges -> empty map");
  const counts = relationCounts([
    // A both closes AND mentions B -> B is ONE related item for A, shown as closes
    { type: "closes", from: "s|A", to: "s|B", from_state: "open", to_state: "open", lifecycle: "declared" },
    { type: "mentions", from: "s|A", to: "s|B", from_state: null, to_state: null, lifecycle: null },
    // reciprocal mentions (A <-> C) collapse to ONE related item on each side
    { type: "mentions", from: "s|A", to: "s|C", from_state: null, to_state: null, lifecycle: null },
    { type: "mentions", from: "s|C", to: "s|A", from_state: null, to_state: null, lifecycle: null },
    // an untracked ref still counts (harmless — it never matches a board item id)
    { type: "relates", from: "s|A", to: "s|UNTRACKED", from_state: null, to_state: null, lifecycle: null },
  ]);
  const a = counts.get("s|A");
  assert.equal(a?.total, 3, "A's neighbours are B, C, UNTRACKED — edges don't double-count");
  // tooltip breakdown is ordered strongest-first (closes > mentions > relates)
  assert.deepEqual(a?.byType, [
    { type: "closes", count: 1 },
    { type: "mentions", count: 1 },
    { type: "relates", count: 1 },
  ]);
  assert.deepEqual(counts.get("s|B"), { total: 1, byType: [{ type: "closes", count: 1 }] }, "B sees A once, as closes");
  assert.deepEqual(counts.get("s|C"), { total: 1, byType: [{ type: "mentions", count: 1 }] });
  // keys are exactly the edge-endpoint set ("any edge -> a node"), so map
  // membership also gates the card's focus-in-graph link.
  assert.deepEqual([...counts.keys()].sort(), ["s|A", "s|B", "s|C", "s|UNTRACKED"]);
});

test("relationCountOf summarises one item's adjacency refs (graph side-list count)", () => {
  assert.equal(relationCountOf([]), null, "no refs -> null (no chip)");
  // the same collapse as relationCounts, but fed from buildAdjacency's
  // per-direction RelatedRef list: B via closes+mentions is ONE neighbour
  // (closes wins), C's reciprocal mentions are ONE neighbour.
  const count = relationCountOf([
    { ref: "s|B", type: "closes", direction: "out" },
    { ref: "s|B", type: "mentions", direction: "out" },
    { ref: "s|C", type: "mentions", direction: "out" },
    { ref: "s|C", type: "mentions", direction: "in" },
  ]);
  assert.deepEqual(count, {
    total: 2,
    byType: [
      { type: "closes", count: 1 },
      { type: "mentions", count: 1 },
    ],
  });
});

// --- manual sync control plane helpers ---

function syncRun(over: Partial<SyncRunStatus> = {}): SyncRunStatus {
  return {
    run_id: "20260608T190000Z-0001",
    trigger: "manual",
    mode: "incremental",
    dry_run: false,
    source_scope: null,
    status: "ok",
    started_at: "2026-06-08T19:00:00Z",
    finished_at: "2026-06-08T19:00:05Z",
    emitted: true,
    totals: { items: 7, edges: 2, activities: 3, soft_deleted: 0, soft_deleted_edges: 0 },
    sources: [],
    error: null,
    ...over,
  };
}

test("isSyncRunActive is true only for a running run", () => {
  assert.equal(isSyncRunActive(syncRun({ status: "running" })), true);
  assert.equal(isSyncRunActive(syncRun({ status: "ok" })), false);
  assert.equal(isSyncRunActive(null), false);
});

test("syncProducedFreshData only when a non-dry run emitted without failing", () => {
  assert.equal(syncProducedFreshData(syncRun({ status: "ok", emitted: true })), true);
  assert.equal(syncProducedFreshData(syncRun({ status: "partial", emitted: true })), true, "partial still emitted fresh data");
  assert.equal(syncProducedFreshData(syncRun({ status: "ok", dry_run: true, emitted: false })), false, "a dry-run never refreshes the data view");
  assert.equal(syncProducedFreshData(syncRun({ status: "error", emitted: false })), false, "a failed run is not fresh");
  assert.equal(syncProducedFreshData(syncRun({ status: "running" })), false);
  assert.equal(syncProducedFreshData(null), false);
});

test("syncRunSummary distinguishes running, reloaded, dry-run, and error states", () => {
  const now = Date.parse("2026-06-08T19:00:10Z");
  assert.match(syncRunSummary(syncRun({ status: "running" }), now), /Syncing incremental/);
  assert.match(syncRunSummary(syncRun({ status: "ok", emitted: true }), now), /Synced .* · 7 items · contract reloaded/);
  assert.match(syncRunSummary(syncRun({ dry_run: true, emitted: false }), now), /Dry-run completed/);
  assert.match(syncRunSummary(syncRun({ status: "error", emitted: false, error: "boom" }), now), /Sync failed .*: boom/);
  // A lease-denied run: another writer held the store, the run was
  // skipped — benign, never "Synced", never "failed".
  assert.match(syncRunSummary(syncRun({ status: "skipped", emitted: false, totals: null }), now), /Sync skipped .*another writer/);
  assert.equal(syncRunSummary(null, now), "");
});

test("syncRunSummary labels background runs and ticks elapsed time while running", () => {
  const now = Date.parse("2026-06-08T19:00:12Z"); // 12s after the fixture's started_at
  assert.equal(
    syncRunSummary(syncRun({ status: "running", trigger: "scheduled", finished_at: null }), now),
    "Background sync running incremental · 12s",
  );
  assert.equal(syncRunSummary(syncRun({ status: "running", finished_at: null }), now), "Syncing incremental · 12s");
  // A long full sweep reads minutes + seconds, with the scope kept in place.
  const later = Date.parse("2026-06-08T19:02:05Z");
  assert.equal(
    syncRunSummary(syncRun({ status: "running", mode: "full", source_scope: "gh", finished_at: null }), later),
    "Syncing full · gh · 2m 5s",
  );
  // An unparsable start timestamp omits the elapsed segment rather than NaN.
  assert.equal(syncRunSummary(syncRun({ status: "running", started_at: "bogus", finished_at: null }), now), "Syncing incremental");
  // Finished scheduled runs read the same as manual ones — only running copy differs.
  assert.match(syncRunSummary(syncRun({ trigger: "scheduled" }), now), /^Synced /);
});

test("syncRunSummary stays one short line while running — chips carry per-source state", () => {
  const now = Date.parse("2026-06-08T19:00:10Z");
  const done = { items: 1, edges: 0, activities: 0, soft_deleted: 0, soft_deleted_edges: 0, error: null };
  const running = syncRun({
    status: "running",
    finished_at: null,
    totals: null,
    sources: [{ source_id: "github:main", status: "ok", ...done }],
    active_source_id: "gitlab:main",
  });
  // Per-source progress lives on the source chips (liveSourceStatus), not in
  // the status text — a three-source run must not wrap the header line.
  assert.equal(syncRunSummary(running, now), "Syncing incremental · 10s");
});

test("liveSourceStatus overlays the active run's per-source state onto a chip", () => {
  const done = { items: 1, edges: 0, activities: 0, soft_deleted: 0, soft_deleted_edges: 0, error: null };
  const running = syncRun({
    status: "running",
    finished_at: null,
    totals: null,
    sources: [
      { source_id: "github:main", status: "ok", ...done },
      { source_id: "gitlab:old", status: "skipped", ...done },
      { source_id: "gitlab:broken", status: "error", ...done, error: "boom" },
    ],
    active_source_id: "gitlab:main",
  });
  assert.equal(liveSourceStatus(running, "gitlab:main"), "syncing", "the in-flight source reads syncing");
  assert.equal(liveSourceStatus(running, "github:main"), "ok", "a source this run finished shows its fresh outcome");
  assert.equal(liveSourceStatus(running, "gitlab:broken"), "error", "a mid-run failure is visible immediately");
  assert.equal(liveSourceStatus(running, "gitlab:old"), "skipped");
  assert.equal(liveSourceStatus(running, "gitlab:pending"), null, "a source the run has not reached keeps its contract status");
  // No active run: the overlay never applies (a finished run's freshness comes
  // from the reloaded contract instead).
  assert.equal(liveSourceStatus(syncRun({ status: "ok" }), "github:main"), null);
  assert.equal(liveSourceStatus(null, "github:main"), null);
});

test("buildActivityHeatmap buckets activities into a 53-week UTC calendar grid", () => {
  const now = Date.parse("2026-06-08T12:00:00Z");
  const activities = [
    activity({ id: "t1", occurred_at: "2026-06-08T01:00:00Z", kind: "commit" }),
    activity({ id: "t2", occurred_at: "2026-06-08T22:00:00Z", kind: "commit" }),
    activity({ id: "t3", occurred_at: "2026-06-08T23:30:00Z", kind: "issue" }),
    activity({ id: "y1", occurred_at: "2026-06-01T08:00:00Z", kind: "commit" }),
    // Far outside the trailing 12-month window — must be excluded entirely.
    activity({ id: "old", occurred_at: "2024-01-01T00:00:00Z", kind: "commit" }),
    // After "today" — must not leak into a future cell.
    activity({ id: "future", occurred_at: "2026-06-30T00:00:00Z", kind: "commit" }),
  ];

  const hm = buildActivityHeatmap(activities, now);

  assert.equal(hm.weeks.length, 53, "53 week columns");
  assert.ok(hm.weeks.every((w) => w.length === 7), "each column has 7 weekday rows");
  assert.equal(hm.to, "2026-06-08");

  const cells = hm.weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null);
  const byDate = new Map(cells.map((c) => [c.date, c]));

  assert.equal(byDate.get("2026-06-08")?.count, 3, "three events land on the busiest day");
  assert.equal(byDate.get("2026-06-01")?.count, 1);
  assert.equal(byDate.get("2024-01-01"), undefined, "out-of-window day is not in the grid");

  // No cell may carry a date after today — future activity stays out.
  assert.ok(cells.every((c) => c.date <= "2026-06-08"), "no future-dated cells");
  assert.equal(byDate.get("2026-06-30"), undefined);

  assert.equal(hm.total, 4, "only the four in-window events count");
  assert.equal(hm.activeDays, 2, "events landed on two distinct in-window days");
  assert.equal(hm.dayCount, 366, "summary denominator covers the visible trailing window days");
  assert.equal(hm.maxCount, 3);
  assert.equal(hm.busiest?.date, "2026-06-08");
  assert.deepEqual(hm.byKind, [
    { kind: "commit", count: 3 },
    { kind: "issue", count: 1 },
  ]);

  const busy = byDate.get("2026-06-08");
  const quiet = byDate.get("2026-06-01");
  assert.ok((busy?.level ?? 0) > (quiet?.level ?? 0), "denser day gets a higher level");
  assert.equal(byDate.get("2026-05-15")?.level, 0, "an empty day is level 0");
});

test("buildActivityHeatmapFromDaily mirrors the raw builder, anchored at the aggregate `to`", () => {
  // Same shape as the raw-activity heatmap test, but expressed as per-day buckets
  // and anchored at `to` (the contract generated_at day), not a UI clock.
  const daily: ActivityDailyDTO = {
    timezone: "UTC",
    from: "2024-01-01",
    to: "2026-06-08",
    total: 6,
    by_kind: { commit: 5, issue: 1 },
    days: [
      { date: "2024-01-01", count: 1, by_kind: { commit: 1 } }, // before the trailing window
      { date: "2026-06-01", count: 1, by_kind: { commit: 1 } },
      { date: "2026-06-08", count: 3, by_kind: { commit: 2, issue: 1 } },
      { date: "2026-06-30", count: 1, by_kind: { commit: 1 } }, // after `to`
    ],
  };

  const hm = buildActivityHeatmapFromDaily(daily);
  assert.equal(hm.weeks.length, 53, "53 week columns");
  assert.equal(hm.to, "2026-06-08");
  const byDate = new Map(
    hm.weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c.date, c]),
  );
  assert.equal(byDate.get("2026-06-08")?.count, 3);
  assert.equal(byDate.get("2026-06-01")?.count, 1);
  assert.equal(byDate.get("2024-01-01"), undefined, "pre-window day excluded");
  assert.equal(byDate.get("2026-06-30"), undefined, "day after `to` excluded");
  assert.equal(hm.total, 4, "only in-window buckets count");
  assert.equal(hm.activeDays, 2);
  assert.equal(hm.maxCount, 3);
  assert.equal(hm.busiest?.date, "2026-06-08");
  assert.deepEqual(hm.byKind, [
    { kind: "commit", count: 3 },
    { kind: "issue", count: 1 },
  ]);
});

test("activityDailyExtent returns the first/last day with activity, optionally per kind", () => {
  const daily: ActivityDailyDTO = {
    timezone: "UTC",
    from: "2025-02-01",
    to: "2026-06-08",
    total: 4,
    by_kind: { commit: 3, review: 1 },
    days: [
      { date: "2025-02-01", count: 1, by_kind: { review: 1 } },
      { date: "2025-08-01", count: 2, by_kind: { commit: 2 } },
      { date: "2026-06-08", count: 1, by_kind: { commit: 1 } },
    ],
  };
  assert.deepEqual(activityDailyExtent(daily), { from: "2025-02-01", to: "2026-06-08" });
  assert.deepEqual(activityDailyExtent(daily, "commit"), { from: "2025-08-01", to: "2026-06-08" });
  assert.equal(activityDailyExtent(daily, "push"), null, "no day matches the kind");
  assert.equal(
    activityDailyExtent({ timezone: "UTC", from: "2026-06-08", to: "2026-06-08", total: 0, by_kind: {}, days: [] }),
    null,
    "no activity at all",
  );
});

test("activitySummaryKindCounts projects byKind onto the curated kinds in a fixed, aligned order", () => {
  // byKind arrives sorted by count — issue dominates, change_request is absent.
  // Both summaries must still read commit -> change request -> review, so a
  // count-driven order like this one is irrelevant to the output.
  const byKind = [
    { kind: "issue", count: 9 },
    { kind: "commit", count: 5 },
    { kind: "branch", count: 3 },
    { kind: "review", count: 2 },
  ];

  assert.deepEqual(activitySummaryKindCounts(byKind), [
    { kind: "commit", count: 5 },
    { kind: "change_request", count: 0 }, // absent kind zero-fills, never drops out
    { kind: "review", count: 2 }, // review is always the last tile
  ]);

  // Order is driven by the constant, not by input order: feed the curated kinds
  // already out of fixed position and they must still come back commit-first.
  assert.deepEqual(
    activitySummaryKindCounts([
      { kind: "review", count: 7 },
      { kind: "change_request", count: 4 },
      { kind: "commit", count: 1 },
    ]),
    [
      { kind: "commit", count: 1 },
      { kind: "change_request", count: 4 },
      { kind: "review", count: 7 },
    ],
  );

  // The order is the contract both panels share, and review anchors the end.
  assert.deepEqual([...ACTIVITY_SUMMARY_KINDS], ["commit", "change_request", "review"]);
  assert.equal(activitySummaryKindCounts([]).at(-1)?.kind, "review");
  assert.deepEqual(
    activitySummaryKindCounts([]).map((k) => k.count),
    [0, 0, 0],
    "an empty window still renders every curated tile at zero",
  );
});

test("buildActivityHeatmap buckets days in the configured timezone", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // 2026-06-08T18:00Z is 2026-06-09 02:00 in Asia/Taipei — a different calendar day.
  const activities = [activity({ id: "late", occurred_at: "2026-06-08T18:00:00Z", kind: "commit" })];
  const counts = (tz: string): Map<string, number> => {
    const hm = buildActivityHeatmap(activities, now, tz);
    return new Map(
      hm.weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c.date, c.count]),
    );
  };

  const utc = counts("UTC");
  assert.equal(utc.get("2026-06-08"), 1);
  assert.equal(utc.get("2026-06-09") ?? 0, 0);

  const tpe = counts("Asia/Taipei");
  assert.equal(tpe.get("2026-06-09"), 1, "late-night UTC activity lands on the local day");
  assert.equal(tpe.get("2026-06-08") ?? 0, 0);
});

test("buildActivityTrend returns daily points and a smoothed activity average", () => {
  const trend = buildActivityTrend(
    [
      activity({ id: "d1", occurred_at: "2026-06-01T12:00:00Z", project_path: "owner/quiet" }),
      activity({ id: "d2a", occurred_at: "2026-06-02T12:00:00Z", kind: "commit", project_path: "owner/busy" }),
      activity({ id: "d2b", occurred_at: "2026-06-02T13:00:00Z", kind: "commit", project_path: "owner/busy" }),
      activity({ id: "out", occurred_at: "2026-06-05T12:00:00Z", project_path: "owner/out" }),
    ],
    { from: "2026-06-01", to: "2026-06-04" },
  );

  assert.equal(trend.total, 3);
  assert.equal(trend.activeDays, 2, "selected range has activity on two days");
  assert.equal(trend.dayCount, 4, "selected range spans four inclusive days");
  assert.equal(trend.bucket, "day");
  assert.equal(trend.maxCount, 2);
  assert.equal(trend.points.length, 4);
  assert.deepEqual(
    trend.points.map((point) => [point.date, point.count]),
    [
      ["2026-06-01", 1],
      ["2026-06-02", 2],
      ["2026-06-03", 0],
      ["2026-06-04", 0],
    ],
  );
  assert.equal(trend.points[1]?.average, 0.75);
  assert.equal(trend.maxAverage, 1);
  assert.deepEqual(trend.busiest, { date: "2026-06-02", label: "2026-06-02", count: 2 });
  assert.deepEqual(trend.byKind, [
    { kind: "commit", count: 2 },
    { kind: "issue", count: 1 },
  ]);
  assert.deepEqual(trend.byRepo, [
    { source_id: "github:github.com", project_path: "owner/busy", count: 2 },
    { source_id: "github:github.com", project_path: "owner/quiet", count: 1 },
  ]);
});

test("buildActivityTrend exposes per-kind series aligned to the bucket axis", () => {
  const trend = buildActivityTrend(
    [
      activity({ id: "s1", occurred_at: "2026-06-01T12:00:00Z", kind: "commit" }),
      activity({ id: "s2", occurred_at: "2026-06-02T12:00:00Z", kind: "commit" }),
      activity({ id: "s3", occurred_at: "2026-06-02T13:00:00Z", kind: "review" }),
      activity({ id: "s4", occurred_at: "2026-06-03T12:00:00Z", kind: "change_request" }),
      activity({ id: "s5", occurred_at: "2026-06-03T13:00:00Z", kind: "issue" }),
    ],
    { from: "2026-06-01", to: "2026-06-03" },
  );

  assert.equal(trend.total, 5, "the range total still counts every activity row");
  assert.deepEqual(trend.points.map((point) => point.count), [1, 2, 2]);

  // The aggregate chart series comes first and sums the curated lines the chart
  // displays, so uncurated activity kinds do not dominate the plotted scale.
  assert.equal(trend.series[0]?.kind, "total");
  assert.deepEqual(
    trend.series[0]?.points.map((point) => point.count),
    [1, 2, 1],
  );
  assert.equal(trend.series[0]?.total, 4);

  // Series come in a stable order: total first, then kinds by descending count
  // (ties broken by kind name).
  assert.deepEqual(
    trend.series.map((series) => series.kind),
    ["total", "commit", "change_request", "issue", "review"],
  );

  // Per-kind series carry one entry per kind seen, each aligned 1:1 with the
  // shared bucket axis.
  const byKind = new Map(trend.series.map((series) => [series.kind, series]));
  assert.deepEqual(byKind.get("total")?.points.map((point) => point.count), [1, 2, 1]);
  assert.deepEqual(byKind.get("commit")?.points.map((point) => point.count), [1, 1, 0]);
  assert.deepEqual(byKind.get("review")?.points.map((point) => point.count), [0, 1, 0]);
  assert.deepEqual(byKind.get("change_request")?.points.map((point) => point.count), [0, 0, 1]);
  assert.deepEqual(byKind.get("issue")?.points.map((point) => point.count), [0, 0, 1]);

  // The smoothing and the per-series maxima the chart scales on are pinned, not
  // just the raw counts (commit counts [1,1,0] over a day bucket, radius 2).
  assert.equal(byKind.get("commit")?.total, 2);
  assert.deepEqual(byKind.get("commit")?.points.map((point) => point.average), [2 / 3, 2 / 3, 2 / 3]);
  assert.equal(byKind.get("commit")?.maxCount, 1);
  assert.equal(byKind.get("commit")?.maxAverage, 2 / 3);

  for (const series of trend.series) {
    assert.equal(series.points.length, trend.points.length);
    assert.ok(series.points.every((point) => typeof point.average === "number"));
  }
});

test("buildActivityTrend series: total-only for a valid empty range, hourly alignment, none for an invalid range", () => {
  // A valid range with no activity still yields the (zeroed) total series and no
  // kind lines.
  const empty = buildActivityTrend([], { from: "2026-06-01", to: "2026-06-03" });
  assert.deepEqual(empty.series.map((series) => series.kind), ["total"]);
  assert.equal(empty.series[0]?.total, 0);
  assert.equal(empty.series[0]?.points.length, empty.points.length);

  // The per-kind series follow the hourly axis (24 buckets, radius-1 smoothing).
  const hourly = buildActivityTrend(
    [activity({ id: "hk", occurred_at: "2026-06-10T13:00:00Z", kind: "commit" })],
    { from: "2026-06-10", to: "2026-06-10" },
  );
  assert.equal(hourly.bucket, "hour");
  assert.ok(hourly.series.every((series) => series.points.length === 24));
  assert.deepEqual(hourly.series.map((series) => series.kind), ["total", "commit"]);

  // An inverted (invalid) range short-circuits to an empty series list.
  assert.deepEqual(buildActivityTrend([], { from: "2026-06-03", to: "2026-06-01" }).series, []);
});

test("buildActivityTrend uses hourly buckets for a single selected day", () => {
  const trend = buildActivityTrend(
    [
      activity({ id: "h1", occurred_at: "2026-06-10T00:30:00Z" }),
      activity({ id: "h2a", occurred_at: "2026-06-10T13:00:00Z" }),
      activity({ id: "h2b", occurred_at: "2026-06-10T13:30:00Z" }),
    ],
    { from: "2026-06-10", to: "2026-06-10" },
  );

  assert.equal(trend.bucket, "hour");
  assert.equal(trend.points.length, 24);
  assert.equal(trend.points[0]?.label, "00:00");
  assert.equal(trend.points[23]?.label, "23:00");
  assert.equal(trend.points[0]?.count, 1);
  assert.equal(trend.points[13]?.count, 2);
  assert.equal(trend.total, 3);
  assert.deepEqual(trend.busiest, { date: "2026-06-10T13", label: "13:00", count: 2 });
});

test("buildActivityTrend rolls longer ranges up to weekly buckets", () => {
  const trend = buildActivityTrend(
    [
      activity({ id: "w1", occurred_at: "2026-03-01T12:00:00Z" }),
      activity({ id: "w2", occurred_at: "2026-03-08T12:00:00Z" }),
      activity({ id: "w3", occurred_at: "2026-05-30T12:00:00Z" }),
    ],
    { from: "2026-03-01", to: "2026-06-01" },
  );

  assert.equal(trend.bucket, "week");
  assert.equal(trend.points.length, 14);
  assert.deepEqual(
    trend.points.filter((point) => point.count > 0).map((point) => [point.date, point.count]),
    [
      ["2026-03-01", 1],
      ["2026-03-08", 1],
      ["2026-05-24", 1],
    ],
  );
});

test("buildActivityTrend keeps weekly buckets for the 6mo and 1y presets", () => {
  // 180-day and 365-day inclusive spans, exactly what the rolling presets
  // produce: one point per week, not per month.
  const sixMonths = buildActivityTrend(
    [activity({ id: "p1", occurred_at: "2026-03-02T12:00:00Z" })],
    { from: "2025-12-14", to: "2026-06-11" },
  );
  assert.equal(sixMonths.bucket, "week");
  assert.equal(sixMonths.points.length, 26);

  const oneYear = buildActivityTrend(
    [activity({ id: "p2", occurred_at: "2026-03-02T12:00:00Z" })],
    { from: "2025-06-12", to: "2026-06-11" },
  );
  assert.equal(oneYear.bucket, "week");
  assert.equal(oneYear.points.length, 53);
});

test("buildActivityTrend buckets days in the configured timezone", () => {
  const activities = [activity({ id: "late", occurred_at: "2026-06-08T18:00:00Z" })];

  const utc = buildActivityTrend(activities, { from: "2026-06-08", to: "2026-06-09" }, "UTC");
  const tpe = buildActivityTrend(activities, { from: "2026-06-08", to: "2026-06-09" }, "Asia/Taipei");

  assert.deepEqual(utc.points.map((point) => point.count), [1, 0]);
  assert.deepEqual(tpe.points.map((point) => point.count), [0, 1]);
});

// --- config control plane helpers (Settings -> Sources editor) ---

test("suggestSourceDefaults: canonical hosts get conventional names, self-hosted get derived ones", () => {
  assert.deepEqual(suggestSourceDefaults("github", "github.com"), {
    source_id: "github:github.com",
    kind: "github",
    host: "github.com",
    token_env: "GITHUB_TOKEN",
    graphql_url: "https://api.github.com/graphql",
    rest_url: "https://api.github.com",
  });
  assert.deepEqual(suggestSourceDefaults("gitlab", "https://gitlab.example.com/group"), {
    source_id: "gitlab:gitlab.example.com",
    kind: "gitlab",
    host: "gitlab.example.com",
    token_env: "GITLAB_TOKEN_GITLAB_EXAMPLE_COM",
    graphql_url: "https://gitlab.example.com/api/graphql",
    rest_url: "https://gitlab.example.com/api/v4",
  });
  assert.equal(suggestSourceDefaults("github", "GHE.Corp.example").token_env, "GITHUB_TOKEN_GHE_CORP_EXAMPLE");
  assert.equal(suggestSourceDefaults("gitlab", "gitlab.com").token_env, "GITLAB_TOKEN");
});

test("config draft mutations are immutable and leave unknown fields untouched", () => {
  const src = (id: string, projects: ConfigProjectEntry[] = ["a/b"]): ConfigSourceDoc => ({
    source_id: id,
    kind: "github",
    host: "github.com",
    token_env: "T",
    graphql_url: "https://api.github.com/graphql",
    projects,
  });
  const doc: ConfigDocument = {
    db_path: "data/x.db",
    sources: [src("github:github.com")],
    identities: [{ name: "Dev A" }],
    exclude_actors: ["renovate*"],
  };

  // add a source; duplicates are a no-op
  const added = configWithSource(doc, src("gitlab:gitlab.com"));
  assert.equal(added.sources.length, 2);
  assert.equal(configWithSource(added, src("gitlab:gitlab.com")).sources.length, 2);
  assert.deepEqual(added.identities, [{ name: "Dev A" }], "fields the editor does not own ride along");
  assert.equal(doc.sources.length, 1, "the input document is untouched");

  // creating from null seeds the standalone db_path
  const created = configWithSource(null, src("github:github.com"));
  assert.equal(created.db_path, NEW_CONFIG_DB_PATH);

  // remove a source
  assert.deepEqual(configWithoutSource(added, "gitlab:gitlab.com").sources.map((s) => s.source_id), ["github:github.com"]);

  // patch display fields
  const patched = configWithSourcePatch(doc, "github:github.com", { display_name: "GH" });
  assert.equal(patched.sources[0]!.display_name, "GH");
  assert.equal(doc.sources[0]!.display_name, undefined);

  const disabled = configWithSourcePatch(doc, "github:github.com", { enabled: false });
  assert.equal(disabled.sources[0]!.enabled, false);

  // projects: add trims and dedups (against both string and object entries), remove matches by path
  const withObj = { ...doc, sources: [src("github:github.com", ["a/b", { path: "c/d", color: "#abc" }])] };
  assert.equal(configWithProject(withObj, "github:github.com", "  c/d  ").sources[0]!.projects.length, 2, "dedup against object form");
  const grown = configWithProject(withObj, "github:github.com", "e/f");
  assert.deepEqual(grown.sources[0]!.projects.map(configProjectPath), ["a/b", "c/d", "e/f"]);
  assert.equal(configWithProject(withObj, "github:github.com", "   ").sources[0]!.projects.length, 2, "blank input is a no-op");
  assert.deepEqual(configWithoutProject(grown, "github:github.com", "c/d").sources[0]!.projects.map(configProjectPath), ["a/b", "e/f"]);
});

test("sourcesNeedingSync flags new sources and grown project sets only", () => {
  const src = (id: string, projects: string[], enabled?: boolean): ConfigSourceDoc => ({
    source_id: id,
    kind: "github",
    host: "github.com",
    token_env: "T",
    graphql_url: "https://api.github.com/graphql",
    projects,
    ...(enabled === undefined ? {} : { enabled }),
  });
  const prev: ConfigDocument = { db_path: "x", sources: [src("a", ["p/q"]), src("b", ["r/s"])] };

  assert.deepEqual(sourcesNeedingSync(prev, prev), [], "unchanged config needs nothing");
  assert.deepEqual(sourcesNeedingSync(null, prev), ["a", "b"], "everything is new against no config");
  assert.deepEqual(sourcesNeedingSync(prev, { ...prev, sources: [src("a", ["p/q", "new/repo"]), src("b", ["r/s"])] }), ["a"]);
  assert.deepEqual(sourcesNeedingSync(prev, { ...prev, sources: [src("a", ["p/q"]), src("b", ["r/s"]), src("c", ["t/u"])] }), ["c"]);
  assert.deepEqual(sourcesNeedingSync(prev, { ...prev, sources: [src("a", [])] }), [], "removals alone need no sync");
  assert.deepEqual(sourcesNeedingSync(null, { db_path: "x", sources: [src("c", ["t/u"], false)] }), [], "new disabled sources do not need sync");
  assert.deepEqual(
    sourcesNeedingSync({ db_path: "x", sources: [src("c", ["t/u"], false)] }, { db_path: "x", sources: [src("c", ["t/u"])] }),
    ["c"],
    "enabling a disabled source offers a first sync",
  );
  assert.deepEqual(
    sourcesNeedingSync(prev, { ...prev, sources: [src("a", ["p/q", "new/repo"], false), src("b", ["r/s"])] }),
    [],
    "disabled sources do not need sync even when their project list grows",
  );
  assert.deepEqual(sourcesNeedingSync(prev, null), []);
});

test("hash route carries the settings sub-tab and drops it when default", () => {
  const parsed = parseHashRoute("#/settings?tab=sources");
  assert.equal(parsed.page, "settings");
  assert.equal(parsed.tab, "sources");
  assert.equal(parseHashRoute("#/settings").tab, null);
  assert.equal(parseHashRoute("#/settings?tab=  ").tab, null, "blank param reads as absent");

  assert.equal(buildHashRoute({ page: "settings", tab: "sources" }), "#/settings?tab=sources");
  assert.equal(buildHashRoute({ page: "settings", tab: null }), "#/settings");
  const roundTrip = buildHashRoute({ ...parseHashRoute("#/settings?tab=sources&preset=this-week"), page: "settings" });
  assert.ok(roundTrip.includes("tab=sources") && roundTrip.includes("preset=this-week"), "tab coexists with other params");
});

test("formatBytes scales through binary units and rejects nonsense", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(53_000_000), "50.5 MiB");
  assert.equal(formatBytes(150 * 1024 * 1024), "150 MiB", "3-digit values drop the decimal");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GiB");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(Number.NaN), "—");
});

test("contract payload diagnostics summarize counts, section sizes, and source health", () => {
  const env = {
    contract_version: "4.0.0",
    generated_at: "2026-06-19T00:00:00.000Z",
    generator: "symphony-board/test",
    timezone: "Asia/Taipei",
    sources: [
      { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_status: "ok", last_success_at: "2026-06-18T00:00:00.000Z" },
      { source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", display_name: "GitLab", last_status: "error", last_success_at: "2026-06-10T00:00:00.000Z" },
    ],
    items: [{ id: "github:github.com|I1" }],
    edges: [{ type: "closes" }],
    activities: [{ kind: "commit" }, { kind: "review" }],
    activity_daily: { timezone: "Asia/Taipei", from: "2026-06-01", to: "2026-06-19", total: 2, by_kind: { commit: 1, review: 1 }, days: [] },
    repos: [{ source_id: "github:github.com", project_path: "sympoies/symphony-board" }],
    aggregates: [{ scope: "boardWindow" }],
    item_window: { primary_items: 1, edge_endpoint_items: 0, total_items: 10, truncated: true },
    repo_stats: [{ source_id: "github:github.com", project_path: "sympoies/symphony-board", items: 10 }],
    repo_metrics: [{ source_id: "github:github.com", project_path: "sympoies/symphony-board" }],
  } as unknown as ContractEnvelope;

  assert.deepEqual(contractTopLevelCounts(env), {
    sources: 2,
    items: 1,
    edges: 1,
    activities: 2,
    activity_daily_days: 0,
    repos: 1,
    aggregates: 1,
    repo_stats: 1,
    repo_metrics: 1,
  });

  const sections = contractSectionSizes(env);
  const items = sections.find((section) => section.key === "items");
  assert.equal(items?.rows, 1);
  assert.equal(items?.bytes, new TextEncoder().encode(JSON.stringify(env.items)).length);
  assert.ok(sections.some((section) => section.key === "activity_daily"));

  const health = contractSourceHealth(env);
  assert.deepEqual(health.statusCounts, { error: 1, ok: 1 });
  assert.equal(health.oldestSuccessAt, "2026-06-10T00:00:00.000Z");
  assert.equal(health.latestSuccessAt, "2026-06-18T00:00:00.000Z");
});

test("runDuration formats finished sync runs and dashes a running one", () => {
  assert.equal(runDuration("2026-06-01T00:00:00Z", "2026-06-01T00:00:12Z"), "12s");
  assert.equal(runDuration("2026-06-01T00:00:00Z", "2026-06-01T00:03:20Z"), "3m 20s");
  assert.equal(runDuration("2026-06-01T00:00:00Z", null), "—", "still running");
  assert.equal(runDuration("2026-06-01T00:00:00Z", "not-a-date"), "—");
});

// deriveStatuses is the board's status engine (columns, stats, card badges all
// derive from it) — executed indirectly everywhere, locked directly here.
test("deriveStatuses: an item with no edges is open or closed by its own state alone", () => {
  const st = deriveStatuses(
    [item({ id: "i|a", state: "open" }), item({ id: "i|b", state: "closed" }), item({ id: "i|c", state: "merged", kind: "change_request" })],
    [],
  );
  assert.equal(st.get("i|a"), "open");
  assert.equal(st.get("i|b"), "closed");
  assert.equal(st.get("i|c"), "closed", "merged counts as closed when nothing related is open");
});

test("deriveStatuses: a declared edge marks its OPEN endpoints in_progress, never the closed ones", () => {
  const iss = item({ id: "i|iss", state: "open" });
  const pr = item({ id: "i|pr", state: "open", kind: "change_request" });
  const done = item({ id: "i|done", state: "closed" });
  const edges: EdgeDTO[] = [
    { type: "closes", from: "i|pr", to: "i|iss", from_state: "open", to_state: "open", lifecycle: "declared" },
    { type: "closes", from: "i|done", to: "i|iss", from_state: "closed", to_state: "open", lifecycle: "fulfilled" },
  ];
  const st = deriveStatuses([iss, pr, done], edges);
  assert.equal(st.get("i|iss"), "in_progress");
  assert.equal(st.get("i|pr"), "in_progress");
  assert.equal(st.get("i|done"), "trailing", "a closed item with an open related endpoint trails — declared never applies to closed items");
});

test("deriveStatuses: a non-declared lifecycle never moves an open item off open", () => {
  const st = deriveStatuses(
    [item({ id: "i|a", state: "open" }), item({ id: "i|b", state: "open" })],
    [
      { type: "relates", from: "i|a", to: "i|b", from_state: null, to_state: null, lifecycle: "fulfilled" },
      { type: "relates", from: "i|a", to: "i|b", from_state: null, to_state: null, lifecycle: null },
    ],
  );
  assert.equal(st.get("i|a"), "open");
  assert.equal(st.get("i|b"), "open");
});

test("deriveStatuses: related-open reads the OTHER endpoint's state, in both edge directions", () => {
  const st = deriveStatuses(
    [item({ id: "i|ca", state: "closed" }), item({ id: "i|cb", state: "closed" }), item({ id: "i|cc", state: "closed" })],
    [
      // ca sits on the FROM side of an edge whose TO endpoint is open -> trailing.
      { type: "relates", from: "i|ca", to: "i|x", from_state: "closed", to_state: "open", lifecycle: null },
      // cb sits on the TO side of an edge whose FROM endpoint is open -> trailing.
      { type: "relates", from: "i|y", to: "i|cb", from_state: "open", to_state: "closed", lifecycle: null },
      // cc's related endpoint is closed -> stays closed.
      { type: "relates", from: "i|z", to: "i|cc", from_state: "closed", to_state: "closed", lifecycle: null },
    ],
  );
  assert.equal(st.get("i|ca"), "trailing");
  assert.equal(st.get("i|cb"), "trailing");
  assert.equal(st.get("i|cc"), "closed");
});

test("columnCollapsed: empty is a rail unless peeked; non-empty is a rail only if explicitly collapsed", () => {
  const none = new Set<string>();
  // Empty: a rail by default, expanded when the viewer peeks it open.
  assert.equal(columnCollapsed("in_progress", true, none, none), true, "empty -> rail");
  assert.equal(columnCollapsed("in_progress", true, none, new Set(["in_progress"])), false, "empty + peeked -> expanded");
  // Non-empty: expanded by default, a rail only when explicitly collapsed.
  assert.equal(columnCollapsed("open", false, none, none), false, "non-empty, untouched -> expanded");
  assert.equal(columnCollapsed("open", false, new Set(["open"]), none), true, "non-empty, explicitly collapsed -> rail");
  // Regimes are disjoint: a column collapsed while populated STAYS a rail once it
  // later empties (the collapse set governs only the non-empty regime; the peek
  // set only the empty regime). The peek set is keyed by the full column kind.
  assert.equal(columnCollapsed("lane-pr", false, new Set(["lane-pr"]), none), true, "collapsed while populated -> rail");
  assert.equal(columnCollapsed("lane-pr", true, new Set(["lane-pr"]), none), true, "…and still a rail after emptying (not peeked)");
});

// The spotlight lanes are pure label/kind conventions compiled from
// spotlight.config.ts — a typo there (or in compileLane) silently empties a
// whole board column, so the pick/sort behavior is locked here.
test("spotlight lanes pick by kind + label convention; closed items stay visible", () => {
  const follow = item({ id: "i|f", state: "closed", labels: [{ name: "workflow::follow-up", scope: "workflow", color: null }] });
  const plan = item({ id: "i|p", labels: [{ name: "workflow::plan", scope: "workflow", color: null }] });
  const wrongKind = item({ id: "i|wk", kind: "change_request", labels: [{ name: "workflow::follow-up", scope: "workflow", color: null }] });
  const pr = item({ id: "i|pr", kind: "change_request", state: "merged" });
  const plain = item({ id: "i|plain" });
  const lanes = spotlight([follow, plan, wrongKind, pr, plain]);
  assert.deepEqual(lanes.map((l) => l.lane.key), ["follow-up", "plan", "pr"], "every configured lane is returned, in config order");
  const byKey = new Map(lanes.map((l) => [l.lane.key, l.items.map((i) => i.id)]));
  assert.deepEqual(byKey.get("follow-up"), ["i|f"], "issue kind + label only — and a closed item is still shown");
  assert.deepEqual(byKey.get("plan"), ["i|p"]);
  assert.deepEqual(byKey.get("pr")?.sort(), ["i|pr", "i|wk"], "the PR lane takes every change_request regardless of label or state");
});

test("spotlight lanes sort newest created_at first; missing created_at sinks to the tail", () => {
  const old = item({ id: "i|old", kind: "change_request", created_at: "2026-01-01T00:00:00Z" });
  const newer = item({ id: "i|new", kind: "change_request", created_at: "2026-06-01T00:00:00Z" });
  const undated = item({ id: "i|und", kind: "change_request", created_at: null });
  const lanes = spotlight([old, undated, newer]);
  const prLane = lanes.find((l) => l.lane.key === "pr");
  assert.deepEqual(prLane?.items.map((i) => i.id), ["i|new", "i|old", "i|und"]);
});

test("sourceTokenEnvs lists the primary then any fallback envs, dropping empties", () => {
  assert.deepEqual(sourceTokenEnvs({ token_env: "GH_TOKEN" }), ["GH_TOKEN"]);
  assert.deepEqual(
    sourceTokenEnvs({ token_env: "GH_TOKEN", fallback_token_envs: ["GH_BACKUP", "GH_THIRD"] }),
    ["GH_TOKEN", "GH_BACKUP", "GH_THIRD"],
  );
  assert.deepEqual(
    sourceTokenEnvs({
      token_env: "GH_TOKEN",
      fallback_token_envs: ["GH_BACKUP"],
      token_pools: {
        sympoies: { token_env: "GH_SYMPOIES", fallback_token_envs: ["GH_SYMPOIES_BACKUP"] },
      },
    }),
    ["GH_TOKEN", "GH_BACKUP", "GH_SYMPOIES", "GH_SYMPOIES_BACKUP"],
  );
  assert.deepEqual(sourceTokenEnvs({ token_env: "", fallback_token_envs: ["GH_BACKUP", ""] }), ["GH_BACKUP"]);
  assert.deepEqual(
    sourceTokenEnvs({
      github_app: {
        app_id_env: "APP_ID",
        installation_id_env: "INSTALLATION_ID",
        private_key_path_env: "PRIVATE_KEY_PATH",
      },
      token_pools: {
        bot: {
          github_app: {
            app_id_env: "APP_ID",
            installation_id_env: "BOT_INSTALLATION_ID",
            private_key_path_env: "PRIVATE_KEY_PATH",
          },
        },
      },
    }),
    ["APP_ID", "INSTALLATION_ID", "PRIVATE_KEY_PATH", "BOT_INSTALLATION_ID"],
  );
  assert.deepEqual(
    sourceTokenEnvs({
      auth_pools: {
        source_pat: { kind: "pat", token_env: "GH_TOKEN", fallback_token_envs: ["GH_BACKUP"] },
        example_bots: {
          kind: "github_app",
          strategy: "round_robin",
          apps: [
            {
              name: "example-bot-a",
              app_id_env: "BOT_A_APP_ID",
              installation_id_env: "BOT_A_INSTALLATION_ID",
              private_key_path_env: "BOT_A_PRIVATE_KEY_PATH",
            },
            {
              name: "example-bot-b",
              app_id_env: "BOT_B_APP_ID",
              installation_id_env: "BOT_B_INSTALLATION_ID",
              private_key_path_env: "BOT_B_PRIVATE_KEY_PATH",
            },
          ],
        },
      },
    } as any),
    [
      "GH_TOKEN",
      "GH_BACKUP",
      "BOT_A_APP_ID",
      "BOT_A_INSTALLATION_ID",
      "BOT_A_PRIVATE_KEY_PATH",
      "BOT_B_APP_ID",
      "BOT_B_INSTALLATION_ID",
      "BOT_B_PRIVATE_KEY_PATH",
    ],
  );
});

test("isSourceTokenSet is true when the primary OR any fallback env secret is set", () => {
  const source = { token_env: "GH_TOKEN", fallback_token_envs: ["GH_BACKUP"] };
  // Only the fallback is set -> the source is still token-present (the daemon
  // would use the fallback), so Settings must not show it as token-missing.
  assert.equal(isSourceTokenSet(source, { GH_BACKUP: true }), true);
  assert.equal(isSourceTokenSet(source, { GH_TOKEN: true }), true);
  assert.equal(
    isSourceTokenSet(
      { token_env: "GH_TOKEN", token_pools: { sympoies: { token_env: "GH_SYMPOIES" } } },
      { GH_SYMPOIES: true },
    ),
    true,
  );
  assert.equal(isSourceTokenSet(source, { GH_TOKEN: false, GH_BACKUP: false }), false);
  assert.equal(isSourceTokenSet(source, {}), false);
  // No fallback configured: only the primary counts.
  assert.equal(isSourceTokenSet({ token_env: "GH_TOKEN" }, { GH_BACKUP: true }), false);
});
