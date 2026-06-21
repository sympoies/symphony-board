import { test } from "node:test";
import assert from "node:assert/strict";
import { multiSelectDisabled } from "../src/components/multiSelectState.ts";

test("MultiSelect stays enabled when a stale active selection has no available options", () => {
  assert.equal(multiSelectDisabled(0, 1), false);
  assert.equal(multiSelectDisabled(0, 2), false);
  assert.equal(multiSelectDisabled(0, 0), true);
});

test("MultiSelect stays enabled when options are available", () => {
  assert.equal(multiSelectDisabled(1, 0), false);
  assert.equal(multiSelectDisabled(2, 1), false);
});
