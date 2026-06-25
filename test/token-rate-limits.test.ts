// GET /api/token-rate-limits probe (src/server/token-rate-limits.ts): one entry
// per distinct configured GitHub token, non-GitHub sources skipped, a failing
// probe degraded to an ok:false row, and — the load-bearing guarantee — the
// resolved token VALUES never appear on the result. The probe client is injected
// so these never touch the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.ts";
import { createAuthTokenResolver } from "../src/auth.ts";
import { probeTokenRateLimits, type ProbeClientFactory } from "../src/server/token-rate-limits.ts";

const TOKEN_ENVS = {
  GH_MAIN: "ghp-main-SECRET",
  GH_FALLBACK: "ghp-fallback-SECRET",
  GH_TEAMX: "ghp-teamx-SECRET",
  GL_TOKEN: "glpat-SECRET",
} as const;

function withTokenEnv(fn: () => Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(TOKEN_ENVS)) {
    prior.set(k, process.env[k]);
    process.env[k] = v;
  }
  // GH_UNSET is intentionally never set — a configured-but-unresolved token.
  delete process.env.GH_UNSET;
  return fn().finally(() => {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function cfg(): AppConfig {
  return {
    db_path: "x.db",
    sources: [
      {
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        display_name: "GitHub",
        token_env: "GH_MAIN",
        fallback_token_envs: ["GH_FALLBACK"],
        token_pools: {
          teamx: { token_env: "GH_TEAMX" },
          empty: { token_env: "GH_UNSET" }, // never set in env -> skipped
        },
        graphql_url: "https://api.github.com/graphql",
        projects: ["o/r"],
      },
      {
        source_id: "gitlab:gitlab.com",
        kind: "gitlab",
        host: "gitlab.com",
        token_env: "GL_TOKEN",
        graphql_url: "https://gitlab.com/api/graphql",
        projects: ["g/p"],
      },
    ],
  };
}

const okRateLimit = { limit: 5000, cost: 1, remaining: 4990, used: 10, resetAt: "2026-06-22T12:00:00Z" };

// A factory that returns canned budget for every token except GH_FALLBACK, which
// throws — and records which token VALUES it was handed, to prove the probe DID
// authenticate with them (so a leak assertion is meaningful).
function fakeFactory(seenValues: string[]): ProbeClientFactory {
  return (_url, token) => {
    seenValues.push(token.value);
    return async () => {
      if (token.env === "GH_FALLBACK") throw new Error("GraphQL HTTP 401: bad credentials");
      return { rateLimit: okRateLimit } as any;
    };
  };
}

test("probeTokenRateLimits returns one row per distinct GitHub token, skips non-GitHub + unresolved", async () => {
  await withTokenEnv(async () => {
    const seen: string[] = [];
    const result = await probeTokenRateLimits(cfg(), { clientFactory: fakeFactory(seen), now: () => "2026-06-22T11:00:00Z" });

    assert.equal(result.generated_at, "2026-06-22T11:00:00Z");
    const envs = result.tokens.map((t) => t.env).sort();
    assert.deepEqual(envs, ["GH_FALLBACK", "GH_MAIN", "GH_TEAMX"], "every resolved GitHub token, no GitLab, no unset GH_UNSET");
    assert.ok(result.tokens.every((t) => t.source_id === "github:github.com" && t.source_display === "GitHub"));

    // The factory was handed the real token values to authenticate with...
    assert.deepEqual(seen.sort(), ["ghp-fallback-SECRET", "ghp-main-SECRET", "ghp-teamx-SECRET"]);
  });
});

test("probeTokenRateLimits carries the budget on success and degrades a failed probe to ok:false", async () => {
  await withTokenEnv(async () => {
    const result = await probeTokenRateLimits(cfg(), { clientFactory: fakeFactory([]), now: () => "t" });
    const byEnv = new Map(result.tokens.map((t) => [t.env, t]));

    const main = byEnv.get("GH_MAIN")!;
    assert.equal(main.ok, true);
    assert.equal(main.limit, 5000);
    assert.equal(main.remaining, 4990);
    assert.equal(main.used, 10);
    assert.equal(main.reset_at, "2026-06-22T12:00:00Z");

    const bad = byEnv.get("GH_FALLBACK")!;
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /401/);
    assert.equal(bad.limit, undefined, "a failed probe carries no budget fields");
  });
});

test("probeTokenRateLimits never leaks a token value onto the result", async () => {
  await withTokenEnv(async () => {
    const result = await probeTokenRateLimits(cfg(), { clientFactory: fakeFactory([]), now: () => "t" });
    const serialized = JSON.stringify(result);
    for (const value of Object.values(TOKEN_ENVS)) {
      assert.equal(serialized.includes(value), false, `token value ${value} must not appear on the response`);
    }
    // env NAMES are expected on the response; values are not.
    assert.ok(serialized.includes("GH_MAIN"));
  });
});

test("probeTokenRateLimits can probe a GitHub App installation token by synthetic label", async () => {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries({
    GH_APP_ID: "12345",
    GH_APP_INSTALLATION_ID: "67890",
    GH_APP_KEY_B64: Buffer.from("PRIVATE KEY").toString("base64"),
  })) {
    prior.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const appCfg: AppConfig = {
      db_path: "x.db",
      sources: [{
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        github_app: {
          app_id_env: "GH_APP_ID",
          installation_id_env: "GH_APP_INSTALLATION_ID",
          private_key_base64_env: "GH_APP_KEY_B64",
        },
        graphql_url: "https://api.github.com/graphql",
        projects: ["o/r"],
      }],
    };
    const authTokenResolver = createAuthTokenResolver({
      mintGitHubAppInstallationToken: async (request) => ({ env: request.label, value: "ghs-app-SECRET" }),
    });
    const seen: string[] = [];
    const result = await probeTokenRateLimits(appCfg, {
      authTokenResolver,
      clientFactory: fakeFactory(seen),
      now: () => "t",
    });

    assert.deepEqual(result.tokens.map((t) => t.env), ["github_app:GH_APP_INSTALLATION_ID"]);
    assert.deepEqual(seen, ["ghs-app-SECRET"]);
    assert.equal(JSON.stringify(result).includes("ghs-app-SECRET"), false);
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("probeTokenRateLimits reports every configured round-robin bot with metadata and usage", async () => {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries({
    BOT_A_APP_ID: "111",
    BOT_A_INSTALLATION_ID: "1001",
    BOT_A_PRIVATE_KEY_B64: Buffer.from("PRIVATE KEY A").toString("base64"),
    BOT_B_APP_ID: "222",
    BOT_B_INSTALLATION_ID: "1002",
    BOT_B_PRIVATE_KEY_B64: Buffer.from("PRIVATE KEY B").toString("base64"),
  })) {
    prior.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const appCfg: AppConfig = {
      db_path: "x.db",
      sources: [{
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        display_name: "GitHub",
        auth_pools: {
          example_bots: {
            kind: "github_app",
            strategy: "round_robin",
            apps: [
              {
                name: "example-bot-a",
                app_id_env: "BOT_A_APP_ID",
                installation_id_env: "BOT_A_INSTALLATION_ID",
                private_key_base64_env: "BOT_A_PRIVATE_KEY_B64",
              },
              {
                name: "example-bot-b",
                app_id_env: "BOT_B_APP_ID",
                installation_id_env: "BOT_B_INSTALLATION_ID",
                private_key_base64_env: "BOT_B_PRIVATE_KEY_B64",
              },
            ],
          },
        },
        auth_policy: { mode: "bot", bot_pool: "example_bots" },
        graphql_url: "https://api.github.com/graphql",
        projects: ["o/r"],
      } as any],
    };
    const authTokenResolver = createAuthTokenResolver({
      mintGitHubAppInstallationToken: async (request) => ({ env: request.label, value: `ghs-${request.installationId}-SECRET` }),
    });
    const seen: Array<Record<string, unknown>> = [];
    const result = await probeTokenRateLimits(appCfg, {
      authTokenResolver,
      clientFactory: (_url, token) => {
        seen.push({
          env: token.env,
          kind: (token as any).kind,
          name: (token as any).name,
          strategy: (token as any).strategy,
          value: token.value,
        });
        return async () => ({ rateLimit: okRateLimit }) as any;
      },
      now: () => "t",
    });

    assert.deepEqual(seen, [
      {
        env: "github_app:BOT_A_INSTALLATION_ID",
        kind: "github_app",
        name: "example-bot-a",
        strategy: "round_robin",
        value: "ghs-1001-SECRET",
      },
      {
        env: "github_app:BOT_B_INSTALLATION_ID",
        kind: "github_app",
        name: "example-bot-b",
        strategy: "round_robin",
        value: "ghs-1002-SECRET",
      },
    ]);
    assert.deepEqual(result.tokens.map((t) => ({
      env: t.env,
      kind: (t as any).kind,
      name: (t as any).name,
      strategy: (t as any).strategy,
      used: t.used,
      remaining: t.remaining,
    })), [
      {
        env: "github_app:BOT_A_INSTALLATION_ID",
        kind: "github_app",
        name: "example-bot-a",
        strategy: "round_robin",
        used: 10,
        remaining: 4990,
      },
      {
        env: "github_app:BOT_B_INSTALLATION_ID",
        kind: "github_app",
        name: "example-bot-b",
        strategy: "round_robin",
        used: 10,
        remaining: 4990,
      },
    ]);
    assert.equal(JSON.stringify(result).includes("ghs-1001-SECRET"), false);
    assert.equal(JSON.stringify(result).includes("ghs-1002-SECRET"), false);
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("probeTokenRateLimits orders bot rows before PAT rows for diagnostics", async () => {
  const appCfg: AppConfig = {
    db_path: "x.db",
    sources: [{
      source_id: "github:github.com",
      kind: "github",
      host: "github.com",
      display_name: "GitHub",
      token_env: "GH_PAT",
      graphql_url: "https://api.github.com/graphql",
      projects: ["o/r"],
    }],
  };
  const result = await probeTokenRateLimits(appCfg, {
    authTokenResolver: {
      tokensForSource: async () => [],
      tokensForProject: async () => [],
      resolveSourceTokens: async () => [
        { env: "GH_PAT", value: "ghp-pat-SECRET", kind: "pat", strategy: "failover" },
        {
          env: "github_app:BOT_INSTALLATION_ID",
          value: "ghs-bot-SECRET",
          kind: "github_app",
          name: "example-bot",
          strategy: "round_robin",
        },
      ],
    },
    clientFactory: () => async () => ({ rateLimit: okRateLimit }) as any,
    now: () => "t",
  });

  assert.deepEqual(result.tokens.map((t) => [t.kind, t.env]), [
    ["github_app", "github_app:BOT_INSTALLATION_ID"],
    ["pat", "GH_PAT"],
  ]);
  assert.equal(JSON.stringify(result).includes("ghp-pat-SECRET"), false);
  assert.equal(JSON.stringify(result).includes("ghs-bot-SECRET"), false);
});
