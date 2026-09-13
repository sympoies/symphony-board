import assert from "node:assert/strict";
import test from "node:test";
import { formatAxisValue, niceAxisMax, rankBarHeight } from "../src/rank-scale.ts";

test("niceAxisMax rounds up to a 1 / 2 / 5 step so axis ticks stay readable", () => {
  assert.equal(niceAxisMax(1), 1);
  assert.equal(niceAxisMax(7), 10);
  assert.equal(niceAxisMax(12), 20);
  assert.equal(niceAxisMax(37), 50);
  assert.equal(niceAxisMax(412), 500);
  assert.equal(niceAxisMax(981), 1000);
  // An exact step is already nice and must not jump to the next one, or every
  // chart whose leader is a round number would draw with half its plot empty.
  assert.equal(niceAxisMax(500), 500);
  assert.equal(niceAxisMax(1000), 1000);
});

test("niceAxisMax never returns a zero or negative ceiling", () => {
  // The caller divides by this, so a 0 would produce Infinity bar heights. An
  // all-zero rank set is reachable: a range with rows but no counted events.
  assert.equal(niceAxisMax(0), 1);
  assert.equal(niceAxisMax(-5), 1);
});

test("formatAxisValue abbreviates so a tick fits a narrow rail column", () => {
  assert.equal(formatAxisValue(0), "0");
  assert.equal(formatAxisValue(500), "500");
  assert.equal(formatAxisValue(1000), "1k");
  assert.equal(formatAxisValue(16_526), "16.5k");
  assert.equal(formatAxisValue(1_000_000), "1m");
  assert.equal(formatAxisValue(2_450_000), "2.5m");
});

test("rankBarHeight keeps a non-zero count visible against a large leader", () => {
  assert.equal(rankBarHeight(1000, 1000), "100%");
  assert.equal(rankBarHeight(500, 1000), "50%");
  // 1 against 1000 rounds to 0%, which would render an invisible — and so
  // unclickable — row. The floor is what keeps a long tail reachable.
  assert.equal(rankBarHeight(1, 1000), "3%");
  assert.equal(rankBarHeight(0, 1000), "3%");
});

test("rankBarHeight tolerates a zero axis instead of dividing by it", () => {
  assert.equal(rankBarHeight(0, 0), "3%");
  assert.equal(rankBarHeight(5, 0), "3%");
});
