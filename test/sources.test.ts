import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSource } from "../src/sources/github.ts";
import { GitLabSource } from "../src/sources/gitlab.ts";
import type { GqlClient } from "../src/sources/graphql.ts";
import type { RestClient } from "../src/sources/rest.ts";
import type { SourceDescriptor, RawRecord } from "../src/sources/types.ts";

const DESC: SourceDescriptor = { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null };

function issueNode(id: string, updatedAt: string) {
  return {
    __typename: "Issue", id, number: 1, title: id, url: `https://x/${id}`, state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z", updatedAt, closedAt: null, stateReason: null,
    author: { login: "a" }, repository: { nameWithOwner: "o/r" },
    labels: { nodes: [] }, comments: { totalCount: 0 }, reactions: { totalCount: 0 },
    closedByPullRequestsReferences: { nodes: [] },
  };
}

// A fake gql that serves one page of two issues (a fresh one and a stale one)
// and an empty PR connection. The issue list is UPDATED_AT desc, as the real
// query requests, so the incremental early-stop can fire on the stale node.
const gql: GqlClient = (async (query: string) => {
  if (query.includes("pullRequests(")) {
    return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
  }
  return {
    repository: {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [issueNode("I_fresh", "2026-06-10T00:00:00Z"), issueNode("I_stale", "2026-01-01T00:00:00Z")],
      },
    },
  };
}) as GqlClient;

test("incremental fetch stops at the first record older than the watermark", async () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const res = await src.fetch({ since: "2026-03-01T00:00:00Z", full: false });
  const ids = res.records.map((r) => r.externalId);
  assert.deepEqual(ids, ["I_fresh"], "the stale issue (older than the watermark) is not fetched");
  assert.equal(res.complete, true);
});

test("a full sweep ignores the watermark and fetches everything", async () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  // Even with a `since` supplied, full:true nulls it inside the source.
  const res = await src.fetch({ since: "2026-03-01T00:00:00Z", full: true });
  const ids = res.records.map((r) => r.externalId).sort();
  assert.deepEqual(ids, ["I_fresh", "I_stale"], "full sweep keeps the stale issue too");
  assert.equal(res.watermark, "2026-06-10T00:00:00Z", "watermark is the max updatedAt seen");
});

test("GitHub fetch and normalize includes commit and repository activity from REST", async () => {
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    if (path === "repos/o/r") {
      return { default_branch: "main" } as T;
    }
    if (path === "repos/o/r/commits") {
      return (params?.page === 1
        ? [
            {
              sha: "abcdef123456",
              html_url: "https://github.com/o/r/commit/abcdef123456",
              commit: {
                message: "Ship activity feed\n\nBody",
                author: { name: "A", email: "octo@example.com", date: "2026-06-09T10:00:00Z" },
                committer: { name: "A", date: "2026-06-09T10:00:00Z" },
              },
              author: { login: "octocat" },
            },
          ]
        : []) as T;
    }
    if (path === "repos/o/r/activity") {
      // The real repository-activity shape: timestamp / activity_type / actor
      // (NOT pushed_at / push_type / pusher — those never existed on the wire).
      return [
        {
          activity_type: "push",
          ref: "refs/heads/main",
          before: "1111111",
          after: "2222222",
          timestamp: "2026-06-09T11:00:00Z",
          actor: { login: "octocat" },
        },
      ] as T;
    }
    throw new Error(`unexpected REST path ${path}`);
  };

  const src = new GitHubSource(DESC, gql, ["o/r"], rest);
  const res = await src.fetch({ since: "2026-06-01T00:00:00Z", full: false });
  const activityBundles = res.records.filter((r) => r.entityKind === "activity").map((r) => src.normalize(r)!);
  assert.equal(activityBundles.length, 2);
  assert.deepEqual(activityBundles.map((b) => b.activities[0]!.kind).sort(), ["branch", "commit"]);
  assert.ok(calls.some((c) => c.path === "repos/o/r"));
  assert.ok(calls.some((c) => c.path === "repos/o/r/commits" && c.params?.since === "2026-06-01T00:00:00Z"));
  assert.ok(calls.some((c) => c.path === "repos/o/r/activity" && c.params?.time_period === "month"));
  // The linked account login wins over the commit email, and the push reuses it.
  const commit = activityBundles.find((b) => b.activities[0]!.kind === "commit")!.activities[0]!;
  assert.equal(commit.actorKey, "provider-user:github:github.com:octocat");
  assert.deepEqual(commit.details, {
    sha: "abcdef123456",
    message: "Ship activity feed",
    body: "Body",
    branch: "main",
    ref: "refs/heads/main",
  });
  const push = activityBundles.find((b) => b.activities[0]!.kind === "branch")!.activities[0]!;
  assert.equal(push.actorKey, "provider-user:github:github.com:octocat");
  assert.equal(push.url, "https://github.com/o/r/compare/1111111...2222222");
});

