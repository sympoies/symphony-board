import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@symphony-board/contract";
import { itemMetricEntries } from "../src/item-metrics.ts";
import type { RelationCount } from "../src/model.ts";

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
