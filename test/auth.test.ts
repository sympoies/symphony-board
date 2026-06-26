import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createAuthTokenResolver, mintGitHubAppInstallationToken, type GitHubAppTokenRequest } from "../src/auth.ts";
import type { SourceConfig } from "../src/config.ts";

function source(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    source_id: "github:github.com",
    kind: "github",
    host: "github.com",
    token_env: "AUTH_PAT",
    graphql_url: "https://api.github.com/graphql",
    projects: ["default/repo", { path: "sympoies/repo", token_pool: "bot" }],
    ...over,
  };
}

test("GitHub App auth mints an installation token and can coexist with PAT env tokens", async () => {
  const seen: GitHubAppTokenRequest[] = [];
  const resolver = createAuthTokenResolver({
    mintGitHubAppInstallationToken: async (request) => {
      seen.push(request);
      return { env: request.label, value: `app-token-${request.installationId}` };
    },
  });
  process.env.AUTH_PAT = "pat-token";
  process.env.AUTH_APP_ID = "12345";
  process.env.AUTH_INSTALLATION_ID = "67890";
  process.env.AUTH_PRIVATE_KEY_B64 = Buffer.from("PRIVATE KEY").toString("base64");
  try {
    const tokens = await resolver.tokensForSource(source({
      github_app: {
        app_id_env: "AUTH_APP_ID",
        installation_id_env: "AUTH_INSTALLATION_ID",
        private_key_base64_env: "AUTH_PRIVATE_KEY_B64",
      },
    }));

    assert.deepEqual(tokens, [
      { env: "github_app:AUTH_INSTALLATION_ID", value: "app-token-67890", kind: "github_app", strategy: "failover" },
      { env: "AUTH_PAT", value: "pat-token", kind: "pat", strategy: "failover" },
    ]);
    assert.equal(seen[0]?.appId, "12345");
    assert.equal(seen[0]?.installationId, "67890");
    assert.equal(seen[0]?.privateKey, "PRIVATE KEY");
    assert.equal(seen[0]?.restUrl, "https://api.github.com");
  } finally {
    delete process.env.AUTH_PAT;
    delete process.env.AUTH_APP_ID;
    delete process.env.AUTH_INSTALLATION_ID;
    delete process.env.AUTH_PRIVATE_KEY_B64;
  }
});

test("repo token pools can route a GitHub repo through a GitHub App while other repos use source PATs", async () => {
  const resolver = createAuthTokenResolver({
    mintGitHubAppInstallationToken: async (request) => ({ env: request.label, value: `app-token-${request.installationId}` }),
  });
  process.env.AUTH_PAT = "pat-token";
  process.env.AUTH_APP_ID = "12345";
  process.env.AUTH_INSTALLATION_ID = "67890";
  process.env.AUTH_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----";
  try {
    const cfg = source({
      token_pools: {
        bot: {
          github_app: {
            app_id_env: "AUTH_APP_ID",
            installation_id_env: "AUTH_INSTALLATION_ID",
            private_key_env: "AUTH_PRIVATE_KEY",
          },
        },
      },
    });

    assert.deepEqual(await resolver.tokensForProject(cfg, "default/repo"), [
      { env: "AUTH_PAT", value: "pat-token", kind: "pat", strategy: "failover" },
    ]);
    assert.deepEqual(await resolver.tokensForProject(cfg, "sympoies/repo"), [
      { env: "github_app:AUTH_INSTALLATION_ID", value: "app-token-67890", kind: "github_app", strategy: "failover" },
    ]);
  } finally {
    delete process.env.AUTH_PAT;
    delete process.env.AUTH_APP_ID;
    delete process.env.AUTH_INSTALLATION_ID;
    delete process.env.AUTH_PRIVATE_KEY;
  }
});