test("a full sweep backfills a year window and reads the cursor-paginated activity surface once", async () => {
  // An active repo can exceed 1000 commits per year, so a fresh-DB rebuild needs
  // >10 commit pages (issue context: nils-cli at ~1006 commits per 365d). The
  // repository-activity endpoint is cursor-paginated through the Link header
  // and ignores `page`, so it is read exactly once — re-requesting "page 2"
  // would re-serve the same newest 100 events.
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const fullPage = (path: string, page: number): unknown[] =>
    Array.from({ length: 100 }, (_, i) =>
      path === "repos/o/r/commits"
        ? {
            sha: `sha-${page}-${i}`,
            html_url: `https://github.com/o/r/commit/sha-${page}-${i}`,
            commit: { message: "m", author: { name: "A", date: "2026-06-09T10:00:00Z" }, committer: { name: "A", date: "2026-06-09T10:00:00Z" } },
          }
        : { activity_type: "push", ref: "refs/heads/main", before: `b${page}${i}`, after: `a${page}${i}`, timestamp: "2026-06-09T11:00:00Z", actor: { login: "octocat" } },
    );
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    if (path === "repos/o/r") return { default_branch: "main" } as T;
    return fullPage(path, Number(params?.page ?? 0)) as T;
  };

  const src = new GitHubSource(DESC, gql, ["o/r"], rest);
  await src.fetch({ since: null, full: true });
  assert.ok(
    calls.some((c) => c.path === "repos/o/r/activity" && c.params?.time_period === "year"),
    "a full sweep asks the activity surface for the full year window",
  );
  assert.equal(calls.filter((c) => c.path === "repos/o/r/commits").length, 20, "commits page to 2000 per project");
  assert.equal(calls.filter((c) => c.path === "repos/o/r/activity").length, 1, "the activity surface is read once per sweep");
});

// --- multi-branch commit expansion (side branches via push events + compare) --

// Shared fixtures for the GitHub expansion tests: one commit that lives on the
// default feed and one that only exists on side branches.
const ghMainCommit = {
  sha: "aaa111",
  html_url: "https://github.com/o/r/commit/aaa111",
  commit: {
    message: "On main",
    author: { name: "A", email: "octo@example.com", date: "2026-06-09T10:00:00Z" },
    committer: { name: "A", date: "2026-06-09T10:00:00Z" },
  },
  author: { login: "octocat" },
};
const ghSideCommit = {
  sha: "bbb222",
  html_url: "https://github.com/o/r/commit/bbb222",
  commit: {
    message: "On branches",
    author: { name: "A", email: "octo@example.com", date: "2026-06-09T11:30:00Z" },
    committer: { name: "A", date: "2026-06-09T11:30:00Z" },
  },
  author: { login: "octocat" },
};
const ghPush = (ref: string, timestamp: string, activityType = "push") => ({
  activity_type: activityType,
  ref,
  before: "1111111",
  after: "2222222",
  timestamp,
  actor: { login: "octocat" },
});

test("GitHub fetch expands live side branches via compare and merges branch membership by sha", async () => {
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    if (path === "repos/o/r") return { default_branch: "main" } as T;
    if (path === "repos/o/r/commits") return (params?.page === 1 ? [ghMainCommit] : []) as T;
    if (path === "repos/o/r/activity") {
      return [
        ghPush("refs/heads/main", "2026-06-09T10:00:01Z"), // default branch: never compared
        ghPush("refs/heads/feature-x", "2026-06-09T11:31:00Z"), // live side branch
        ghPush("refs/heads/feature/y", "2026-06-09T11:32:00Z"), // slash in the branch name
        ghPush("refs/heads/stale", "2026-05-01T00:00:00Z"), // pushed before the watermark
        ghPush("refs/heads/gone", "2026-06-09T11:33:00Z", "branch_deletion"), // deleted: skipped
        ghPush("refs/tags/v1", "2026-06-09T11:34:00Z"), // tag: skipped
      ] as T;
    }
    if (path === "repos/o/r/compare/main...feature-x") return { commits: [ghSideCommit] } as T;
    // A side branch can also carry a commit the default feed already saw (e.g.
    // a merge that landed mid-sweep) — membership must union, not duplicate.
    if (path === "repos/o/r/compare/main...feature%2Fy") return { commits: [ghSideCommit, ghMainCommit] } as T;
    throw new Error(`unexpected REST path ${path}`);
  };

  const src = new GitHubSource(DESC, gql, ["o/r"], rest);
  const res = await src.fetch({ since: "2026-06-01T00:00:00Z", full: false });
  assert.equal(res.complete, true);

  const comparePaths = calls.filter((c) => c.path.startsWith("repos/o/r/compare/")).map((c) => c.path).sort();
  assert.deepEqual(
    comparePaths,
    ["repos/o/r/compare/main...feature%2Fy", "repos/o/r/compare/main...feature-x"],
    "only live side branches pushed since the watermark are compared",
  );

  const commits = res.records
    .filter((r) => r.entityKind === "activity")
    .map((r) => src.normalize(r)!.activities[0]!)
    .filter((a) => a.kind === "commit");
  assert.equal(commits.length, 2, "branch feeds merge by sha into one record per commit");

  const main = commits.find((a) => (a.details as any).sha === "aaa111")!;
  assert.deepEqual(main.details, {
    sha: "aaa111",
    message: "On main",
    branch: "main",
    ref: "refs/heads/main",
    branches: ["main", "feature/y"],
    refs: ["refs/heads/main", "refs/heads/feature/y"],
  });

  const side = commits.find((a) => (a.details as any).sha === "bbb222")!;
  assert.deepEqual(side.details, {
    sha: "bbb222",
    message: "On branches",
    branch: "feature-x",
    ref: "refs/heads/feature-x",
    branches: ["feature-x", "feature/y"],
    refs: ["refs/heads/feature-x", "refs/heads/feature/y"],
  });
});

