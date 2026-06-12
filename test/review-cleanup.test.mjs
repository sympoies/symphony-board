import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidates, classifyLive, parseDispositionDocument, runCleanup } from "../.agents/skills/project-review-cleanup/scripts/review-cleanup.mjs";

const allowActors = ["chatgpt-codex-connector"];

function options(overrides = {}) {
  return {
    contractPath: "fixture-contract.json",
    repo: null,
    pr: null,
    days: 3650,
    actors: [],
    allActors: false,
    limit: 20,
    live: true,
    apply: false,
    dispositionPath: null,
    dispositions: null,
    resolutionNote: null,
    json: true,
    allowActors,
    ...overrides,
  };
}

function candidateContract(entries) {
  const sources = [
    { source_id: "github:github.com", kind: "github", host: "github.com" },
    { source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com" },
  ];
  const items = entries.map(({
    source_id,
    iid,
    project_path = "sympoies/symphony-board",
    state = "merged",
    merged_at = "2026-06-12T17:00:00Z",
  }) => ({
    source_id,
    external_id: `${source_id}:${iid}`,
    kind: "change_request",
    project_path,
    iid,
    title: `PR ${iid}`,
    state,
    merged_at,
    closed_at: merged_at,
    url: `https://example.test/${iid}`,
  }));
  const activities = entries.map(({
    source_id,
    iid,
    project_path = "sympoies/symphony-board",
    occurred_at = "2026-06-12T17:05:00Z",
  }) => ({
    source_id,
    kind: "review",
    target_kind: "change_request",
    target_iid: iid,
    project_path,
    actor: "chatgpt-codex-connector",
    action: "reviewed",
    occurred_at,
    title: `PR ${iid}`,
    url: `https://example.test/review/${iid}`,
    details: { state: "COMMENTED" },
  }));
  return { sources, items, activities };
}

function reviewThread(id, comments) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "script.mjs",
    line: 42,
    comments: {
      totalCount: comments.length,
      nodes: comments,
    },
  };
}

function pullRequest(number, threads, state = "MERGED") {
  return {
    number,
    state,
    title: `PR ${number}`,
    url: `https://github.com/sympoies/symphony-board/pull/${number}`,
    mergedAt: "2026-06-12T17:00:00Z",
    closedAt: "2026-06-12T17:00:00Z",
    reviewThreads: { nodes: threads },
    reviews: { nodes: [] },
  };
}

test("contract scan ignores non-GitHub review candidates before focusing GitHub PRs", () => {
  const contract = candidateContract([
    { source_id: "gitlab:gitlab.com", iid: 183, occurred_at: "2026-06-12T17:10:00Z" },
    { source_id: "github:github.com", iid: 184, occurred_at: "2026-06-12T17:09:00Z" },
  ]);

  const candidates = buildCandidates(contract, options(), "sympoies/symphony-board");

  assert.deepEqual(candidates.map((candidate) => candidate.pr), [184]);
  assert.equal(candidates[0].repo, "sympoies/symphony-board");
});

test("default contract scan verifies candidates from every GitHub repo", () => {
  const contract = candidateContract([
    {
      source_id: "github:github.com",
      project_path: "sympoies/symphony-board",
      iid: 183,
      occurred_at: "2026-06-12T17:10:00Z",
    },
    {
      source_id: "github:github.com",
      project_path: "graysurf/agent-runtime-kit",
      iid: 323,
      occurred_at: "2026-06-12T17:09:00Z",
    },
  ]);
  const queried = [];

  const result = runCleanup(options(), null, contract, {
    queryPr(repo, pr) {
      queried.push([repo, pr]);
      return pullRequest(pr, []);
    },
  });

  assert.deepEqual(result.candidates.map((candidate) => [candidate.repo, candidate.pr]), [
    ["sympoies/symphony-board", 183],
    ["graysurf/agent-runtime-kit", 323],
  ]);
  assert.deepEqual(queried, [
    ["sympoies/symphony-board", 183],
    ["graysurf/agent-runtime-kit", 323],
  ]);
});

