import { test } from "node:test";
import assert from "node:assert/strict";
import type { EdgeDTO, ItemDTO } from "@symphony-board/contract";
import { programChildName, programRollup, programRollups, type ProgramRollup } from "../src/program.ts";

const SRC = "github:github.com";
const ref = (externalId: string): string => `${SRC}|${externalId}`;

function item(externalId: string, over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: ref(externalId), source_id: SRC, external_id: externalId, kind: "issue",
    project_path: "o/r", iid: 1, url: `https://x/${externalId}`, title: externalId, state: "open", state_raw: "OPEN",
    state_reason: null, is_draft: null, author: "a", created_at: null, updated_at: null, closed_at: null,
    merged_at: null, labels: [], review_state: null, ci_state: null, merge_state: null, review_threads: null,
    milestone: null, demand: 0, last_seen_at: null, ...over,
  };
}

const edge = (type: string, from: string, to: string, from_state: string | null = null, to_state: string | null = null): EdgeDTO => ({
  type, from: ref(from), to: ref(to), from_state, to_state, lifecycle: null,
});
const parent = (to: string, to_state: string | null = null, tracker = "T") => edge("parent", tracker, to, "open", to_state);

const index = (items: ItemDTO[]): Map<string, ItemDTO> => new Map(items.map((it) => [it.id, it]));

// child external id -> status, in rollup order.
const statuses = (rollup: ProgramRollup | null): Array<[string, string]> =>
  (rollup?.children ?? []).map((child) => [child.id.slice(SRC.length + 1), child.status]);

test("a tracker without children has no rollup", () => {
  const items = index([item("T"), item("A")]);
  const edges = [edge("mentions", "T", "A"), edge("closes", "PR", "T", "open", "open")];
  assert.equal(programRollup(ref("T"), items, edges), null, "no parent edge -> null, never 0/0");
  assert.equal(programRollups(items, edges).size, 0);
  assert.equal(programRollup(ref("T"), items, []), null);
});

test("children are the parent-edge targets and each gets one status", () => {
  const items = index([
    item("T"),
    item("CLOSED", { iid: 1, state: "closed" }),
    item("MERGED", { iid: 2, kind: "change_request", state: "merged" }),
    item("WAITING", { iid: 3 }),
    item("REVIEW", { iid: 4 }),
    item("FREE", { iid: 5 }),
    item("PR_OPEN", { kind: "change_request" }),
    item("PR_MERGED", { kind: "change_request", state: "merged" }),
  ]);
  const edges = [
    parent("CLOSED"), parent("MERGED"), parent("WAITING"), parent("REVIEW"), parent("FREE"),
    edge("blocks", "REVIEW", "WAITING"),
    edge("closes", "PR_OPEN", "REVIEW"),
    edge("closes", "PR_MERGED", "FREE"),
    edge("mentions", "PR_OPEN", "FREE"),
  ];
  const rollup = programRollup(ref("T"), items, edges);
  assert.deepEqual(statuses(rollup), [
    ["CLOSED", "done"],
    ["MERGED", "done"],
    ["WAITING", "blocked"],
    ["REVIEW", "in_review"],
    ["FREE", "ready"],
  ]);
  assert.equal(rollup?.total, 5);
  assert.equal(rollup?.done, 2);
  assert.equal(rollup?.blocked, 1);
  assert.deepEqual(rollup?.inReview.map((child) => child.id), [ref("REVIEW")]);
  assert.deepEqual(rollup?.ready.map((child) => child.id), [ref("FREE")], "a merged closer or a mention does not put a child in review");
  assert.equal(rollup?.ready[0]?.item?.title, "FREE", "a loaded child carries its item row");
});

test("status precedence: done over blocked, blocked over in review", () => {
  const items = index([
    item("T"),
    item("BLOCKER", { iid: 1 }),
    item("DONE_BUT_BLOCKED", { iid: 2, state: "closed" }),
    item("BLOCKED_IN_REVIEW", { iid: 3 }),
    item("PR_OPEN", { kind: "change_request" }),
  ]);
  const edges = [
    parent("BLOCKER"), parent("DONE_BUT_BLOCKED"), parent("BLOCKED_IN_REVIEW"),
    edge("blocks", "BLOCKER", "DONE_BUT_BLOCKED"),
    edge("blocks", "BLOCKER", "BLOCKED_IN_REVIEW"),
    edge("closes", "PR_OPEN", "BLOCKED_IN_REVIEW"),
  ];
  assert.deepEqual(statuses(programRollup(ref("T"), items, edges)), [
    ["BLOCKER", "ready"],
    ["DONE_BUT_BLOCKED", "done"],
    ["BLOCKED_IN_REVIEW", "blocked"],
  ]);
});