test("a GitHub full sweep compares side branches from the whole activity window", async () => {
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    if (path === "repos/o/r") return { default_branch: "main" } as T;
    if (path === "repos/o/r/commits") return [] as T;
    if (path === "repos/o/r/activity") {
      return [ghPush("refs/heads/feature-x", "2025-09-01T00:00:00Z")] as T;
    }
    if (path === "repos/o/r/compare/main...feature-x") return { commits: [ghSideCommit] } as T;
    throw new Error(`unexpected REST path ${path}`);
  };

  const src = new GitHubSource(DESC, gql, ["o/r"], rest);
  const res = await src.fetch({ since: "2026-06-01T00:00:00Z", full: true });
  assert.ok(
    calls.some((c) => c.path === "repos/o/r/compare/main...feature-x"),
    "with no watermark, any branch pushed inside the activity window is compared",
  );
  const commit = res.records.filter((r) => r.entityKind === "activity").map((r) => src.normalize(r)!.activities[0]!).find((a) => a.kind === "commit")!;
  assert.equal((commit.details as any).branch, "feature-x");
});

test("a side branch deleted before its compare is skipped without failing the sweep", async () => {
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    if (path === "repos/o/r") return { default_branch: "main" } as T;
    if (path === "repos/o/r/commits") return (params?.page === 1 ? [ghMainCommit] : []) as T;
    if (path === "repos/o/r/activity") {
      return [ghPush("refs/heads/feature-x", "2026-06-09T11:31:00Z")] as T;
    }
    if (path === "repos/o/r/compare/main...feature-x") throw new Error("REST HTTP 404: Not Found");
    throw new Error(`unexpected REST path ${path}`);
  };

  const src = new GitHubSource(DESC, gql, ["o/r"], rest);
  const res = await src.fetch({ since: "2026-06-01T00:00:00Z", full: false });
  assert.equal(res.complete, true, "a vanished side branch is branch lifecycle, not an incomplete sweep");
  const commits = res.records.filter((r) => r.entityKind === "activity").map((r) => src.normalize(r)!.activities[0]!).filter((a) => a.kind === "commit");
  assert.deepEqual(commits.map((a) => (a.details as any).sha), ["aaa111"], "the default feed still lands");
});

test("a pre-expansion GitHub commit payload (defaultBranch, no branches) replays unchanged", () => {
  // Stored raw is immutable history: payloads written before the multi-branch
  // expansion only carry `defaultBranch`, and normalize must keep emitting the
  // exact pre-expansion details shape for them.
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const raw: RawRecord = {
    entityKind: "activity",
    externalId: "commit:o%2Fr:0ddba11",
    apiVersion: "github.graphql.v4.rest",
    fetchedAt: "2026-06-09T00:00:00Z",
    contentHash: "h",
    payload: {
      __activityKind: "github_commit",
      project: "o/r",
      defaultBranch: "main",
      commit: {
        sha: "0ddba11",
        html_url: "https://github.com/o/r/commit/0ddba11",
        commit: { message: "Old shape", author: { name: "A", date: "2026-06-09T10:00:00Z" }, committer: { name: "A", date: "2026-06-09T10:00:00Z" } },
        author: { login: "octocat" },
      },
    },
  };
  assert.deepEqual(src.normalize(raw)!.activities[0]!.details, {
    sha: "0ddba11",
    message: "Old shape",
    branch: "main",
    ref: "refs/heads/main",
  });
});

test("commit_branches=default keeps the commit feed on the default branch only", async () => {
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    if (path === "repos/o/r") return { default_branch: "main" } as T;
    if (path === "repos/o/r/commits") return (params?.page === 1 ? [ghMainCommit] : []) as T;
    if (path === "repos/o/r/activity") {
      return [ghPush("refs/heads/feature-x", "2026-06-09T11:31:00Z")] as T;
    }
    throw new Error(`unexpected REST path ${path}`);
  };

  const src = new GitHubSource(DESC, gql, ["o/r"], rest, { commitBranches: "default" });
  const res = await src.fetch({ since: "2026-06-01T00:00:00Z", full: false });
  assert.equal(res.complete, true);
  assert.ok(!calls.some((c) => c.path.startsWith("repos/o/r/compare/")), "no compare calls in default-only mode");
});

test("GitHub commit with no linked account keys the actor by hashed email", () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const raw: RawRecord = {
    entityKind: "activity",
    externalId: "commit:o/r:deadbeefcafe",
    apiVersion: "github.graphql.v4.rest",
    fetchedAt: "2026-06-09T00:00:00Z",
    contentHash: "h",
    payload: {
      __activityKind: "github_commit",
      project: "o/r",
      commit: {
        sha: "deadbeefcafe",
        html_url: "https://github.com/o/r/commit/deadbeefcafe",
        commit: {
          message: "Anonymous fix",
          author: { name: "Anon Dev", email: "anon@example.com", date: "2026-06-09T10:00:00Z" },
          committer: { name: "Anon Dev", date: "2026-06-09T10:00:00Z" },
        },
        author: null,
      },
    },
  };
  const activity = src.normalize(raw)!.activities[0]!;
  assert.equal(activity.actor, "Anon Dev", "display string is unchanged");
  assert.match(activity.actorKey ?? "", /^email:[0-9a-f]{16}$/, "no linked login -> hashed email key");
});