test("auth_policy routes repo bot pools through every GitHub App with round-robin metadata", async () => {
  const seen: GitHubAppTokenRequest[] = [];
  const resolver = createAuthTokenResolver({
    mintGitHubAppInstallationToken: async (request) => {
      seen.push(request);
      return { env: request.label, value: `app-token-${request.installationId}` };
    },
  });
  process.env.AUTH_PAT = "pat-token";
  process.env.BOT_A_APP_ID = "111";
  process.env.BOT_A_INSTALLATION_ID = "1001";
  process.env.BOT_A_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\na\\n-----END PRIVATE KEY-----";
  process.env.BOT_B_APP_ID = "222";
  process.env.BOT_B_INSTALLATION_ID = "1002";
  process.env.BOT_B_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nb\\n-----END PRIVATE KEY-----";
  try {
    const cfg = source({
      token_env: undefined,
      token_pools: undefined,
      auth_pools: {
        source_pat: { kind: "pat", token_env: "AUTH_PAT" },
        example_bots: {
          kind: "github_app",
          strategy: "round_robin",
          apps: [
            {
              name: "example-bot-a",
              app_id_env: "BOT_A_APP_ID",
              installation_id_env: "BOT_A_INSTALLATION_ID",
              private_key_env: "BOT_A_PRIVATE_KEY",
            },
            {
              name: "example-bot-b",
              app_id_env: "BOT_B_APP_ID",
              installation_id_env: "BOT_B_INSTALLATION_ID",
              private_key_env: "BOT_B_PRIVATE_KEY",
            },
          ],
        },
      },
      auth_policy: { mode: "pat", pat_pool: "source_pat" },
      projects: [
        "default/repo",
        { path: "sympoies/private-repo", auth_policy: { mode: "bot", bot_pool: "example_bots" } },
        { path: "sympoies/mixed-repo", auth_policy: { mode: "bot_then_pat", bot_pool: "example_bots", pat_pool: "source_pat" } },
      ],
    } as Partial<SourceConfig>);

    assert.deepEqual(await resolver.tokensForProject(cfg, "default/repo"), [
      { env: "AUTH_PAT", value: "pat-token", kind: "pat", strategy: "failover" },
    ]);
    assert.deepEqual(await resolver.tokensForProject(cfg, "sympoies/private-repo"), [
      {
        env: "github_app:BOT_A_INSTALLATION_ID",
        value: "app-token-1001",
        kind: "github_app",
        name: "example-bot-a",
        strategy: "round_robin",
      },
      {
        env: "github_app:BOT_B_INSTALLATION_ID",
        value: "app-token-1002",
        kind: "github_app",
        name: "example-bot-b",
        strategy: "round_robin",
      },
    ]);
    assert.deepEqual(await resolver.tokensForProject(cfg, "sympoies/mixed-repo"), [
      {
        env: "github_app:BOT_A_INSTALLATION_ID",
        value: "app-token-1001",
        kind: "github_app",
        name: "example-bot-a",
        strategy: "round_robin",
      },
      {
        env: "github_app:BOT_B_INSTALLATION_ID",
        value: "app-token-1002",
        kind: "github_app",
        name: "example-bot-b",
        strategy: "round_robin",
      },
      { env: "AUTH_PAT", value: "pat-token", kind: "pat", strategy: "failover" },
    ]);
    assert.deepEqual(seen.map((request) => request.label), [
      "github_app:BOT_A_INSTALLATION_ID",
      "github_app:BOT_B_INSTALLATION_ID",
    ]);
  } finally {
    delete process.env.AUTH_PAT;
    delete process.env.BOT_A_APP_ID;
    delete process.env.BOT_A_INSTALLATION_ID;
    delete process.env.BOT_A_PRIVATE_KEY;
    delete process.env.BOT_B_APP_ID;
    delete process.env.BOT_B_INSTALLATION_ID;
    delete process.env.BOT_B_PRIVATE_KEY;
  }
});

