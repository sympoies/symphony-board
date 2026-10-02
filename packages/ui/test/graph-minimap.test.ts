import { test } from "node:test";
import assert from "node:assert/strict";
import { minimapSize } from "../src/graph-minimap.ts";

test("minimapSize keeps the compact size on compact layouts at any pane width", () => {
  assert.deepEqual(minimapSize(336, true), { width: 112, height: 84 });
  assert.deepEqual(minimapSize(3000, true), { width: 112, height: 84 });
});

test("minimapSize is about 15% of the pane at 4:3, clamped to 200x150..360x270", () => {
  // Below the floor: React Flow's default size.
  assert.deepEqual(minimapSize(0, false), { width: 200, height: 150 });
  assert.deepEqual(minimapSize(818, false), { width: 200, height: 150 });
  assert.deepEqual(minimapSize(1333, false), { width: 200, height: 150 });
  // In the scaling range.
  assert.deepEqual(minimapSize(2000, false), { width: 300, height: 225 });
  assert.deepEqual(minimapSize(2058, false), { width: 309, height: 232 });
  // Above the ceiling.
  assert.deepEqual(minimapSize(2400, false), { width: 360, height: 270 });
  assert.deepEqual(minimapSize(3338, false), { width: 360, height: 270 });
});

test("minimapSize tolerates a non-finite pane width", () => {
  assert.deepEqual(minimapSize(Number.NaN, false), { width: 200, height: 150 });
});