test("GitHub repository activity links created refs and deleted refs conservatively", () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const raw = (externalId: string, event: Record<string, unknown>): RawRecord => ({
    entityKind: "activity",
    externalId,
    apiVersion: "github.graphql.v4.rest",
    fetchedAt: "2026-06-09T00:00:00Z",
    contentHash: "h",
    payload: { __activityKind: "github_repo_activity", project: "o/r", event },
  });

  const created = src.normalize(raw("created", {
    activity_type: "branch_creation",
    ref: "refs/heads/feature/link-ui",
    before: "0000000",
    after: "abc1234",
    timestamp: "2026-06-09T11:00:00Z",
    actor: { login: "octocat" },
  }))!.activities[0]!;
  assert.equal(created.action, "created");
  assert.equal(created.actor, "octocat");
  assert.equal(created.url, "https://github.com/o/r/tree/feature%2Flink-ui");

  // Legacy fixture shape (pushed_at / push_type / pusher): pre-real-API test
  // payloads must keep replaying through normalize's fallbacks.
  const deleted = src.normalize(raw("deleted", {
    push_type: "branch_deletion",
    ref: "refs/heads/feature/link-ui",
    before: "deadbeef",
    after: "0000000",
    pushed_at: "2026-06-09T12:00:00Z",
    pusher: { login: "octocat" },
  }))!.activities[0]!;
  assert.equal(deleted.action, "deleted");
  assert.equal(deleted.actor, "octocat");
  assert.equal(deleted.url, "https://github.com/o/r/commit/deadbeef");
});

test("normalize emits mentions from non-closing cross-references (source -> self)", () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const raw: RawRecord = {
    entityKind: "issue",
    externalId: "I_self",
    apiVersion: "github.graphql.v4",
    fetchedAt: "2026-06-01T00:00:00Z",
    contentHash: "h",
    payload: {
      ...issueNode("I_self", "2026-06-01T00:00:00Z"),
      timelineItems: {
        nodes: [
          { willCloseTarget: false, source: { __typename: "PullRequest", id: "PR_mention", state: "MERGED" } },
          { willCloseTarget: true, source: { __typename: "PullRequest", id: "PR_closer", state: "MERGED" } },
          { willCloseTarget: false, source: null },
        ],
      },
    },
  };
  const bundle = src.normalize(raw);
  assert.ok(bundle);
  const mentions = bundle!.edges.filter((e) => e.type === "mentions");
  assert.equal(mentions.length, 1, "only the non-closing, resolvable cross-ref becomes a mention");
  const m = mentions[0]!;
  assert.equal(m.from.externalId, "PR_mention", "edge points source -> self");
  assert.equal(m.to.externalId, "I_self");
  assert.equal(m.fromState, "merged");
  assert.equal(m.toState, "open");
});

// --- merge_state is open-only (merged/closed PRs must not show a merge badge) -

function prNode(id: string, state: string, mergeable: string) {
  return {
    __typename: "PullRequest", id, number: 9, title: id, url: `https://x/${id}`, state,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", closedAt: null,
    mergedAt: state === "MERGED" ? "2026-06-01T00:00:00Z" : null, isDraft: false,
    author: { login: "a" }, repository: { nameWithOwner: "o/r" }, labels: { nodes: [] },
    comments: { totalCount: 0 }, reactions: { totalCount: 0 }, reviewDecision: null,
    mergeable, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    closingIssuesReferences: { nodes: [] },
  };
}

function ghPrBundle(state: string, mergeable: string) {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const raw: RawRecord = {
    entityKind: "change_request", externalId: `PR_${state}`, apiVersion: "github.graphql.v4",
    fetchedAt: "2026-06-01T00:00:00Z", contentHash: "h", payload: prNode(`PR_${state}`, state, mergeable),
  };
  return src.normalize(raw)!;
}

test("GitHub: a merged PR drops merge_state (UNKNOWN would otherwise read as 'unknown')", () => {
  const b = ghPrBundle("MERGED", "UNKNOWN");
  assert.ok(b.item);
  assert.equal(b.item.state, "merged");
  assert.equal(b.item.mergeState, null, "merged PR carries no merge badge");
  assert.equal(b.item.ciState, "passing", "CI is still meaningful after merge");
});

test("GitHub: an open PR keeps its real merge_state", () => {
  const mergeable = ghPrBundle("OPEN", "MERGEABLE").item;
  const conflicting = ghPrBundle("OPEN", "CONFLICTING").item;
  const unknown = ghPrBundle("OPEN", "UNKNOWN").item;
  assert.ok(mergeable);
  assert.ok(conflicting);
  assert.ok(unknown);
  assert.equal(mergeable.mergeState, "mergeable");
  assert.equal(conflicting.mergeState, "conflicting");
  // UNKNOWN is a legitimate transient state while open and is preserved.
  assert.equal(unknown.mergeState, "unknown");
});

