import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@symphony-board/contract";
import { itemMetricEntries, programCardSummary } from "../src/item-metrics.ts";
import type { RelationCount } from "../src/model.ts";
import type { ProgramChild, ProgramRollup } from "../src/program.ts";

function item(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "github:github.com|PR",
    source_id: "github:github.com",
    external_id: "PR",
    kind: "change_request",
    project_path: "o/r",
    iid: 1,
    url: "https://x",
    title: "PR",
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: false,
    author: "a",
    created_at: null,
    updated_at: null,
    closed_at: null,
    merged_at: null,
    labels: [],
    review_state: null,
    ci_state: null,
    merge_state: null,
    review_threads: null,
    comments: null,
    milestone: null,
    demand: 0,
    last_seen_at: null,
    ...over,
  };
}

const related: RelationCount = { total: 3, byType: [{ type: "relates", count: 3 }] };

test("itemMetricEntries uses provider comment total instead of demand", () => {
  const entries = itemMetricEntries(item({ comments: { total: 24 }, demand: 99 }), null);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.value]), [["comments", 24]]);
  assert.equal(entries[0]?.title, "comments");
});

test("itemMetricEntries keeps the fixed comments, thread, link order and hides zeroes", () => {
  const entries = itemMetricEntries(
    item({
      comments: { total: 0 },
      review_threads: { open: 2, total: 5 },
      demand: 11,
    }),
    related,
  );
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.value]), [
    ["threads", 2],
    ["related", 3],
  ]);
  assert.equal(entries[0]?.title, "2 open threads");
});

function child(name: string, status: ProgramChild["status"], tracked = true): ProgramChild {
  const id = `github:github.com|${name}`;
  return {
    id,
    item: tracked ? item({ id, external_id: name, kind: "issue", title: `Title ${name}`, url: `https://x/${name}` }) : null,
    state: status === "done" ? "closed" : "open",
    status,
  };
}

function rollup(children: ProgramChild[]): ProgramRollup {
  return {
    total: children.length,
    done: children.filter((c) => c.status === "done").length,
    ready: children.filter((c) => c.status === "ready"),
    inReview: children.filter((c) => c.status === "in_review"),
    blocked: children.filter((c) => c.status === "blocked").length,
    children,
  };
}

test("programCardSummary reports done/total, in-review and blocked counts", () => {
  const summary = programCardSummary(
    rollup([child("A", "done"), child("B", "ready"), child("C", "in_review"), child("D", "in_review"), child("E", "blocked")]),
  );
  assert.equal(summary.progress, "1/5");
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.ready, [{ id: "github:github.com|B", name: "Title B", url: "https://x/B" }]);
  assert.equal(summary.readyMore, 0);
  assert.equal(summary.inReview, 2);
  assert.equal(summary.blocked, 1);
});

test("programCardSummary names at most three ready children, then counts the rest", () => {
  const summary = programCardSummary(
    rollup([child("A", "ready"), child("B", "ready"), child("GONE", "ready", false), child("D", "ready"), child("E", "ready")]),
  );
  assert.deepEqual(summary.ready, [
    { id: "github:github.com|A", name: "Title A", url: "https://x/A" },
    { id: "github:github.com|B", name: "Title B", url: "https://x/B" },
    { id: "github:github.com|GONE", name: "GONE", url: null },
  ], "a child without an item row is named by its ref tail and has no link");
  assert.equal(summary.readyMore, 2);
  assert.equal(summary.progress, "0/5");
});

test("programCardSummary marks a finished program complete", () => {
  const summary = programCardSummary(rollup([child("A", "done"), child("B", "done")]));
  assert.equal(summary.progress, "2/2");
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.ready, []);
  assert.equal(summary.inReview + summary.blocked + summary.readyMore, 0);
});
