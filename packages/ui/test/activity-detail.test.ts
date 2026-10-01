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
  initialDetailMode,
  modeAfterRowClick,
  pushHeadCommit,
  reconcileDetailMode,
  selectedActivity,
  shouldClearDetailRoute,
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

  // A GitLab note whose item is not loaded names its target kind "comment";
  // its URL still says merge request, so the number reads !12.
  const note = activityRowView(
    activity({ source_id: "gitlab:gitlab.com", target_kind: "comment", target_ref: null, target_iid: 12, title: "Tune the loop", url: "https://gitlab.com/o/r/-/merge_requests/12#note_5" }),
    undefined,
    "gitlab",
  );
  assert.equal(note.label, "!12");
  assert.equal(note.title, "Tune the loop");
});

test("only a review row carries its change request's thread state", () => {
  const threaded = item({ review_threads: { open: 1, total: 2 } });
  assert.deepEqual(activityRowView(activity({ kind: "review", action: "reviewed" }), threaded, "github").chips, ["1 open thread"]);
  assert.deepEqual(activityRowView(activity({ kind: "review", action: "approved" }), item({ review_threads: { open: 0, total: 2 } }), "github").chips, ["threads resolved"]);
  assert.deepEqual(activityRowView(activity({ kind: "review", action: "reviewed" }), item({ review_threads: null }), "github").chips, []);
  assert.deepEqual(activityRowView(activity({ kind: "comment" }), threaded, "github").chips, [], "a comment on the same PR does not");
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

  // A GitLab note names its comment by the `#note_<id>` anchor; GitLab review
  // threads carry the note id as the comment id.
  const gitlabIndex = commentExcerptIndex([
    thread({ source_id: "gitlab:gitlab.com", target_ref: "gitlab:gitlab.com|gid://gitlab/MergeRequest/7" }),
  ]);
  const gitlabNote = (url: string) =>
    activity({ source_id: "gitlab:gitlab.com", target_kind: "comment", target_ref: null, target_iid: 12, url, details: { action_name: "commented on" } });
  const gitlab = commentExcerptOf(gitlabNote("https://gitlab.com/o/r/-/merge_requests/12#note_517490"), gitlabIndex);
  assert.equal(gitlab?.body.length, 600, "capped");
  assert.equal(gitlab?.truncated, true);
  assert.equal(commentExcerptOf(gitlabNote("https://gitlab.com/o/r/-/issues/5#note_999"), gitlabIndex), null, "an issue note has no thread");
  assert.equal(commentExcerptOf(gitlabNote("https://gitlab.com/o/r/-/merge_requests/12#note_517490"), index), null, "another source's thread never matches");

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

test("the detail follows the newest row, holds a pin, and falls back when the pin is gone", () => {
  const rows = [activity({ external_id: "a" }), activity({ external_id: "b" })];
  assert.equal(selectedActivity(rows, { kind: "following" })?.external_id, "a");
  assert.equal(selectedActivity(rows, { kind: "pinned", key: "github:github.com|b" })?.external_id, "b");
  assert.equal(selectedActivity(rows, { kind: "closed" }), null);
  assert.equal(selectedActivity([], { kind: "following" }), null);

  const pinned = { kind: "pinned", key: "github:github.com|b" } as const;
  assert.equal(reconcileDetailMode(pinned, rows), pinned, "a visible pin stays");
  assert.deepEqual(reconcileDetailMode(pinned, [rows[0]!]), { kind: "following" }, "a filtered-out pin follows the newest row");
  assert.deepEqual(reconcileDetailMode(pinned, []), { kind: "closed" }, "and closes when nothing is left");
  assert.deepEqual(reconcileDetailMode(pinned, [rows[0]!], true), { kind: "closed" }, "the reader closes rather than swapping events");
  const following = { kind: "following" } as const;
  assert.equal(reconcileDetailMode(following, []), following);
});

test("a wide screen opens on the newest row pinned, so a reload does not swap it; the reader starts closed", () => {
  const rows = [activity({ external_id: "a" }), activity({ external_id: "b" })];
  const start = initialDetailMode(rows, false);
  assert.deepEqual(start, { kind: "pinned", key: "github:github.com|a" });
  const reloaded = [activity({ external_id: "z" }), ...rows];
  assert.equal(selectedActivity(reloaded, start)?.external_id, "a", "a newer row arriving keeps the open event");
  assert.deepEqual(initialDetailMode(rows, true), { kind: "closed" });
  assert.deepEqual(initialDetailMode([], false), { kind: "following" }, "nothing to pin yet");
});

test("a click pins a row, and a click on the pinned row closes the pane", () => {
  assert.deepEqual(modeAfterRowClick({ kind: "following" }, "k1", "k1"), { kind: "pinned", key: "k1" }, "clicking the followed row pins it");
  assert.deepEqual(modeAfterRowClick({ kind: "pinned", key: "k1" }, "k1", "k1"), { kind: "closed" });
  assert.deepEqual(modeAfterRowClick({ kind: "pinned", key: "k1" }, "k2", "k1"), { kind: "pinned", key: "k2" });
  assert.deepEqual(modeAfterRowClick({ kind: "closed" }, "k2", null), { kind: "pinned", key: "k2" });
});

test("the reader's route flag clears outside the reader tier or without a selection", () => {
  assert.equal(shouldClearDetailRoute(true, false, true), true, "a wider window leaves the reader");
  assert.equal(shouldClearDetailRoute(true, true, false), true, "nothing selected");
  assert.equal(shouldClearDetailRoute(true, true, true), false);
  assert.equal(shouldClearDetailRoute(false, false, false), false);
});