test("GitHub CI refresh fetches configured PR candidates without advancing the watermark", async () => {
  const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
  const refreshGql: GqlClient = (async (query: string, vars?: Record<string, unknown>) => {
    calls.push({ query, vars: vars ?? {} });
    return { repository: { pullRequest: prNode("PR_refresh", "MERGED", "UNKNOWN") } };
  }) as GqlClient;
  const src = new GitHubSource(DESC, refreshGql, ["o/r"]);

  const res = await src.fetchRefresh([
    { externalId: "PR_refresh", projectPath: "o/r", iid: 9, reason: "ci_unresolved" },
    { externalId: "PR_skip", projectPath: "outside/repo", iid: 1, reason: "ci_unresolved" },
  ], { since: null, full: false });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.vars.number, 9);
  assert.equal(res.watermark, null, "refresh records must not move the updatedAt watermark");
  assert.equal(res.records[0]!.externalId, "PR_refresh");
  assert.equal(src.normalize(res.records[0]!)?.item?.ciState, "passing");
});

test("GitHub: submitted PR reviews normalize into review activities (issue #93)", () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const raw: RawRecord = {
    entityKind: "change_request", externalId: "PR_rev", apiVersion: "github.graphql.v4",
    fetchedAt: "2026-06-01T00:00:00Z", contentHash: "h",
    payload: {
      ...prNode("PR_rev", "OPEN", "MERGEABLE"),
      reviews: {
        nodes: [
          { id: "R1", author: { login: "alice" }, state: "APPROVED", submittedAt: "2026-06-05T09:00:00Z", url: "https://x/r1" },
          { id: "R2", author: { login: "bob" }, state: "CHANGES_REQUESTED", submittedAt: "2026-06-05T10:00:00Z", url: null },
          { id: "R3", author: { login: "carol" }, state: "COMMENTED", submittedAt: "2026-06-05T11:00:00Z", url: null },
          { id: "R4", author: { login: "dan" }, state: "PENDING", submittedAt: null, url: null },
        ],
      },
    },
  };
  const reviews = src.normalize(raw)!.activities.filter((a) => a.kind === "review");
  assert.equal(reviews.length, 3, "PENDING (unsubmitted) reviews are skipped");
  assert.deepEqual(reviews.map((a) => a.action).sort(), ["approved", "changes_requested", "reviewed"]);
  const approved = reviews.find((a) => a.action === "approved")!;
  assert.equal(approved.actor, "alice");
  assert.equal(approved.occurredAt, "2026-06-05T09:00:00Z");
  assert.equal(approved.target?.externalId, "PR_rev", "review targets the tracked PR");
  assert.equal(approved.targetKind, "change_request");
});

function glMrBundle(state: string, detailedMergeStatus: string) {
  const src = new GitLabSource(GL_DESC, glGql, ["g/p"]);
  const raw: RawRecord = {
    entityKind: "change_request", externalId: `gid:MR_${state}`, apiVersion: "gitlab.graphql",
    fetchedAt: "2026-06-01T00:00:00Z", contentHash: "h",
    payload: glNode(`gid:MR_${state}`, "9", {
      state, mergedAt: state === "merged" ? "2026-06-01T00:00:00Z" : null, draft: false,
      approved: false, approvalsRequired: 0, headPipeline: { status: "SUCCESS" }, detailedMergeStatus,
    }),
  };
  return src.normalize(raw)!;
}

test("GitLab: a merged MR drops merge_state (NOT_OPEN would otherwise read as 'mergeable')", () => {
  const b = glMrBundle("merged", "NOT_OPEN");
  assert.ok(b.item);
  assert.equal(b.item.state, "merged");
  assert.equal(b.item.mergeState, null, "merged MR carries no merge badge");
  assert.equal(b.item.ciState, "passing");
});

test("GitLab: an open MR keeps its real merge_state", () => {
  const mergeable = glMrBundle("opened", "MERGEABLE").item;
  const blocked = glMrBundle("opened", "CI_MUST_PASS").item;
  assert.ok(mergeable);
  assert.ok(blocked);
  assert.equal(mergeable.mergeState, "mergeable");
  assert.equal(blocked.mergeState, "blocked");
});

test("GitLab CI refresh fetches configured MR candidates without advancing the watermark", async () => {
  const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
  const refreshGql: GqlClient = (async (query: string, vars?: Record<string, unknown>) => {
    calls.push({ query, vars: vars ?? {} });
    return {
      project: {
        mergeRequest: glNode("gid:MR_refresh", "9", {
          state: "merged",
          mergedAt: "2026-06-01T00:00:00Z",
          draft: false,
          approved: false,
          approvalsRequired: 0,
          headPipeline: { status: "SUCCESS" },
          detailedMergeStatus: "NOT_OPEN",
        }),
      },
    };
  }) as GqlClient;
  const src = new GitLabSource(GL_DESC, refreshGql, ["g/p"]);

  const res = await src.fetchRefresh([
    { externalId: "gid:MR_refresh", projectPath: "g/p", iid: 9, reason: "ci_unresolved" },
    { externalId: "gid:MR_skip", projectPath: "outside/project", iid: 1, reason: "ci_unresolved" },
  ], { since: null, full: false });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.vars.path, "g/p");
  assert.equal(calls[0]!.vars.iid, "9", "GitLab GraphQL mergeRequest iid is string-valued");
  assert.equal(res.watermark, null, "refresh records must not move the updatedAt watermark");
  assert.equal(res.records[0]!.externalId, "gid:MR_refresh");
  const item = src.normalize(res.records[0]!)?.item;
  assert.equal(item?.ciState, "passing");
  assert.equal(item?.projectPath, "g/p");
});

