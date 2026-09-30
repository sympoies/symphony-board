import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLifecycle, reconcileEdges, reporterSide } from "../src/model/edges.ts";
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

// A tracker reports `blocks` between two of its rows' issues: the reporting
// item is neither endpoint of that edge.
test("reporterSide names the endpoint that reported an edge, or neither", () => {
  const from = { sourceId: "gh", externalId: "I1" };
  const to = { sourceId: "gh", externalId: "I2" };
  const edge: CanonicalEdge = { type: "blocks", from, to, fromState: "open", toState: "open" };
  assert.equal(reporterSide(edge, from), "from");
  assert.equal(reporterSide(edge, to), "to");
  assert.equal(reporterSide(edge, { sourceId: "gh", externalId: "TRACKER" }), "neither");
  assert.equal(reporterSide(edge, { sourceId: "gl", externalId: "I2" }), "neither", "an endpoint is matched by its full ref");
});

test("reconcileEdges keeps an edge reported by a non-endpoint and does not count it as a side", () => {
  const from = { sourceId: "gh", externalId: "I1" };
  const to = { sourceId: "gh", externalId: "I2" };
  const blocks = (fromState: CanonicalEdge["fromState"], toState: CanonicalEdge["toState"]): CanonicalEdge => ({
    type: "blocks", from, to, fromState, toState,
  });

  const alone = reconcileEdges([
    { edge: blocks("closed", null), side: "neither" },
    { edge: blocks(null, "open"), side: "neither" },
  ]);
  assert.equal(alone.length, 1, "two trackers naming the same dependency give one edge");
  assert.equal(alone[0]!.discoveredFrom, "neither");
  assert.deepEqual([alone[0]!.fromState, alone[0]!.toState], ["closed", "open"], "endpoint states still converge");
  assert.equal(alone[0]!.lifecycle, null);

  const thenEndpoint = reconcileEdges([
    { edge: blocks("closed", "open"), side: "neither" },
    { edge: blocks("closed", "open"), side: "from" },
  ]);
  assert.equal(thenEndpoint[0]!.discoveredFrom, "from", "a non-endpoint report is not a second side");

  const endpointThen = reconcileEdges([
    { edge: blocks("closed", "open"), side: "to" },
    { edge: blocks("closed", "open"), side: "neither" },
  ]);
  assert.equal(endpointThen[0]!.discoveredFrom, "to");
});
