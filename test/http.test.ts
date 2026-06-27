import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthSelectionState,
  nextAvailableToken,
  recordAuthAttemptDone,
  resetAuthTokenSelectionStateForTests,
  selectAvailableToken,
  type AuthToken,
} from "../src/sources/http.ts";

// nextAvailableToken is the retry-time token picker. Its bot-first rule must key
// on the token being a GitHub App bot (kind), not on the selection strategy: a
// bot_then_pat pool may configure its apps with the failover strategy, and those
// are still bots that should be tried before spending PAT quota.

const bot = (env: string, strategy: AuthToken["strategy"]): AuthToken => ({
  env,
  value: env,
  kind: "github_app",
  strategy,
});
const pat = (env: string): AuthToken => ({ env, value: env, kind: "pat", strategy: "failover" });

test("budget observations stay monotonic within the same reset window", () => {
  resetAuthTokenSelectionStateForTests();
  const resetAtMs = Date.parse("2026-06-27T18:00:00Z");
  const now = Date.parse("2026-06-27T17:00:00Z");
  const tokens = [bot("botA", "budget_aware"), bot("botB", "budget_aware")];
  const selection = createAuthSelectionState(tokens, "github:graphql");

  recordAuthAttemptDone(tokens, 0, selection, { remaining: 100, used: 900, resetAtMs }, now);
  recordAuthAttemptDone(tokens, 1, selection, { remaining: 120, used: 880, resetAtMs }, now);
  recordAuthAttemptDone(tokens, 0, selection, { remaining: 150, used: 850, resetAtMs }, now);

  assert.equal(selectAvailableToken(tokens, new Map(), selection, now), 1);
});

test("renewed GitHub App token strings keep the observed installation budget", () => {
  resetAuthTokenSelectionStateForTests();
  const resetAtMs = Date.parse("2026-06-27T18:00:00Z");
  const now = Date.parse("2026-06-27T17:00:00Z");
  const oldToken = [{ ...bot("github_app:BOT_INSTALLATION_ID", "budget_aware"), value: "old-installation-token" }];
  const oldSelection = createAuthSelectionState(oldToken, "github:graphql");
  recordAuthAttemptDone(oldToken, 0, oldSelection, { remaining: 0, used: 1000, resetAtMs }, now);

  const renewedToken = [{ ...bot("github_app:BOT_INSTALLATION_ID", "budget_aware"), value: "renewed-installation-token" }];
  const renewedSelection = createAuthSelectionState(renewedToken, "github:graphql");
  assert.equal(selectAvailableToken(renewedToken, new Map(), renewedSelection, now), null);
  assert.equal(selectAvailableToken(renewedToken, new Map(), renewedSelection, resetAtMs + 1), 0);
});

test("retry prefers an available failover-strategy bot over the PAT", () => {
  // [botA(failover), botB(failover), PAT]; botB was selected and rate-limited.
  // The retry from idx 1 must rotate to the still-available botA (idx 0), not the
  // PAT (idx 2) that raw order would hit first.
  const tokens = [bot("botA", "failover"), bot("botB", "failover"), pat("PAT")];
  const blocked = new Map<number, number>([[1, Number.MAX_SAFE_INTEGER]]);
  const tried = new Set<number>([1]);
  assert.equal(nextAvailableToken(tokens, blocked, tried, 1), 0);
});

test("retry still prefers an available budget-aware bot over the PAT", () => {
  const tokens = [bot("botA", "budget_aware"), bot("botB", "budget_aware"), pat("PAT")];
  const blocked = new Map<number, number>([[1, Number.MAX_SAFE_INTEGER]]);
  const tried = new Set<number>([1]);
  assert.equal(nextAvailableToken(tokens, blocked, tried, 1), 0);
});

test("retry falls back to the PAT only once every bot is tried or blocked", () => {
  const tokens = [bot("botA", "budget_aware"), bot("botB", "budget_aware"), pat("PAT")];
  const blocked = new Map<number, number>([
    [0, Number.MAX_SAFE_INTEGER],
    [1, Number.MAX_SAFE_INTEGER],
  ]);
  const tried = new Set<number>([0, 1]);
  assert.equal(nextAvailableToken(tokens, blocked, tried, 1), 2);
});