test("GitLab project events normalize without fake tracked target refs", () => {
  const src = new GitLabSource(GL_DESC, glGql, ["g/p"]);
  const raw: RawRecord = {
    entityKind: "activity",
    externalId: "event:1",
    apiVersion: "gitlab.graphql.rest",
    fetchedAt: "2026-06-01T00:00:00Z",
    contentHash: "h",
    payload: {
      __activityKind: "gitlab_project_event",
      project: "g/p",
      event: {
        id: 1,
        action_name: "closed",
        target_type: "Issue",
        target_id: 99,
        target_iid: 5,
        target_title: "Close me",
        created_at: "2026-06-09T12:00:00Z",
        author_username: "gitlab-user",
      },
    },
  };
  const b = src.normalize(raw);
  assert.ok(b);
  assert.equal(b!.item, null);
  assert.equal(b!.activities.length, 1);
  assert.equal(b!.activities[0]!.kind, "issue");
  assert.equal(b!.activities[0]!.action, "closed");
  assert.equal(b!.activities[0]!.target, null, "REST target_id is not the GraphQL global id");
  assert.equal(b!.activities[0]!.targetIid, 5);
  assert.equal(b!.activities[0]!.url, "https://gitlab.com/g/p/-/issues/5");
});

test("GitLab project events link reliable push destinations and leave comments unlinked", () => {
  const src = new GitLabSource(GL_DESC, glGql, ["g/p"]);
  const push: RawRecord = {
    entityKind: "activity",
    externalId: "event:push",
    apiVersion: "gitlab.graphql.rest",
    fetchedAt: "2026-06-01T00:00:00Z",
    contentHash: "h",
    payload: {
      __activityKind: "gitlab_project_event",
      project: "g/p",
      event: {
        id: 2,
        action_name: "pushed to",
        created_at: "2026-06-09T12:00:00Z",
        author_username: "gitlab-user",
        push_data: {
          ref: "main",
          commit_from: "aaaaaaaa",
          commit_to: "bbbbbbbb",
        },
      },
    },
  };
  const comment: RawRecord = {
    entityKind: "activity",
    externalId: "event:comment",
    apiVersion: "gitlab.graphql.rest",
    fetchedAt: "2026-06-01T00:00:00Z",
    contentHash: "h",
    payload: {
      __activityKind: "gitlab_project_event",
      project: "g/p",
      event: {
        id: 3,
        action_name: "commented on",
        target_type: "Note",
        target_iid: 5,
        target_title: "A note",
        created_at: "2026-06-09T12:05:00Z",
        author_username: "gitlab-user",
      },
    },
  };

  assert.equal(src.normalize(push)?.activities[0]?.url, "https://gitlab.com/g/p/-/compare/aaaaaaaa...bbbbbbbb");
  assert.equal(src.normalize(comment)?.activities[0]?.kind, "comment");
  assert.equal(src.normalize(comment)?.activities[0]?.url, null);
});

test("GitLab fetch and normalize includes commit body and default branch refs from REST", async () => {
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    if (path === "projects/g%2Fp") {
      return { default_branch: "main" } as T;
    }
    if (path === "projects/g%2Fp/repository/commits") {
      return (params?.page === 1
        ? [
            {
              id: "cafebabefeed",
              short_id: "cafebabe",
              title: "Wire commit body",
              message: "Wire commit body\n\nDetailed body",
              web_url: "https://gitlab.com/g/p/-/commit/cafebabefeed",
              committed_date: "2026-06-09T10:00:00Z",
              author_name: "GitLab Dev",
              author_email: "gitlab@example.com",
            },
          ]
        : []) as T;
    }
    if (path === "projects/g%2Fp/events") {
      return [] as T;
    }
    throw new Error(`unexpected REST path ${path}`);
  };

  const src = new GitLabSource(GL_DESC, glGql, ["g/p"], rest);
  const res = await src.fetch({ since: "2026-06-01T00:00:00Z", full: false });
  const activityBundles = res.records.filter((r) => r.entityKind === "activity").map((r) => src.normalize(r)!);
  const commit = activityBundles.find((b) => b.activities[0]!.kind === "commit")!.activities[0]!;
  assert.ok(calls.some((c) => c.path === "projects/g%2Fp"));
  assert.ok(calls.some((c) => c.path === "projects/g%2Fp/repository/commits" && c.params?.since === "2026-06-01T00:00:00Z"));
  assert.equal(commit.actorKey, "email:08c2f7b1d187a0ca");
  assert.deepEqual(commit.details, {
    sha: "cafebabefeed",
    message: "Wire commit body",
    body: "Detailed body",
    branch: "main",
    ref: "refs/heads/main",
  });
});