test("a child absent from items takes its state from the parent edge; unknown counts as open", () => {
  const items = index([item("T")]);
  const edges = [parent("GONE_CLOSED", "closed"), parent("GONE_MERGED", "merged"), parent("GONE_OPEN", "open"), parent("GONE_UNKNOWN", null)];
  const rollup = programRollup(ref("T"), items, edges);
  assert.deepEqual(statuses(rollup), [
    ["GONE_CLOSED", "done"],
    ["GONE_MERGED", "done"],
    ["GONE_OPEN", "ready"],
    ["GONE_UNKNOWN", "ready"],
  ]);
  assert.deepEqual(rollup?.children.map((child) => [child.item, child.state]), [[null, "closed"], [null, "merged"], [null, "open"], [null, null]]);
});

test("a loaded item row is fresher than the edge state, for the child and for its blocker", () => {
  const items = index([
    item("T"),
    item("CLOSED_SINCE", { iid: 1, state: "closed" }),
    item("REOPENED", { iid: 2 }),
    item("WAITS_ON_CLOSED", { iid: 3 }),
    item("WAITS_ON_REOPENED", { iid: 4 }),
  ]);
  const edges = [
    parent("CLOSED_SINCE", "open"), parent("REOPENED", "closed"), parent("WAITS_ON_CLOSED", "open"), parent("WAITS_ON_REOPENED", "open"),
    edge("blocks", "CLOSED_SINCE", "WAITS_ON_CLOSED", "open", "open"),
    edge("blocks", "REOPENED", "WAITS_ON_REOPENED", "closed", "open"),
  ];
  assert.deepEqual(statuses(programRollup(ref("T"), items, edges)), [
    ["CLOSED_SINCE", "done"],
    ["REOPENED", "ready"],
    ["WAITS_ON_CLOSED", "ready"],
    ["WAITS_ON_REOPENED", "blocked"],
  ]);
});

test("a blocker or a closer absent from items is judged by the edge's from_state", () => {
  const items = index([
    item("T"),
    item("AFTER_OPEN", { iid: 1 }),
    item("AFTER_CLOSED", { iid: 2 }),
    item("AFTER_UNKNOWN", { iid: 3 }),
    item("CLOSER_OPEN", { iid: 4 }),
    item("CLOSER_MERGED", { iid: 5 }),
    item("CLOSER_UNKNOWN", { iid: 6 }),
  ]);
  const edges = [
    parent("AFTER_OPEN"), parent("AFTER_CLOSED"), parent("AFTER_UNKNOWN"), parent("CLOSER_OPEN"), parent("CLOSER_MERGED"), parent("CLOSER_UNKNOWN"),
    edge("blocks", "X_OPEN", "AFTER_OPEN", "open"),
    edge("blocks", "X_CLOSED", "AFTER_CLOSED", "closed"),
    edge("blocks", "X_UNKNOWN", "AFTER_UNKNOWN", null),
    edge("closes", "PR_X_OPEN", "CLOSER_OPEN", "open"),
    edge("closes", "PR_X_MERGED", "CLOSER_MERGED", "merged"),
    edge("closes", "PR_X_UNKNOWN", "CLOSER_UNKNOWN", null),
  ];
  assert.deepEqual(statuses(programRollup(ref("T"), items, edges)), [
    ["AFTER_OPEN", "blocked"],
    ["AFTER_CLOSED", "ready"],
    ["AFTER_UNKNOWN", "blocked"],
    ["CLOSER_OPEN", "in_review"],
    ["CLOSER_MERGED", "ready"],
    ["CLOSER_UNKNOWN", "in_review"],
  ]);
});

test("a blocks chain releases one link at a time", () => {
  const chain = [parent("A"), parent("B"), parent("C"), edge("blocks", "A", "B"), edge("blocks", "B", "C")];
  const open = index([item("T"), item("A", { iid: 1 }), item("B", { iid: 2 }), item("C", { iid: 3 })]);
  assert.deepEqual(statuses(programRollup(ref("T"), open, chain)), [["A", "ready"], ["B", "blocked"], ["C", "blocked"]]);
  const firstDone = index([item("T"), item("A", { iid: 1, state: "closed" }), item("B", { iid: 2 }), item("C", { iid: 3 })]);
  assert.deepEqual(statuses(programRollup(ref("T"), firstDone, chain)), [["A", "done"], ["B", "ready"], ["C", "blocked"]]);
});

