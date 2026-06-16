import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ActivityDTO,
  ContractEnvelope,
  ItemDTO,
  SourceDTO,
} from "@symphony-board/contract";
import {
  buildReviewCandidates,
  defaultOptions,
  type ReviewCandidateOptions,
} from "../src/cli/review-candidates.ts";

// review-candidates is the board's first-class promotion of the bespoke
// project-review-cleanup discovery logic: the board computes candidates from
// its OWN contract projection. These tests feed a small in-memory contract
// through the pure candidate computation and assert the candidate set,
// reasons, and ordering — without touching a store or the provider.

const GITHUB_SOURCE: SourceDTO = {
  source_id: "github:github.com",
  kind: "github",
  host: "github.com",
  display_name: "GitHub",
  last_success_at: "2026-06-01T00:00:00Z",
  last_status: "ok",
  color: null,
};

const GITLAB_SOURCE: SourceDTO = {
  source_id: "gitlab:gitlab.com",
  kind: "gitlab",
  host: "gitlab.com",
  display_name: "GitLab",
  last_success_at: "2026-06-01T00:00:00Z",
  last_status: "ok",
  color: null,
};

function changeRequest(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "github:github.com|PR_x",
    source_id: "github:github.com",
    external_id: "PR_x",
    kind: "change_request",
    project_path: "graysurf/repo",
    iid: 100,
    url: "https://github.com/graysurf/repo/pull/100",
    title: "A change request",
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "graysurf",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-10T00:00:00Z",
    closed_at: null,
    merged_at: null,
    labels: [],
    review_state: null,
    ci_state: null,
    merge_state: null,
    review_threads: null,
    milestone: null,
    demand: null,
    last_seen_at: "2026-06-10T00:00:00Z",
    ...over,
  };
}

function reviewActivity(over: Partial<ActivityDTO> = {}): ActivityDTO {
  return {
    id: "github:github.com|REV_x",
    source_id: "github:github.com",
    external_id: "REV_x",
    kind: "review",
    action: "reviewed",
    project_path: "graysurf/repo",
    target_kind: "change_request",
    target_ref: "github:github.com|PR_x",
    target_iid: 100,
    title: "A change request",
    url: "https://github.com/graysurf/repo/pull/100#review",
    actor: "chatgpt-codex-connector",
    occurred_at: "2026-06-12T00:00:00Z",
    summary: null,
    details: { state: "COMMENTED" },
    first_seen_at: null,
    last_seen_at: null,
    ...over,
  };
}

function envelope(over: Partial<ContractEnvelope> = {}): ContractEnvelope {
  return {
    contract_version: "3.4.0",
    generated_at: "2026-06-16T00:00:00Z",
    generator: "test",
    sources: [GITHUB_SOURCE, GITLAB_SOURCE],
    items: [],
    edges: [],
    activities: [],
    ...over,
  };
}

// A fixed "now" so the --days window is deterministic regardless of when the
// test runs. The contract dates above are all in mid-June 2026.
const NOW = Date.parse("2026-06-16T00:00:00Z");

function opts(over: Partial<ReviewCandidateOptions> = {}): ReviewCandidateOptions {
  return { ...defaultOptions(), now: NOW, ...over };
}

test("Pass 1: an open-thread GitHub change_request becomes an open_review_threads candidate", () => {
  const env = envelope({
    items: [
      changeRequest({ iid: 100, review_threads: { open: 2, total: 5 } }),
    ],
  });
  const candidates = buildReviewCandidates(env, opts());
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.equal(c.pr, 100);
  assert.equal(c.repo, "graysurf/repo");
  assert.equal(c.source_id, "github:github.com");
  assert.equal(c.openThreads, 2);
  assert.equal(c.totalThreads, 5);
  assert.deepEqual(c.reasons, ["open_review_threads"]);
  assert.equal(c.reason, "open_review_threads");
  assert.equal(c.itemState, "open");
});

test("a change_request with zero open threads is NOT a candidate", () => {
  const env = envelope({
    items: [changeRequest({ iid: 101, review_threads: { open: 0, total: 4 } })],
  });
  assert.equal(buildReviewCandidates(env, opts()).length, 0);
});

test("a GitLab change_request with open threads is excluded (GitHub-only discovery)", () => {
  const env = envelope({
    items: [
      changeRequest({
        id: "gitlab:gitlab.com|MR_x",
        source_id: "gitlab:gitlab.com",
        external_id: "MR_x",
        iid: 200,
        project_path: "group/proj",
        review_threads: { open: 3, total: 3 },
      }),
    ],
  });
  assert.equal(buildReviewCandidates(env, opts()).length, 0);
});

