import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidates, classifyLive, parseDispositionDocument, resolveContractSource, runCleanup } from "../.agents/skills/project-review-cleanup/scripts/review-cleanup.mjs";

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

test("repo env selects the Postgres served contract by default", () => {
  const source = resolveContractSource(
    {
      contractPath: null,
      contractUrl: null,
    },
    {
      repoEnv: { SYMPHONY_BOARD_ENV: "postgres" },
      processEnv: {},
    },
  );

  assert.equal(source.kind, "url");
  assert.equal(source.value, "http://127.0.0.1:18080/contract.json");
  assert.equal(source.origin, "SYMPHONY_BOARD_ENV=postgres");
});

test("explicit contract path wins over the repo environment default", () => {
  const source = resolveContractSource(
    {
      contractPath: "data/contract.json",
      contractUrl: null,
    },
    {
      repoEnv: { SYMPHONY_BOARD_ENV: "postgres" },
      processEnv: {},
    },
  );

  assert.equal(source.kind, "file");
  assert.equal(source.value, "data/contract.json");
  assert.equal(source.origin, "--contract");
});

test("repo env selects the SQLite contract file by default", () => {
  const source = resolveContractSource(
    {
      contractPath: null,
      contractUrl: null,
    },
    {
      repoEnv: { SYMPHONY_BOARD_ENV: "sqlite" },
      processEnv: {},
    },
  );

  assert.equal(source.kind, "file");
  assert.equal(source.value, "data/contract.json");
  assert.equal(source.origin, "SYMPHONY_BOARD_ENV=sqlite");
});

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

test("JSON result summarizes live unresolved threads on the result and candidates", () => {
  const contract = candidateContract([
    { source_id: "github:github.com", project_path: "graysurf/agent-runtime-kit", iid: 356 },
  ]);

  const result = runCleanup(options(), null, contract, {
    queryPr(_repo, pr) {
      return pullRequest(pr, [
        reviewThread("thread-356-a", [
          { author: { login: "chatgpt-codex-connector" }, url: "https://example.test/356-a" },
        ]),
        reviewThread("thread-356-b", [
          { author: { login: "chatgpt-codex-connector" }, url: "https://example.test/356-b" },
        ]),
      ]);
    },
  });

  assert.equal(result.summary.contractCandidateCount, 1);
  assert.equal(result.summary.liveTargetCount, 1);
  assert.equal(result.summary.liveUnresolvedThreadCount, 2);
  assert.equal(result.summary.liveSafeToResolveThreadCount, 2);
  assert.equal(result.candidates[0].live.checked, true);
  assert.equal(result.candidates[0].live.unresolvedCount, 2);
  assert.deepEqual(result.candidates[0].live.unresolvedThreadIds, ["thread-356-a", "thread-356-b"]);
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

function threadItem({
  source_id = "github:github.com",
  iid,
  project_path = "sympoies/symphony-board",
  state = "merged",
  merged_at = "2026-06-08T00:00:00Z",
  open,
  total,
}) {
  return {
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
    review_threads: { open, total },
  };
}

function reviewActivity({
  source_id = "github:github.com",
  iid,
  project_path = "sympoies/symphony-board",
  actor,
  occurred_at,
}) {
  return {
    source_id,
    kind: "review",
    target_kind: "change_request",
    target_iid: iid,
    project_path,
    actor,
    action: "reviewed",
    occurred_at,
    title: `PR ${iid}`,
    url: `https://example.test/review/${iid}`,
    details: { state: "COMMENTED" },
  };
}

test("open review threads surface as candidates regardless of the review actor", () => {
  // The contract reports open threads on a PR whose only review came from a
  // non-allowlisted actor; default options must still surface it. A resolved PR
  // with no open threads and no late/closed bot review must not appear.
  const contract = {
    sources: [{ source_id: "github:github.com", kind: "github", host: "github.com" }],
    items: [
      threadItem({ iid: 74, open: 2, total: 2 }),
      threadItem({ iid: 99, open: 0, total: 3 }),
    ],
    activities: [reviewActivity({ iid: 74, actor: "github-code-quality", occurred_at: "2026-06-08T06:00:00Z" })],
  };

  const candidates = buildCandidates(contract, options(), "sympoies/symphony-board");
  const pr74 = candidates.find((candidate) => candidate.pr === 74);
  assert.ok(pr74, "open-thread PR is a candidate even though its reviewer is not allowlisted");
  assert.equal(pr74.reason, "open_review_threads");
  assert.equal(pr74.openThreads, 2);
  assert.equal(pr74.actor, "github-code-quality", "display is enriched with the last reviewer");
  assert.equal(candidates.find((candidate) => candidate.pr === 99), undefined);
});

test("open-thread discovery ignores the --days window and the actor allowlist", () => {
  // A long-merged PR with a stale, non-allowlisted review outside the window:
  // the activity path drops it, but the open-thread path still surfaces it.
  const contract = {
    sources: [{ source_id: "github:github.com", kind: "github", host: "github.com" }],
    items: [threadItem({ iid: 58, open: 1, total: 2, merged_at: "2020-01-01T00:00:00Z" })],
    activities: [reviewActivity({ iid: 58, actor: "github-code-quality", occurred_at: "2020-01-02T00:00:00Z" })],
  };

  const candidates = buildCandidates(contract, options({ days: 1 }), "sympoies/symphony-board");
  assert.deepEqual(candidates.map((candidate) => candidate.pr), [58]);
  assert.equal(candidates[0].reason, "open_review_threads");
});

test("open-thread candidates lead resolved late-review candidates in the report", () => {
  const contract = {
    sources: [{ source_id: "github:github.com", kind: "github", host: "github.com" }],
    items: [
      threadItem({ iid: 58, open: 1, total: 2 }),
      threadItem({ iid: 181, open: 0, total: 1 }),
    ],
    // 181 has an allowlisted bot review that landed after merge → late_review,
    // but its threads are already resolved (open: 0).
    activities: [reviewActivity({ iid: 181, actor: "chatgpt-codex-connector", occurred_at: "2026-06-08T06:00:00Z" })],
  };

  const candidates = buildCandidates(contract, options(), "sympoies/symphony-board");
  assert.deepEqual(candidates.map((candidate) => [candidate.pr, candidate.reason]), [
    [58, "open_review_threads"],
    [181, "late_review"],
  ]);
});

test("GitLab open-thread MRs are not added (the live path is GitHub-only)", () => {
  const contract = {
    sources: [{ source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com" }],
    items: [threadItem({ source_id: "gitlab:gitlab.com", iid: 5, project_path: "group/proj", open: 3, total: 4 })],
    activities: [],
  };

  assert.deepEqual(buildCandidates(contract, options(), null), []);
});
