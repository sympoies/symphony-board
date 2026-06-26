import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAvailableToken, type AuthToken } from "../src/sources/http.ts";

// nextAvailableToken is the retry-time token picker. Its bot-first rule must key
// on the token being a GitHub App bot (kind), not on the round_robin strategy:
// a bot_then_pat pool may configure its apps with the failover strategy, and
// those are still bots that should be tried before spending PAT quota.

const bot = (env: string, strategy: AuthToken["strategy"]): AuthToken => ({
  env,
  value: env,
  kind: "github_app",
  strategy,
});
const pat = (env: string): AuthToken => ({ env, value: env, kind: "pat", strategy: "failover" });

test("retry prefers an available failover-strategy bot over the PAT", () => {
  // [botA(failover), botB(failover), PAT]; botB was selected and rate-limited.
  // The retry from idx 1 must rotate to the still-available botA (idx 0), not the
  // PAT (idx 2) that raw order would hit first.
  const tokens = [bot("botA", "failover"), bot("botB", "failover"), pat("PAT")];
  const blocked = new Map<number, number>([[1, Number.MAX_SAFE_INTEGER]]);
  const tried = new Set<number>([1]);
  assert.equal(nextAvailableToken(tokens, blocked, tried, 1), 0);
});

test("retry still prefers an available round_robin bot over the PAT", () => {
  const tokens = [bot("botA", "round_robin"), bot("botB", "round_robin"), pat("PAT")];
  const blocked = new Map<number, number>([[1, Number.MAX_SAFE_INTEGER]]);
  const tried = new Set<number>([1]);
  assert.equal(nextAvailableToken(tokens, blocked, tried, 1), 0);
});

test("retry falls back to the PAT only once every bot is tried or blocked", () => {
  const tokens = [bot("botA", "round_robin"), bot("botB", "round_robin"), pat("PAT")];
  const blocked = new Map<number, number>([
    [0, Number.MAX_SAFE_INTEGER],
    [1, Number.MAX_SAFE_INTEGER],
  ]);
  const tried = new Set<number>([0, 1]);
  assert.equal(nextAvailableToken(tokens, blocked, tried, 1), 2);
});
