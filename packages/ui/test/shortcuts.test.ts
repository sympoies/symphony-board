import { test } from "node:test";
import assert from "node:assert/strict";
import { isRefreshShortcut } from "../src/shortcuts.ts";

test("refresh shortcuts accept Cmd/Ctrl+R and plain F5", () => {
  assert.equal(isRefreshShortcut({ key: "r", metaKey: true }), true);
  assert.equal(isRefreshShortcut({ key: "R", ctrlKey: true }), true);
  assert.equal(isRefreshShortcut({ key: "F5" }), true);
});

test("refresh shortcuts ignore modified variants and unrelated keys", () => {
  assert.equal(isRefreshShortcut({ key: "r" }), false);
  assert.equal(isRefreshShortcut({ key: "r", metaKey: true, shiftKey: true }), false);
  assert.equal(isRefreshShortcut({ key: "F5", altKey: true }), false);
  assert.equal(isRefreshShortcut({ key: "s", metaKey: true }), false);
});