test("Pass 2: a late allowlisted bot review (after merge) is a late_review candidate", () => {
  const env = envelope({
    items: [
      changeRequest({
        iid: 102,
        state: "merged",
        merged_at: "2026-06-11T00:00:00Z",
        review_threads: { open: 0, total: 2 },
      }),
    ],
    activities: [
      // landed AFTER merged_at, inside the default 7-day window
      reviewActivity({ target_iid: 102, occurred_at: "2026-06-13T00:00:00Z" }),
    ],
  });
  const candidates = buildReviewCandidates(env, opts());
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.equal(c.pr, 102);
  assert.deepEqual(c.reasons, ["late_review"]);
  assert.equal(c.reason, "late_review");
  assert.equal(c.actor, "chatgpt-codex-connector");
  assert.equal(c.reviewUrl, "https://github.com/graysurf/repo/pull/100#review");
});

test("Pass 2: an allowlisted bot review on an already-closed PR is review_on_closed_pr", () => {
  const env = envelope({
    items: [
      changeRequest({
        iid: 103,
        state: "closed",
        closed_at: "2026-06-14T00:00:00Z",
        review_threads: { open: 0, total: 1 },
      }),
    ],
    activities: [
      // BEFORE closed_at, so not "late", but the item is closed
      reviewActivity({ target_iid: 103, occurred_at: "2026-06-12T00:00:00Z" }),
    ],
  });
  const candidates = buildReviewCandidates(env, opts());
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.reasons, ["review_on_closed_pr"]);
});

test("a non-allowlisted late review is ignored unless --all-actors", () => {
  const env = envelope({
    items: [
      changeRequest({
        iid: 104,
        state: "merged",
        merged_at: "2026-06-11T00:00:00Z",
        review_threads: { open: 0, total: 0 },
      }),
    ],
    activities: [
      reviewActivity({ target_iid: 104, actor: "some-human", occurred_at: "2026-06-13T00:00:00Z" }),
    ],
  });
  assert.equal(buildReviewCandidates(env, opts()).length, 0);
  const widened = buildReviewCandidates(env, opts({ allActors: true }));
  assert.equal(widened.length, 1);
  assert.deepEqual(widened[0]!.reasons, ["late_review"]);
});

test("a late review older than the --days window is excluded; open-thread discovery is NOT windowed", () => {
  const env = envelope({
    items: [
      // open thread, very old update — still surfaces (Pass 1 is not windowed)
      changeRequest({
        iid: 105,
        updated_at: "2025-01-01T00:00:00Z",
        review_threads: { open: 1, total: 1 },
      }),
      // late bot review well outside the 7-day window — excluded
      changeRequest({
        iid: 106,
        state: "merged",
        merged_at: "2026-01-01T00:00:00Z",
        review_threads: { open: 0, total: 0 },
      }),
    ],
    activities: [
      reviewActivity({ target_iid: 106, occurred_at: "2026-01-02T00:00:00Z" }),
    ],
  });
  const candidates = buildReviewCandidates(env, opts());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.pr, 105);
  assert.deepEqual(candidates[0]!.reasons, ["open_review_threads"]);
});

test("ordering: open-thread candidates first (most open threads first), enrichment, and --limit", () => {
  const env = envelope({
    items: [
      changeRequest({ iid: 110, review_threads: { open: 1, total: 1 } }),
      changeRequest({ iid: 111, review_threads: { open: 4, total: 6 } }),
      changeRequest({
        iid: 112,
        state: "merged",
        merged_at: "2026-06-11T00:00:00Z",
        review_threads: { open: 0, total: 0 },
      }),
    ],
    activities: [
      // late review on 112 -> a candidate with no open threads, sorts last
      reviewActivity({
        id: "github:github.com|REV_112",
        external_id: "REV_112",
        target_iid: 112,
        occurred_at: "2026-06-13T00:00:00Z",
        url: "https://github.com/graysurf/repo/pull/112#review",
      }),
    ],
  });
  const all = buildReviewCandidates(env, opts());
  assert.deepEqual(
    all.map((c) => c.pr),
    [111, 110, 112],
    "most open threads first, then the no-open-thread late_review last",
  );

  const limited = buildReviewCandidates(env, opts({ limit: 2 }));
  assert.deepEqual(
    limited.map((c) => c.pr),
    [111, 110],
    "--limit truncates after sorting",
  );
});

test("an item that is BOTH open-thread and late_review carries both reasons, led by open_review_threads", () => {
  const env = envelope({
    items: [
      changeRequest({
        iid: 120,
        state: "merged",
        merged_at: "2026-06-11T00:00:00Z",
        review_threads: { open: 2, total: 3 },
      }),
    ],
    activities: [
      reviewActivity({ target_iid: 120, occurred_at: "2026-06-13T00:00:00Z" }),
    ],
  });
  const candidates = buildReviewCandidates(env, opts());
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.deepEqual([...c.reasons].sort(), ["late_review", "open_review_threads"]);
  assert.equal(c.reason, "open_review_threads");
});