test("--pr without --repo warns when the contract has no matching candidate", () => {
  const contract = candidateContract([
    { source_id: "github:github.com", project_path: "sympoies/symphony-board", iid: 183 },
  ]);

  const result = runCleanup(options({ pr: 999 }), null, contract, {
    queryPr() {
      throw new Error("should not query without a target repo");
    },
  });

  assert.equal(result.live.length, 0);
  assert.match(result.warnings[0], /pass --repo OWNER\/REPO/);
});

test("threads with missing comment authors are not safe to resolve", () => {
  const live = classifyLive(
    pullRequest(183, [
      reviewThread("thread-1", [
        { author: { login: "chatgpt-codex-connector" }, url: "https://example.test/1" },
        { author: null, url: "https://example.test/2" },
      ]),
    ]),
    allowActors,
  );

  assert.equal(live.safeToResolveCount, 0);
  assert.equal(live.unresolvedThreads[0].safeToResolve, false);
  assert.equal(live.unresolvedThreads[0].reason, "thread_has_unknown_author");
  assert.equal(live.unresolvedThreads[0].unknownAuthorCount, 1);
});

test("live classification includes review comment text and diff context for agent disposition", () => {
  const live = classifyLive(
    pullRequest(183, [
      reviewThread("thread-1", [
        {
          id: "comment-1",
          author: { login: "chatgpt-codex-connector" },
          url: "https://example.test/1",
          bodyText: "This guard looks incomplete.",
          diffHunk: "@@ -1 +1 @@\n-old\n+new",
          pullRequestReview: {
            id: "review-1",
            state: "COMMENTED",
            submittedAt: "2026-06-12T17:05:00Z",
            url: "https://example.test/review",
            author: { login: "chatgpt-codex-connector" },
          },
        },
      ]),
    ]),
    allowActors,
  );

  const [thread] = live.unresolvedThreads;
  assert.equal(thread.latestCommentText, "This guard looks incomplete.");
  assert.equal(thread.comments[0].bodyText, "This guard looks incomplete.");
  assert.equal(thread.comments[0].diffHunk, "@@ -1 +1 @@\n-old\n+new");
  assert.equal(thread.comments[0].review.url, "https://example.test/review");
});

test("disposition documents normalize thread notes and follow-up links", () => {
  const dispositions = parseDispositionDocument({
    threads: [
      {
        thread_id: "thread-1",
        disposition: "follow_up",
        follow_up_url: "https://github.com/sympoies/symphony-board/issues/200",
      },
      {
        threadId: "thread-2",
        disposition: "stale",
        note: "Resolved as stale after checking the merged diff.",
      },
    ],
  });

  assert.equal(dispositions.size, 2);
  assert.equal(
    dispositions.get("thread-1").note,
    "Resolved by project-review-cleanup: tracked in follow-up issue https://github.com/sympoies/symphony-board/issues/200.",
  );
  assert.equal(dispositions.get("thread-2").disposition, "stale");
});

test("apply verifies every focused PR before resolving any safe thread", () => {
  const contract = candidateContract([
    { source_id: "github:github.com", iid: 181, occurred_at: "2026-06-12T17:10:00Z" },
    { source_id: "github:github.com", iid: 183, occurred_at: "2026-06-12T17:09:00Z" },
  ]);
  const calls = [];

  const result = runCleanup(
    options({ apply: true, resolutionNote: "Follow-up exists." }),
    "sympoies/symphony-board",
    contract,
    {
      queryPr(_repo, pr) {
        if (pr === 181) {
          return pullRequest(181, [
            reviewThread("thread-181", [
              { author: { login: "chatgpt-codex-connector" }, url: "https://example.test/181" },
            ]),
          ]);
        }
        throw new Error("GitHub unavailable");
      },
      replyThread(threadId, body) {
        calls.push(["reply", threadId, body]);
        return { url: "https://example.test/note" };
      },
      resolveThread(threadId) {
        calls.push(["resolve", threadId]);
        return { isResolved: true };
      },
    },
  );

  assert.equal(result.actions.length, 0);
  assert.deepEqual(calls, []);
  assert.equal(result.live.length, 2);
  assert.match(result.warnings.at(-1), /apply aborted before mutation/);
});

