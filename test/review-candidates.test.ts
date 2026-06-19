import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { buildContract } from "../src/contract/build.ts";
import type { AppConfig } from "../src/config.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import type { ItemRow, SourceRow } from "../src/db/store.ts";
import type { CanonicalItem } from "../src/model/types.ts";
import { handleReviewCandidatesRequest } from "../src/server/review-candidates.ts";

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
  // Each change_request gets a unique immutable id derived from its iid (real
  // provider node ids are unique), so the activity->item join can key on the
  // ref instead of the mutable (source_id, project_path, iid) tuple.
  const iid = over.iid ?? 100;
  const externalId = over.external_id ?? `PR_${iid}`;
  return {
    id: `github:github.com|${externalId}`,
    source_id: "github:github.com",
    external_id: externalId,
    kind: "change_request",
    project_path: "dev-a/repo",
    iid,
    url: "https://github.com/dev-a/repo/pull/100",
    title: "A change request",
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "dev-a",
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
  // target_ref defaults to the matching change_request's immutable id (derived
  // from target_iid), mirroring how the contract links a review to its PR.
  const targetIid = over.target_iid ?? 100;
  const targetRef = over.target_ref ?? `github:github.com|PR_${targetIid}`;
  return {
    source_id: "github:github.com",
    external_id: "REV_x",
    kind: "review",
    action: "reviewed",
    project_path: "dev-a/repo",
    target_kind: "change_request",
    target_ref: targetRef,
    target_iid: targetIid,
    title: "A change request",
    url: "https://github.com/dev-a/repo/pull/100#review",
    actor: "chatgpt-codex-connector",
    occurred_at: "2026-06-12T00:00:00Z",
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
  assert.equal(c.repo, "dev-a/repo");
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
  assert.equal(c.reviewUrl, "https://github.com/dev-a/repo/pull/100#review");
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
        external_id: "REV_112",
        target_iid: 112,
        occurred_at: "2026-06-13T00:00:00Z",
        url: "https://github.com/dev-a/repo/pull/112#review",
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

test("Pass 2: a late review still matches its item across a repo rename (immutable target_ref join)", () => {
  // The item was re-synced under its new project_path; the older review activity
  // still carries the pre-rename project_path. Both share the immutable
  // id / target_ref, so the activity->item join must key on the ref, not the
  // mutable (source_id, project_path, iid) tuple.
  const env = envelope({
    items: [
      changeRequest({
        id: "github:github.com|PR_renamed",
        external_id: "PR_renamed",
        iid: 300,
        project_path: "dev-a/repo-new",
        state: "merged",
        merged_at: "2026-06-11T00:00:00Z",
        review_threads: { open: 0, total: 2 },
      }),
    ],
    activities: [
      reviewActivity({
        external_id: "REV_renamed",
        project_path: "dev-a/repo-old", // stale: pre-rename path
        target_ref: "github:github.com|PR_renamed", // immutable
        target_iid: 300,
        occurred_at: "2026-06-13T00:00:00Z",
        url: "https://github.com/dev-a/repo-new/pull/300#review",
      }),
    ],
  });
  const candidates = buildReviewCandidates(env, opts());
  assert.equal(candidates.length, 1, "the late review matches the renamed item via target_ref");
  const c = candidates[0]!;
  assert.equal(c.pr, 300);
  assert.deepEqual(c.reasons, ["late_review"]);
  assert.equal(c.actor, "chatgpt-codex-connector", "enrichment also joins by target_ref");
});

test("focused --repo discovery finds a renamed PR's late review (filter the resolved item, not the stale activity path)", () => {
  // Same rename scenario, but scoped to the item's CURRENT repo. Pass 2 must
  // resolve the item before applying --repo, else it filters on the activity's
  // stale project_path and the renamed PR is skipped under focused discovery.
  const env = envelope({
    items: [
      changeRequest({
        id: "github:github.com|PR_renamed",
        external_id: "PR_renamed",
        iid: 300,
        project_path: "dev-a/repo-new",
        state: "merged",
        merged_at: "2026-06-11T00:00:00Z",
        review_threads: { open: 0, total: 2 },
      }),
    ],
    activities: [
      reviewActivity({
        external_id: "REV_renamed",
        project_path: "dev-a/repo-old", // stale: pre-rename path
        target_ref: "github:github.com|PR_renamed",
        target_iid: 300,
        occurred_at: "2026-06-13T00:00:00Z",
        url: "https://github.com/dev-a/repo-new/pull/300#review",
      }),
    ],
  });
  const candidates = buildReviewCandidates(env, opts({ repo: "dev-a/repo-new" }));
  assert.equal(candidates.length, 1, "focused --repo discovery matches against the item's current path");
  assert.equal(candidates[0]!.pr, 300);
  assert.equal(candidates[0]!.repo, "dev-a/repo-new");
});

// Discovery must see EVERY open-thread change_request, not just the 90-day board
// window buildContract applies to envelope.items. A merged PR with a lingering
// unresolved thread and no recent update ages out of that window, so a windowed
// envelope silently drops it from Pass 1. review-candidates therefore builds the
// candidate set from the full ("itemWindow: full") projection.
const GITHUB_SOURCE_ROW: SourceRow = {
  source_id: "github:github.com",
  kind: "github",
  host: "github.com",
  display_name: "GitHub",
  last_success_at: "2026-06-01T00:00:00Z",
  last_status: "ok",
};

function staleOpenThreadRow(): ItemRow {
  return {
    item_id: 1,
    source_id: "github:github.com",
    external_id: "PR_stale",
    kind: "change_request",
    project_path: "dev-a/repo",
    iid: 400,
    url: "https://github.com/dev-a/repo/pull/400",
    title: "A long-merged PR with a lingering open thread",
    state: "merged",
    state_raw: "MERGED",
    state_reason: null,
    is_draft: false,
    author: "dev-a",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-10T00:00:00Z", // > 90 days before generatedAt
    closed_at: null,
    merged_at: "2025-01-10T00:00:00Z",
    review_state: null,
    ci_state: null,
    merge_state: null,
    open_review_threads: 1,
    total_review_threads: 1,
    milestone: null,
    demand: null,
    last_seen_at: "2026-06-15T00:00:00Z",
  };
}

function staleOpenThreadCanonical(): CanonicalItem {
  return {
    sourceId: "github:github.com",
    externalId: "PR_stale",
    kind: "change_request",
    projectPath: "dev-a/repo",
    iid: 400,
    url: "https://github.com/dev-a/repo/pull/400",
    title: "A long-merged PR with a lingering open thread",
    state: "merged",
    stateRaw: "MERGED",
    stateReason: null,
    isDraft: false,
    author: "dev-a",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-10T00:00:00Z",
    closedAt: null,
    mergedAt: "2025-01-10T00:00:00Z",
    reviewState: null,
    ciState: null,
    mergeState: null,
    openReviewThreads: 1,
    totalReviewThreads: 1,
    milestone: null,
    demand: null,
  };
}

function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(chunk?: string) {
      out.body += chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, out };
}

test("discovery finds an old open-thread PR that the default board window drops (itemWindow full)", () => {
  const generatedAt = "2026-06-16T00:00:00Z";
  const rows = [staleOpenThreadRow()];

  const windowed = buildContract({ sources: [GITHUB_SOURCE_ROW], items: rows, labels: [], edges: [], generatedAt });
  assert.equal(windowed.items.length, 0, "the default 90-day window drops the stale open-thread PR");
  assert.equal(buildReviewCandidates(windowed, opts()).length, 0, "so windowed discovery misses it — the bug");

  const full = buildContract({
    sources: [GITHUB_SOURCE_ROW],
    items: rows,
    labels: [],
    edges: [],
    generatedAt,
    itemWindow: "full",
  });
  const found = buildReviewCandidates(full, opts());
  assert.equal(found.length, 1, "the full projection keeps the item so discovery finds it");
  assert.equal(found[0]!.pr, 400);
  assert.deepEqual(found[0]!.reasons, ["open_review_threads"]);
});

test("GET /api/review-candidates serves full-store candidates and validates query params", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-candidates-api-test-"));
  const dbPath = join(dir, "board.db");
  const db = await openSqliteStore(dbPath);
  try {
    await db.ensureSource(
      { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: "GitHub" },
      "2026-06-01T00:00:00Z",
    );
    await db.upsertItem(staleOpenThreadCanonical(), "github/pr-stale", "2026-06-16T00:00:00Z");
  } finally {
    await db.close();
  }

  const cfg = {
    db_path: dbPath,
    timezone: "UTC",
    sources: [
      {
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        graphql_url: "https://api.github.com/graphql",
        projects: ["dev-a/repo"],
      },
    ],
  } as AppConfig;

  try {
    const { res, out } = fakeRes();
    await handleReviewCandidatesRequest(
      cfg,
      new URL("http://localhost/api/review-candidates?repo=dev-a/repo&pr=400"),
      res,
    );
    assert.equal(out.status, 200);
    const candidates = JSON.parse(out.body) as Array<{ pr: number; reasons: string[] }>;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.pr, 400);
    assert.deepEqual(candidates[0]!.reasons, ["open_review_threads"]);

    const bad = fakeRes();
    await handleReviewCandidatesRequest(cfg, new URL("http://localhost/api/review-candidates?limit=0"), bad.res);
    assert.equal(bad.out.status, 400);
    assert.equal((JSON.parse(bad.out.body) as { error: string }).error, "bad_request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
