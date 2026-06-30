import { test } from "node:test";
import assert from "node:assert/strict";
import { onlineReducer } from "../src/online-status.ts";

// The hook itself reads navigator.onLine and attaches window listeners, so it is
// NOT imported here — these tests run under bare `node --test` with no DOM, and
// touching navigator/window at import time would throw. Only the pure reducer is
// unit-tested; the React effect + SSR-safe initializer are covered by typecheck +
// ui build + render-smoke.
test("onlineReducer: an 'online' event sets the state true (rising edge)", () => {
  assert.equal(onlineReducer(false, "online"), true);
});

test("onlineReducer: an 'offline' event sets the state false (falling edge)", () => {
  assert.equal(onlineReducer(true, "offline"), false);
});

test("onlineReducer: the event is the new value, independent of prior state", () => {
  // Idempotent: re-applying the same event keeps the value, so a duplicate
  // browser event never flips the state spuriously.
  assert.equal(onlineReducer(true, "online"), true);
  assert.equal(onlineReducer(false, "offline"), false);
});
