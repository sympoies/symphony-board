import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLifecycle, reconcileEdges } from "../src/model/edges.ts";
import type { CanonicalEdge } from "../src/model/types.ts";

test("deriveLifecycle: merged PR + closed issue => fulfilled", () => {
  assert.equal(deriveLifecycle("closes", "merged", "closed"), "fulfilled");
});

test("deriveLifecycle: PR closed unmerged => broken", () => {
  assert.equal(deriveLifecycle("closes", "closed", "open"), "broken");
  assert.equal(deriveLifecycle("closes", "closed", "closed"), "broken");
});

test("deriveLifecycle: in-flight => declared", () => {
  assert.equal(deriveLifecycle("closes", "open", "open"), "declared");
  assert.equal(deriveLifecycle("closes", "merged", "open"), "declared");
});

test("deriveLifecycle: non-closes edges have no lifecycle", () => {
  assert.equal(deriveLifecycle("relates", "open", "open"), null);
  assert.equal(deriveLifecycle("blocks", "closed", "closed"), null);
});

test("reconcileEdges converges endpoint states reported from both sides", () => {
  const from = { sourceId: "gh", externalId: "PR1" };
  const to = { sourceId: "gh", externalId: "I1" };
  const fromSide: CanonicalEdge = { type: "closes", from, to, fromState: "merged", toState: null };
  const toSide: CanonicalEdge = { type: "closes", from, to, fromState: null, toState: "closed" };

  const out = reconcileEdges([
    { edge: fromSide, side: "from" },
    { edge: toSide, side: "to" },
  ]);

  assert.equal(out.length, 1);
  const e = out[0]!;
  assert.equal(e.fromState, "merged");
  assert.equal(e.toState, "closed");
  assert.equal(e.lifecycle, "fulfilled");
  assert.equal(e.discoveredFrom, "both");
});

test("reconcileEdges keeps distinct (type, from, to) edges separate", () => {
  const a = { sourceId: "gh", externalId: "PR1" };
  const b = { sourceId: "gh", externalId: "I1" };
  const c = { sourceId: "gh", externalId: "I2" };
  const out = reconcileEdges([
    { edge: { type: "closes", from: a, to: b, fromState: "open", toState: "open" }, side: "from" },
    { edge: { type: "closes", from: a, to: c, fromState: "open", toState: "open" }, side: "from" },
  ]);
  assert.equal(out.length, 2);
});