test("apply posts a resolution note, resolves the thread, and records the disposition reason", () => {
  const contract = candidateContract([{ source_id: "github:github.com", iid: 183 }]);
  const calls = [];

  const result = runCleanup(
    options({ apply: true, resolutionNote: "Follow-up PR: https://github.com/sympoies/symphony-board/pull/184" }),
    "sympoies/symphony-board",
    contract,
    {
      queryPr() {
        return pullRequest(183, [
          reviewThread("thread-183", [
            { author: { login: "chatgpt-codex-connector" }, url: "https://example.test/183" },
          ]),
        ]);
      },
      replyThread(threadId, body) {
        calls.push(["reply", threadId, body]);
        return { url: "https://example.test/note" };
      },
      resolveThread(threadId) {
        calls.push(["resolve", threadId]);
        return { isResolved: true };
      },
    },
  );

  assert.deepEqual(calls, [
    ["reply", "thread-183", "Follow-up PR: https://github.com/sympoies/symphony-board/pull/184"],
    ["resolve", "thread-183"],
  ]);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].reason, "closed_pr_allowlisted_bot_thread");
  assert.equal(result.actions[0].noteUrl, "https://example.test/note");
});

test("apply with dispositions resolves only agent-dispositioned safe threads", () => {
  const contract = candidateContract([{ source_id: "github:github.com", iid: 183 }]);
  const calls = [];
  const dispositions = parseDispositionDocument({
    threads: [
      {
        threadId: "thread-1",
        disposition: "follow_up",
        note: "Follow-up issue: https://github.com/sympoies/symphony-board/issues/200",
      },
    ],
  });

  const result = runCleanup(
    options({ apply: true, dispositions, dispositionPath: "dispositions.json" }),
    "sympoies/symphony-board",
    contract,
    {
      queryPr() {
        return pullRequest(183, [
          reviewThread("thread-1", [
            { author: { login: "chatgpt-codex-connector" }, url: "https://example.test/1" },
          ]),
          reviewThread("thread-2", [
            { author: { login: "chatgpt-codex-connector" }, url: "https://example.test/2" },
          ]),
        ]);
      },
      replyThread(threadId, body) {
        calls.push(["reply", threadId, body]);
        return { url: `https://example.test/note/${threadId}` };
      },
      resolveThread(threadId) {
        calls.push(["resolve", threadId]);
        return { isResolved: true };
      },
    },
  );

  assert.deepEqual(calls, [
    ["reply", "thread-1", "Follow-up issue: https://github.com/sympoies/symphony-board/issues/200"],
    ["resolve", "thread-1"],
  ]);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].disposition, "follow_up");
  assert.match(result.warnings.at(-1), /thread-2 lacks an agent disposition/);
});

test("apply with dispositions leaves unsafe listed threads unresolved", () => {
  const contract = candidateContract([{ source_id: "github:github.com", iid: 183 }]);
  const calls = [];
  const dispositions = parseDispositionDocument({
    "thread-unsafe": {
      disposition: "accepted",
      note: "Accepted as a tradeoff.",
    },
  });

  const result = runCleanup(
    options({ apply: true, dispositions, dispositionPath: "dispositions.json" }),
    "sympoies/symphony-board",
    contract,
    {
      queryPr() {
        return pullRequest(183, [
          reviewThread("thread-unsafe", [
            { author: { login: "human-reviewer" }, url: "https://example.test/human" },
          ]),
        ]);
      },
      replyThread() {
        calls.push(["reply"]);
      },
      resolveThread() {
        calls.push(["resolve"]);
      },
    },
  );

  assert.deepEqual(calls, []);
  assert.equal(result.actions.length, 0);
  assert.match(result.warnings[0], /human_or_unallowlisted_author/);
});
