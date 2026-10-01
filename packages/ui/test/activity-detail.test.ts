import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityDTO, ItemDTO, ReviewThreadDTO } from "@symphony-board/contract";
import {
  activityRowView,
  activityTargetItem,
  activityTargetRef,
  commentExcerptIndex,
  commentExcerptOf,
  eventsOnTarget,
  pushHeadCommit,
  textExcerpt,
} from "../src/activity-detail.ts";

function activity(over: Partial<ActivityDTO> = {}): ActivityDTO {
  return {
    source_id: "github:github.com",
    external_id: "a-1",
    kind: "comment",
    action: "commented",
    project_path: "o/r",
    target_kind: "change_request",
    target_ref: "github:github.com|PR_1",
    target_iid: 36,
    title: "Fix the sync",
    url: "https://github.com/o/r/pull/36#issuecomment-1",
    actor: "dev-a",
    occurred_at: "2026-09-30T10:00:00Z",
    details: null,
    first_seen_at: null,
    last_seen_at: null,
    ...over,
  };
}

function item(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "github:github.com|PR_1",
    source_id: "github:github.com",
    external_id: "PR_1",
    kind: "change_request",
    project_path: "o/r",
    iid: 36,
    url: "https://github.com/o/r/pull/36",
    title: "Fix the sync",
    state: "merged",
    state_raw: "MERGED",
    state_reason: null,
    is_draft: false,
    author: "dev-a",
    created_at: "2026-09-29T10:00:00Z",
    updated_at: "2026-09-30T10:00:00Z",
    closed_at: null,
    merged_at: "2026-09-30T11:00:00Z",
    review_state: "approved",
    ci_state: "passing",
    merge_state: null,
    labels: [],
    milestone: null,
    demand: 0,
    last_seen_at: "2026-09-30T10:00:00Z",
    ...over,
  } as ItemDTO;
}

function thread(over: Partial<ReviewThreadDTO> = {}): ReviewThreadDTO {
  return {
    id: "github:github.com|PRRT_1",
    source_id: "github:github.com",
    external_id: "PRRT_1",
    project_path: "o/r",
    target_ref: "github:github.com|PR_1",
    target_iid: 36,
    title: "Fix the sync",
    url: "https://github.com/o/r/pull/36#discussion_r1",
    is_resolved: false,
    is_outdated: false,
    resolved_by: null,
    path: "src/sync.ts",
    line: 42,
    start_line: null,
    comments_total: 2,
    comments: [
      { id: "PRRC_1", author: "dev-b", body: "Should this retry?", url: null, created_at: null, updated_at: null },
      { id: "517490", author: "dev-c", body: "x".repeat(900), url: null, created_at: null, updated_at: null },
    ],
    last_seen_at: null,
    ...over,
  };
}

test("activityTargetRef reads target_ref, then a commit's change request", () => {
  assert.equal(activityTargetRef(activity()), "github:github.com|PR_1");
  assert.equal(
    activityTargetRef(activity({ kind: "commit", target_ref: null, details: { sha: "abc", change_request: { ref: "github:github.com|PR_9", iid: 9 } } })),
    "github:github.com|PR_9",
  );
  assert.equal(activityTargetRef(activity({ kind: "commit", target_ref: null, details: { sha: "abc", change_request: null } })), null);
  assert.equal(activityTargetRef(activity({ kind: "branch", target_ref: null })), null);
});

test("activityTargetItem resolves through the item index", () => {
  const items = new Map([[item().id, item()]]);
  assert.equal(activityTargetItem(activity(), items)?.external_id, "PR_1");
  assert.equal(activityTargetItem(activity({ target_ref: "github:github.com|PR_gone" }), items), undefined);
});

test("activityRowView names the target with its provider prefix and state", () => {
  const view = activityRowView(activity(), item(), "github");
  assert.equal(view.label, "#36");
  assert.equal(view.title, "Fix the sync");
  assert.equal(view.state, "merged");
  assert.equal(view.verdict, null);

  const gitlab = activityRowView(
    activity({ source_id: "gitlab:gitlab.com", target_kind: "comment", target_ref: "gitlab:gitlab.com|gid://gitlab/MergeRequest/7", target_iid: 12 }),
    item({ id: "gitlab:gitlab.com|gid://gitlab/MergeRequest/7", source_id: "gitlab:gitlab.com", iid: 12, state: "open", is_draft: true }),
    "gitlab",
  );
  assert.equal(gitlab.label, "!12", "a GitLab merge request is !N");
  assert.equal(gitlab.state, "draft", "an open draft reads as draft");

  const issue = activityRowView(activity({ target_kind: "issue", target_iid: 5 }), item({ kind: "issue", iid: 5, state: "open" }), "gitlab");
  assert.equal(issue.label, "#5", "a GitLab issue is #N");

  // Not loaded: the row still has the number and its own title.
  const unloaded = activityRowView(activity({ title: null }), undefined, "github");
  assert.equal(unloaded.label, "#36");
  assert.equal(unloaded.title, "change request");
  assert.equal(unloaded.state, null);
});