test("mintGitHubAppInstallationToken posts a signed JWT to the installation token endpoint", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls++;
    assert.equal(String(input), "https://api.github.com/app/installations/67890/access_tokens");
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Accept, "application/vnd.github+json");
    assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
    const auth = headers.Authorization;
    assert.equal(typeof auth, "string");
    if (typeof auth !== "string") throw new Error("Authorization header missing");
    assert.match(auth, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    const [, payload] = auth.slice("Bearer ".length).split(".");
    const parsedPayload = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    assert.equal(parsedPayload.iss, 12345);
    assert.equal(typeof parsedPayload.iat, "number");
    assert.equal(typeof parsedPayload.exp, "number");
    return new Response(JSON.stringify({ token: "ghs_INSTALLATION_TOKEN" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const token = await mintGitHubAppInstallationToken({
      appId: "12345",
      installationId: "67890",
      privateKey: pem,
      restUrl: "https://api.github.com",
      label: "github_app:AUTH_INSTALLATION_ID",
    });
    assert.deepEqual(token, { env: "github_app:AUTH_INSTALLATION_ID", value: "ghs_INSTALLATION_TOKEN", kind: "github_app", strategy: "failover" });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bot_then_pat preserves the PAT fallback when one bot mint fails, skipping only the failed bot", async () => {
  // A revoked installation / transient token-endpoint error makes Bot A's mint
  // throw. The policy must still return Bot B and the PAT pool — a single mint
  // failure must not reject the whole resolution or drop the PAT failover.
  const resolver = createAuthTokenResolver({
    mintGitHubAppInstallationToken: async (request) => {
      if (request.installationId === "1001") {
        throw new Error("GitHub App token HTTP 404: installation not found");
      }
      return { env: request.label, value: `app-token-${request.installationId}` };
    },
  });
  process.env.AUTH_PAT = "pat-token";
  process.env.BOT_A_APP_ID = "111";
  process.env.BOT_A_INSTALLATION_ID = "1001";
  process.env.BOT_A_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\na\\n-----END PRIVATE KEY-----";
  process.env.BOT_B_APP_ID = "222";
  process.env.BOT_B_INSTALLATION_ID = "1002";
  process.env.BOT_B_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nb\\n-----END PRIVATE KEY-----";
  try {
    const cfg = source({
      token_env: undefined,
      token_pools: undefined,
      auth_pools: {
        source_pat: { kind: "pat", token_env: "AUTH_PAT" },
        example_bots: {
          kind: "github_app",
          strategy: "round_robin",
          apps: [
            { name: "example-bot-a", app_id_env: "BOT_A_APP_ID", installation_id_env: "BOT_A_INSTALLATION_ID", private_key_env: "BOT_A_PRIVATE_KEY" },
            { name: "example-bot-b", app_id_env: "BOT_B_APP_ID", installation_id_env: "BOT_B_INSTALLATION_ID", private_key_env: "BOT_B_PRIVATE_KEY" },
          ],
        },
      },
      projects: [
        { path: "sympoies/mixed-repo", auth_policy: { mode: "bot_then_pat", bot_pool: "example_bots", pat_pool: "source_pat" } },
      ],
    } as Partial<SourceConfig>);

    assert.deepEqual(await resolver.tokensForProject(cfg, "sympoies/mixed-repo"), [
      { env: "github_app:BOT_B_INSTALLATION_ID", value: "app-token-1002", kind: "github_app", name: "example-bot-b", strategy: "round_robin" },
      { env: "AUTH_PAT", value: "pat-token", kind: "pat", strategy: "failover" },
    ]);
  } finally {
    delete process.env.AUTH_PAT;
    delete process.env.BOT_A_APP_ID;
    delete process.env.BOT_A_INSTALLATION_ID;
    delete process.env.BOT_A_PRIVATE_KEY;
    delete process.env.BOT_B_APP_ID;
    delete process.env.BOT_B_INSTALLATION_ID;
    delete process.env.BOT_B_PRIVATE_KEY;
  }
});

test("bot_then_pat degrades to the PAT pool when every bot mint fails, instead of rejecting", async () => {
  // A bad app key or down token endpoint fails all bot mints. bot_then_pat must
  // still yield the configured PAT failover rather than aborting the source.
  const resolver = createAuthTokenResolver({
    mintGitHubAppInstallationToken: async () => {
      throw new Error("GitHub App token HTTP 401: bad credentials");
    },
  });
  process.env.AUTH_PAT = "pat-token";
  process.env.BOT_A_APP_ID = "111";
  process.env.BOT_A_INSTALLATION_ID = "1001";
  process.env.BOT_A_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\na\\n-----END PRIVATE KEY-----";
  try {
    const cfg = source({
      token_env: undefined,
      token_pools: undefined,
      auth_pools: {
        source_pat: { kind: "pat", token_env: "AUTH_PAT" },
        example_bots: {
          kind: "github_app",
          strategy: "round_robin",
          apps: [
            { name: "example-bot-a", app_id_env: "BOT_A_APP_ID", installation_id_env: "BOT_A_INSTALLATION_ID", private_key_env: "BOT_A_PRIVATE_KEY" },
          ],
        },
      },
      projects: [
        { path: "sympoies/mixed-repo", auth_policy: { mode: "bot_then_pat", bot_pool: "example_bots", pat_pool: "source_pat" } },
      ],
    } as Partial<SourceConfig>);

    assert.deepEqual(await resolver.tokensForProject(cfg, "sympoies/mixed-repo"), [
      { env: "AUTH_PAT", value: "pat-token", kind: "pat", strategy: "failover" },
    ]);
    // A mint failure that still leaves a usable PAT failover is benign: it must
    // NOT be reported as a hard mint failure (that would error a source that
    // legitimately failed over).
    assert.equal(resolver.hardMintFailure?.(cfg) ?? null, null);
  } finally {
    delete process.env.AUTH_PAT;
    delete process.env.BOT_A_APP_ID;
    delete process.env.BOT_A_INSTALLATION_ID;
    delete process.env.BOT_A_PRIVATE_KEY;
  }
});

test("a bot-only auth policy whose every mint fails surfaces a hard mint failure instead of resolving empty", async () => {
  // mode: "bot" with no PAT failover. When the only bot mint fails, returning an
  // empty pool would make runConfiguredSync skip the source as "no tokens set"
  // and still emit a stale contract. Record a hard mint failure so the caller
  // can surface an actionable error rather than a silent skip.
  const resolver = createAuthTokenResolver({
    mintGitHubAppInstallationToken: async () => {
      throw new Error("GitHub App token HTTP 401: bad credentials");
    },
  });
  process.env.BOT_A_APP_ID = "111";
  process.env.BOT_A_INSTALLATION_ID = "1001";
  process.env.BOT_A_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\na\\n-----END PRIVATE KEY-----";
  try {
    const cfg = source({
      token_env: undefined,
      token_pools: undefined,
      auth_pools: {
        only_bots: {
          kind: "github_app",
          strategy: "round_robin",
          apps: [
            { name: "only-bot-a", app_id_env: "BOT_A_APP_ID", installation_id_env: "BOT_A_INSTALLATION_ID", private_key_env: "BOT_A_PRIVATE_KEY" },
          ],
        },
      },
      auth_policy: { mode: "bot", bot_pool: "only_bots" },
      projects: ["sympoies/bot-only-repo"],
    } as Partial<SourceConfig>);

    assert.deepEqual(await resolver.tokensForSource(cfg), []);
    assert.match(resolver.hardMintFailure?.(cfg) ?? "", /bad credentials/);
  } finally {
    delete process.env.BOT_A_APP_ID;
    delete process.env.BOT_A_INSTALLATION_ID;
    delete process.env.BOT_A_PRIVATE_KEY;
  }
});

test("a repo token pool whose GitHub App mint fails does not silently fall back to the source PAT", async () => {
  // A repo routed through a legacy token_pools.<name>.github_app pool with no
  // fallback PAT in the pool. When the mint fails, the old behaviour resolved an
  // empty pool and fell back to the source PAT — silently fetching the repo with
  // credentials outside its selected pool. Surface a hard mint failure instead.
  const resolver = createAuthTokenResolver({
    mintGitHubAppInstallationToken: async () => {
      throw new Error("GitHub App token HTTP 404: installation not found");
    },
  });
  process.env.AUTH_PAT = "source-pat";
  process.env.BP_APP_ID = "321";
  process.env.BP_INSTALLATION_ID = "9001";
  process.env.BP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nz\\n-----END PRIVATE KEY-----";
  try {
    const cfg = source({
      token_env: "AUTH_PAT",
      token_pools: {
        repo_bot: {
          github_app: { app_id_env: "BP_APP_ID", installation_id_env: "BP_INSTALLATION_ID", private_key_env: "BP_PRIVATE_KEY" },
        },
      },
      auth_pools: undefined,
      projects: [{ path: "sympoies/bot-routed-repo", token_pool: "repo_bot" }],
    } as Partial<SourceConfig>);

    assert.deepEqual(await resolver.tokensForProject(cfg, "sympoies/bot-routed-repo"), []);
    assert.match(resolver.hardMintFailure?.(cfg) ?? "", /installation not found/);
  } finally {
    delete process.env.AUTH_PAT;
    delete process.env.BP_APP_ID;
    delete process.env.BP_INSTALLATION_ID;
    delete process.env.BP_PRIVATE_KEY;
  }
});