test("GitLab fetch expands live side branches via compare and labels their commits", async () => {
  const calls: Array<{ path: string; params: Record<string, unknown> | undefined }> = [];
  const glMainCommit = {
    id: "cafebabefeed",
    short_id: "cafebabe",
    title: "On main",
    message: "On main",
    web_url: "https://gitlab.com/g/p/-/commit/cafebabefeed",
    committed_date: "2026-06-09T10:00:00Z",
    author_name: "GitLab Dev",
    author_email: "gitlab@example.com",
  };
  const glSideCommit = {
    id: "feedfacecafe",
    short_id: "feedface",
    title: "On a side branch",
    message: "On a side branch",
    web_url: "https://gitlab.com/g/p/-/commit/feedfacecafe",
    committed_date: "2026-06-09T11:30:00Z",
    author_name: "GitLab Dev",
    author_email: "gitlab@example.com",
  };
  const glPushEvent = (id: number, createdAt: string, ref: string, refType: string, action: string) => ({
    id,
    action_name: action === "removed" ? "deleted" : "pushed to",
    created_at: createdAt,
    author_username: "gitlab-user",
    push_data: { ref, ref_type: refType, action, commit_from: "aaaaaaaa", commit_to: "bbbbbbbb" },
  });
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    if (path === "projects/g%2Fp") return { default_branch: "main" } as T;
    if (path === "projects/g%2Fp/repository/commits") return (params?.page === 1 ? [glMainCommit] : []) as T;
    if (path === "projects/g%2Fp/events") {
      return (params?.page === 1
        ? [
            glPushEvent(10, "2026-06-09T11:31:00Z", "feature-x", "branch", "pushed"), // live side branch
            glPushEvent(11, "2026-06-09T11:32:00Z", "main", "branch", "pushed"), // default: never compared
            glPushEvent(12, "2026-06-09T11:33:00Z", "gone", "branch", "removed"), // deleted: skipped
            glPushEvent(13, "2026-06-09T11:34:00Z", "v1", "tag", "created"), // tag: skipped
            glPushEvent(14, "2026-05-01T00:00:00Z", "stale", "branch", "pushed"), // before the watermark
          ]
        : []) as T;
    }
    if (path === "projects/g%2Fp/repository/compare") return { commits: [glSideCommit] } as T;
    throw new Error(`unexpected REST path ${path}`);
  };

  const src = new GitLabSource(GL_DESC, glGql, ["g/p"], rest);
  const res = await src.fetch({ since: "2026-06-01T00:00:00Z", full: false });
  assert.equal(res.complete, true);

  const compares = calls.filter((c) => c.path === "projects/g%2Fp/repository/compare");
  assert.deepEqual(
    compares.map((c) => ({ from: c.params?.from, to: c.params?.to })),
    [{ from: "main", to: "feature-x" }],
    "only the live side branch pushed since the watermark is compared",
  );

  const commits = res.records
    .filter((r) => r.entityKind === "activity")
    .map((r) => src.normalize(r)!.activities[0]!)
    .filter((a) => a.kind === "commit");
  assert.equal(commits.length, 2);
  const side = commits.find((a) => (a.details as any).sha === "feedfacecafe")!;
  assert.deepEqual(side.details, {
    sha: "feedfacecafe",
    message: "On a side branch",
    branch: "feature-x",
    ref: "refs/heads/feature-x",
  });
  const main = commits.find((a) => (a.details as any).sha === "cafebabefeed")!;
  assert.deepEqual(main.details, {
    sha: "cafebabefeed",
    message: "On main",
    branch: "main",
    ref: "refs/heads/main",
  });
});

test("a pre-expansion GitLab commit payload (defaultBranch, no branches) replays unchanged", () => {
  const src = new GitLabSource(GL_DESC, glGql, ["g/p"]);
  const raw: RawRecord = {
    entityKind: "activity",
    externalId: "commit:g%2Fp:0ddba11",
    apiVersion: "gitlab.graphql.rest",
    fetchedAt: "2026-06-09T00:00:00Z",
    contentHash: "h",
    payload: {
      __activityKind: "gitlab_commit",
      project: "g/p",
      defaultBranch: "main",
      commit: {
        id: "0ddba11",
        title: "Old shape",
        message: "Old shape",
        web_url: "https://gitlab.com/g/p/-/commit/0ddba11",
        committed_date: "2026-06-09T10:00:00Z",
        author_name: "GitLab Dev",
        author_email: "gitlab@example.com",
      },
    },
  };
  assert.deepEqual(src.normalize(raw)!.activities[0]!.details, {
    sha: "0ddba11",
    message: "Old shape",
    branch: "main",
    ref: "refs/heads/main",
  });
});

// --- GitLab: system-note cross-references (issue #13) ----------------------

const GL_DESC: SourceDescriptor = { sourceId: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", displayName: null };

function glNode(id: string, iid: string, extra: Record<string, unknown> = {}) {
  return {
    id, iid, title: id, webUrl: `https://gl/${iid}`, state: "opened",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", closedAt: null,
    author: { username: "a" }, labels: { nodes: [] }, userNotesCount: 0, upvotes: 0, ...extra,
  };
}

// A fake GitLab gql: one project, one MR (MR1 closes I5), two issues. The
// per-item resolve serves relatedMergeRequests + the system notes that drive the
// note-parsing path (mentions, relates, dedup-vs-closes, commit skip).
const glGql: GqlClient = (async (query: string, vars: any) => {
  if (query.includes("mergeRequest(iid")) {
    const notes: Record<string, any[]> = { "1": [{ system: true, body: "mentioned in issue #6" }] };
    return { project: { mergeRequest: { notes: { nodes: notes[vars.iid] ?? [] } } } };
  }
  if (query.includes("issue(iid")) {
    const relMr: Record<string, any[]> = { "5": [{ id: "gid:MR1", iid: "1", state: "opened" }], "6": [] };
    const notes: Record<string, any[]> = {
      "5": [
        { system: true, body: "mentioned in merge request !1" }, // MR1 already closes I5 -> deduped
        { system: true, body: "marked as related to #6" }, // relates I5 <-> I6
        { system: true, body: "mentioned in commit 0af3c1d9" }, // commit -> skipped
      ],
      "6": [
        { system: true, body: "mentioned in issue #5" }, // I5 mentions I6
        { system: false, body: "thanks, see #5" }, // human note -> ignored
      ],
    };
    return { project: { issue: { relatedMergeRequests: { nodes: relMr[vars.iid] ?? [] }, notes: { nodes: notes[vars.iid] ?? [] } } } };
  }
  if (query.includes("mergeRequests(")) {
    return { project: { mergeRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [glNode("gid:MR1", "1", { mergedAt: null, draft: false, approved: false, approvalsRequired: 0, headPipeline: null, detailedMergeStatus: "MERGEABLE" })] } } };
  }
  if (query.includes("issues(")) {
    return { project: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [glNode("gid:I5", "5"), glNode("gid:I6", "6")] } } };
  }
  return {};
}) as GqlClient;

