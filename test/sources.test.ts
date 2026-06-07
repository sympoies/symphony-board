import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSource } from "../src/sources/github.ts";
import { GitLabSource } from "../src/sources/gitlab.ts";
import type { GqlClient } from "../src/sources/graphql.ts";
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
  assert.equal(b.item.state, "merged");
  assert.equal(b.item.mergeState, null, "merged PR carries no merge badge");
  assert.equal(b.item.ciState, "passing", "CI is still meaningful after merge");
});

test("GitHub: an open PR keeps its real merge_state", () => {
  assert.equal(ghPrBundle("OPEN", "MERGEABLE").item.mergeState, "mergeable");
  assert.equal(ghPrBundle("OPEN", "CONFLICTING").item.mergeState, "conflicting");
  // UNKNOWN is a legitimate transient state while open and is preserved.
  assert.equal(ghPrBundle("OPEN", "UNKNOWN").item.mergeState, "unknown");
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
  assert.equal(b.item.state, "merged");
  assert.equal(b.item.mergeState, null, "merged MR carries no merge badge");
  assert.equal(b.item.ciState, "passing");
});

test("GitLab: an open MR keeps its real merge_state", () => {
  assert.equal(glMrBundle("opened", "MERGEABLE").item.mergeState, "mergeable");
  assert.equal(glMrBundle("opened", "CI_MUST_PASS").item.mergeState, "blocked");
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