test("activityRowView carries the kind's own fact", () => {
  const review = activityRowView(activity({ kind: "review", action: "changes_requested" }), item(), "github");
  assert.equal(review.verdict, "changes requested");

  const reviewComment = activityRowView(activity({ details: { path: "src/sync.ts", line: 42, in_reply_to_id: 3 } }), item(), "github");
  assert.deepEqual(reviewComment.chips, ["src/sync.ts:42", "reply"]);

  const commit = activityRowView(
    activity({ kind: "commit", action: "committed", target_kind: "commit", target_ref: null, target_iid: null, title: "feat: thing", details: { sha: "0123456789abcdef", message: "feat: thing", branch: "main", additions: 3, deletions: 1 } }),
    undefined,
    "github",
  );
  assert.equal(commit.label, "01234567");
  assert.equal(commit.title, "feat: thing");
  assert.deepEqual(commit.diff, { additions: 3, deletions: 1 });
  assert.deepEqual(commit.chips, ["main"]);
  assert.deepEqual(commit.copy, { value: "0123456789abcdef", label: "commit hash" });

  const push = activityRowView(
    activity({ kind: "branch", action: "pushed", target_kind: "branch", target_ref: null, target_iid: null, title: "main", details: { ref: "refs/heads/main", before: "1111111111", after: "2222222222", push_type: "push" } }),
    undefined,
    "github",
  );
  assert.equal(push.label, null);
  assert.equal(push.title, "branch main");
  assert.deepEqual(push.chips, ["11111111 → 22222222"]);
  assert.deepEqual(push.copy, { value: "2222222222", label: "head commit" });

  const created = activityRowView(
    activity({ kind: "branch", action: "created", target_kind: "branch", target_ref: null, target_iid: null, details: { ref: "refs/heads/feat/x", before: "0000000000", after: "3333333333" } }),
    undefined,
    "github",
  );
  assert.deepEqual(created.chips, ["→ 33333333"], "an all-zero side is the ref not existing, not a commit");
});

test("comment excerpts come only from review thread comments the contract already carries", () => {
  const index = commentExcerptIndex([thread()]);
  const github = commentExcerptOf(activity({ details: { node_id: "PRRC_1" } }), index);
  assert.equal(github?.body, "Should this retry?");
  assert.equal(github?.author, "dev-b");
  assert.equal(github?.path, "src/sync.ts");
  assert.equal(github?.line, 42);
  assert.equal(github?.resolved, false);
  assert.equal(github?.truncated, false);

  const gitlab = commentExcerptOf(activity({ source_id: "github:github.com", url: "https://gitlab.com/o/r/-/merge_requests/12#note_517490", details: {} }), index);
  assert.equal(gitlab?.body.length, 600, "capped");
  assert.equal(gitlab?.truncated, true);

  // An issue comment has no thread: no text.
  assert.equal(commentExcerptOf(activity({ details: { node_id: "IC_1" }, url: "https://github.com/o/r/issues/5#issuecomment-9" }), index), null);
  // Only comment rows look; a review row never borrows a comment's words.
  assert.equal(commentExcerptOf(activity({ kind: "review", details: { node_id: "PRRC_1" } }), index), null);
  // A thread of another source never matches.
  assert.equal(commentExcerptOf(activity({ source_id: "gitlab:gitlab.com", details: { node_id: "PRRC_1" } }), index), null);
});

test("eventsOnTarget lists the other rows about the same item, newest first", () => {
  const rows = [
    activity({ external_id: "c3", occurred_at: "2026-09-30T12:00:00Z" }),
    activity({ external_id: "other", target_ref: "github:github.com|PR_2" }),
    activity({ external_id: "c2", kind: "review", action: "approved", occurred_at: "2026-09-30T11:00:00Z" }),
    activity({ external_id: "c1", occurred_at: "2026-09-30T10:00:00Z" }),
    activity({ external_id: "commit", kind: "commit", target_ref: null, details: { sha: "abc", change_request: { ref: "github:github.com|PR_1", iid: 36 } }, occurred_at: "2026-09-29T10:00:00Z" }),
  ];
  const on = eventsOnTarget(rows, rows[3]!, 2);
  assert.deepEqual(on.rows.map((r) => r.external_id), ["c3", "c2"]);
  assert.equal(on.total, 3, "every other row on the item, including a commit that names it as its change request");
  assert.deepEqual(eventsOnTarget(rows, activity({ external_id: "x", kind: "branch", target_ref: null }), 5), { rows: [], total: 0 });
});

test("pushHeadCommit finds the loaded commit a push moved its ref to", () => {
  const head = activity({ external_id: "c", kind: "commit", target_ref: null, details: { sha: "2222222222abcdef" } });
  const rows = [head, activity({ external_id: "d", kind: "commit", target_ref: null, details: { sha: "9999" } })];
  assert.equal(pushHeadCommit(rows, activity({ kind: "branch", details: { after: "2222222222abcdef" } }))?.external_id, "c");
  assert.equal(pushHeadCommit(rows, activity({ kind: "push", details: { commit_to: "2222222222abcdef" } }))?.external_id, "c");
  assert.equal(pushHeadCommit(rows, activity({ kind: "branch", details: { after: "0000000000" } })), undefined);
  assert.equal(pushHeadCommit(rows, activity({ kind: "comment", details: { after: "2222222222abcdef" } })), undefined);
});

test("textExcerpt trims, caps at a word boundary and reports truncation", () => {
  assert.deepEqual(textExcerpt("  hello  ", 10), { text: "hello", truncated: false });
  assert.deepEqual(textExcerpt(null, 10), null);
  assert.deepEqual(textExcerpt("   ", 10), null);
  assert.deepEqual(textExcerpt("alpha beta gamma", 12), { text: "alpha beta", truncated: true });
});