test("GitLab fetch resolves system notes into mentions/relates edges (with closes dedup)", async () => {
  const src = new GitLabSource(GL_DESC, glGql, ["g/p"]);
  const res = await src.fetch({ since: null, full: true });
  assert.equal(res.complete, true);
  const byId = new Map(res.records.map((r) => [r.externalId, r]));
  const edgesOf = (id: string) => src.normalize(byId.get(id)!)!.edges;

  // I5: MR1 closes it; relates to I6; the "!1" mention is the closing MR (deduped)
  // and the commit ref is skipped -> 0 mentions.
  const i5 = edgesOf("gid:I5");
  const i5closes = i5.filter((e) => e.type === "closes");
  const i5rel = i5.filter((e) => e.type === "relates");
  const i5men = i5.filter((e) => e.type === "mentions");
  assert.equal(i5closes.length, 1, "I5 has the closes edge from MR1");
  assert.equal(i5closes[0]!.from.externalId, "gid:MR1");
  assert.equal(i5men.length, 0, "the closing MR mention is deduped; the commit ref is skipped");
  assert.equal(i5rel.length, 1, "I5 relates to I6");
  // relates endpoints are canonicalized (lexicographic): gid:I5 < gid:I6.
  assert.equal(i5rel[0]!.from.externalId, "gid:I5");
  assert.equal(i5rel[0]!.to.externalId, "gid:I6");

  // I6: mentioned by I5 (issue->issue, non-closing) -> one mention, source -> self.
  const i6men = edgesOf("gid:I6").filter((e) => e.type === "mentions");
  assert.equal(i6men.length, 1);
  assert.equal(i6men[0]!.from.externalId, "gid:I5", "mention points referencer -> self");
  assert.equal(i6men[0]!.to.externalId, "gid:I6");

  // MR1: mentioned by I6 (its own note) -> one mention; no closes on the MR side.
  const mr1 = edgesOf("gid:MR1");
  assert.equal(mr1.filter((e) => e.type === "closes").length, 0);
  const mr1men = mr1.filter((e) => e.type === "mentions");
  assert.equal(mr1men.length, 1);
  assert.equal(mr1men[0]!.from.externalId, "gid:I6");
  assert.equal(mr1men[0]!.to.externalId, "gid:MR1");
});

test("GitLab: MR approvers normalize into approved review activities (issue #93)", () => {
  const src = new GitLabSource(GL_DESC, glGql, ["g/p"]);
  const raw: RawRecord = {
    entityKind: "change_request", externalId: "gid:MR_appr", apiVersion: "gitlab.graphql",
    fetchedAt: "2026-06-01T00:00:00Z", contentHash: "h",
    payload: glNode("gid:MR_appr", "9", {
      state: "merged", mergedAt: "2026-06-05T00:00:00Z", updatedAt: "2026-06-06T00:00:00Z", draft: false,
      approved: true, approvalsRequired: 1,
      approvedBy: { nodes: [{ username: "alice" }, { username: "bob" }] },
      headPipeline: { status: "SUCCESS" }, detailedMergeStatus: "NOT_OPEN",
    }),
  };
  const reviews = src.normalize(raw)!.activities.filter((a) => a.kind === "review");
  assert.equal(reviews.length, 2, "one review activity per current approver");
  assert.ok(reviews.every((a) => a.action === "approved"), "GitLab review activity is always an approval");
  assert.deepEqual(reviews.map((a) => a.actor).sort(), ["alice", "bob"]);
  assert.equal(reviews[0]!.occurredAt, "2026-06-05T00:00:00Z", "dated by merged_at when merged");
  assert.equal(reviews[0]!.target?.externalId, "gid:MR_appr");
});

test("GitLab: an events-feed approval is dropped to avoid double-counting approvedBy (issue #93)", () => {
  const src = new GitLabSource(GL_DESC, glGql, ["g/p"]);
  const raw: RawRecord = {
    entityKind: "activity", externalId: "event:appr", apiVersion: "gitlab.graphql.rest",
    fetchedAt: "2026-06-01T00:00:00Z", contentHash: "h",
    payload: {
      __activityKind: "gitlab_project_event",
      project: "g/p",
      event: { id: 7, action_name: "approved", target_type: "MergeRequest", target_iid: 9, created_at: "2026-06-05T00:00:00Z", author_username: "alice" },
    },
  };
  assert.equal(src.normalize(raw), null, "events-feed approval is skipped; approvedBy is the canonical source");
});
