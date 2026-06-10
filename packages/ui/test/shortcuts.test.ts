import { test } from "node:test";
import assert from "node:assert/strict";
import { isRefreshShortcut, isDebugShortcut } from "../src/shortcuts.ts";

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

test("debug shortcut accepts Cmd/Ctrl+/ (shift tolerated for layouts where / is shifted)", () => {
  assert.equal(isDebugShortcut({ key: "/", metaKey: true }), true);
  assert.equal(isDebugShortcut({ key: "/", ctrlKey: true }), true);
  assert.equal(isDebugShortcut({ key: "/", metaKey: true, shiftKey: true }), true);
});

test("debug shortcut ignores a bare slash, Alt variants, and other keys", () => {
  assert.equal(isDebugShortcut({ key: "/" }), false);
  assert.equal(isDebugShortcut({ key: "/", metaKey: true, altKey: true }), false);
  assert.equal(isDebugShortcut({ key: "?", metaKey: true }), false);
  assert.equal(isDebugShortcut({ key: "d", metaKey: true }), false);
});
