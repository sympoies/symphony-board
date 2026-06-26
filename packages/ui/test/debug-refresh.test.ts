import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshDebugTab, type DebugRefreshActions } from "../src/debug-refresh.ts";
import type { DebugTab } from "../src/nav.ts";

function makeActions(contractLoaded = true): { calls: string[]; actions: DebugRefreshActions } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      refreshContract: async () => {
        calls.push("contract");
        return contractLoaded;
      },
      refreshStore: () => calls.push("store"),
      refreshLive: () => calls.push("live"),
      refreshTokenRates: () => calls.push("ratelimit"),
      refreshLogs: () => calls.push("log"),
    },
  };
}

test("Diagnostics Refresh dispatches only the active non-contract tab", async () => {
  const cases: Array<[DebugTab, string[]]> = [
    ["store", ["store"]],
    ["sync", ["store"]],
    ["live", ["live"]],
    ["ratelimit", ["ratelimit"]],
    ["log", ["log"]],
  ];

  for (const [tab, expected] of cases) {
    const { calls, actions } = makeActions();
    await refreshDebugTab(tab, actions);
    assert.deepEqual(calls, expected, `${tab} should refresh only its active data source`);
  }
});

test("Diagnostics contract Refresh falls back to store stats only when no contract loaded", async () => {
  const loaded = makeActions(true);
  await refreshDebugTab("contract", loaded.actions);
  assert.deepEqual(loaded.calls, ["contract"]);

  const unavailable = makeActions(false);
  await refreshDebugTab("contract", unavailable.actions);
  assert.deepEqual(unavailable.calls, ["contract", "store"]);
});