test("a gate-contracted dependency is one blocks edge per prerequisite: blocked until all are done", () => {
  // Table: A, B, gate G after A and B, D after G. The producer contracts G away.
  const edges = [parent("A"), parent("B"), parent("D"), edge("blocks", "A", "D"), edge("blocks", "B", "D")];
  const half = index([item("T"), item("A", { iid: 1, state: "closed" }), item("B", { iid: 2 }), item("D", { iid: 3 })]);
  assert.deepEqual(statuses(programRollup(ref("T"), half, edges)), [["A", "done"], ["B", "ready"], ["D", "blocked"]]);
  const all = index([item("T"), item("A", { iid: 1, state: "closed" }), item("B", { iid: 2, state: "closed" }), item("D", { iid: 3 })]);
  assert.deepEqual(statuses(programRollup(ref("T"), all, edges)), [["A", "done"], ["B", "done"], ["D", "ready"]]);
});

test("duplicate edges count a child and a blocker once", () => {
  const items = index([item("T"), item("A", { iid: 1 }), item("B", { iid: 2 })]);
  const edges = [parent("A"), parent("A", "closed"), parent("B"), parent("B"), edge("blocks", "A", "B"), edge("blocks", "A", "B")];
  const rollup = programRollup(ref("T"), items, edges);
  assert.deepEqual(statuses(rollup), [["A", "ready"], ["B", "blocked"]]);
  assert.equal(rollup?.total, 2);
  assert.equal(rollup?.blocked, 1);
});

test("a tracker is never its own child, and a child that is a tracker is judged by its own state", () => {
  const items = index([item("T"), item("SUB", { iid: 1 }), item("LEAF", { iid: 2, state: "closed" }), item("SUB_LEAF", { iid: 3, state: "closed" })]);
  const edges = [parent("T"), parent("SUB"), parent("LEAF"), parent("SUB_LEAF", null, "SUB")];
  const rollups = programRollups(items, edges);
  assert.deepEqual(statuses(rollups.get(ref("T")) ?? null), [["SUB", "ready"], ["LEAF", "done"]], "the self edge is dropped; SUB is open although its own program is complete");
  assert.deepEqual(statuses(rollups.get(ref("SUB")) ?? null), [["SUB_LEAF", "done"]]);
  assert.deepEqual([...rollups.keys()].sort(), [ref("SUB"), ref("T")]);
  assert.equal(programRollup(ref("ONLY_SELF"), items, [parent("ONLY_SELF", null, "ONLY_SELF")]), null, "only a self edge -> no children");
});

test("a blocks edge from outside the tracker's children still blocks, and other trackers' children stay out", () => {
  const items = index([item("T"), item("OTHER"), item("MINE", { iid: 1 }), item("THEIRS", { iid: 2 })]);
  const edges = [parent("MINE"), parent("THEIRS", null, "OTHER"), edge("blocks", "THEIRS", "MINE")];
  assert.deepEqual(statuses(programRollup(ref("T"), items, edges)), [["MINE", "blocked"]]);
  assert.deepEqual(statuses(programRollup(ref("OTHER"), items, edges)), [["THEIRS", "ready"]]);
});

test("children are ordered by iid, then title, then ref; children without a row come last", () => {
  const items = index([
    item("T"),
    item("N9", { iid: 9, title: "nine" }),
    item("N2B", { iid: 2, title: "beta" }),
    item("N2A", { iid: 2, title: "alpha" }),
    item("NONE", { iid: null, title: "no number" }),
  ]);
  const edges = [parent("ZZ_GONE"), parent("N9"), parent("NONE"), parent("N2B"), parent("AA_GONE"), parent("N2A")];
  const rollup = programRollup(ref("T"), items, edges);
  const order = ["N2A", "N2B", "N9", "NONE", "AA_GONE", "ZZ_GONE"];
  assert.deepEqual(statuses(rollup).map(([id]) => id), order);
  assert.deepEqual(rollup?.ready.map((child) => child.id), order.map(ref), "ready keeps the same order");
});

test("programChildName: title, then repo#iid, then the ref tail", () => {
  const items = index([item("T"), item("TITLED", { iid: 1, title: "Named child" }), item("UNTITLED", { iid: 7, title: null, project_path: "o/r" })]);
  const rollup = programRollup(ref("T"), items, [parent("TITLED"), parent("UNTITLED"), parent("ISSUE_GONE")]);
  assert.deepEqual(rollup?.children.map(programChildName), ["Named child", "o/r#7", "ISSUE_GONE"]);
});
