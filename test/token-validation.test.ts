import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProviderToken, type TokenValidationClientFactory } from "../src/server/token-validation.ts";
import type { AppConfig } from "../src/config.ts";

const cfg: AppConfig = {
  db_path: "data/board.db",
  sources: [
    {
      source_id: "github:github.com",
      kind: "github",
      host: "github.com",
      token_env: "GITHUB_TOKEN",
      graphql_url: "https://api.github.com/graphql",
      rest_url: "https://api.github.com",
      projects: ["sympoies/symphony-board"],
    },
  ],
};

test("validateProviderToken verifies a GitHub PAT against the configured repo without echoing the token", async () => {
  const calls: Array<{ url: string; provider: string; tokenValue: string; query: string; variables: Record<string, unknown> | undefined }> = [];
  const clientFactory: TokenValidationClientFactory = (url, token, provider) => {
    return async <T = any>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      calls.push({ url, provider, tokenValue: token.value, query, variables });
      return {
        viewer: { login: "octocat" },
        repository: { id: "R_1", nameWithOwner: "sympoies/symphony-board" },
      } as T;
    };
  };

  const result = await validateProviderToken(
    cfg,
    { source_id: "github:github.com", env: "GITHUB_TOKEN", value: "ghp_secret_value" },
    { clientFactory },
  );

  assert.deepEqual(result, {
    ok: true,
    source_id: "github:github.com",
    env: "GITHUB_TOKEN",
    provider: "github",
    account: "octocat",
    project_path: "sympoies/symphony-board",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/graphql");
  assert.equal(calls[0]!.provider, "github");
  assert.equal(calls[0]!.tokenValue, "ghp_secret_value");
  assert.match(calls[0]!.query, /viewer/);
  assert.deepEqual(calls[0]!.variables, { owner: "sympoies", name: "symphony-board" });
  assert.ok(!JSON.stringify(result).includes("ghp_secret_value"), "validation result never includes the token value");
});

test("validateProviderToken checks every source-level repo an env can authenticate", async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const clientFactory: TokenValidationClientFactory = (_url, _token, _provider) => {
    return async <T = any>(_query: string, variables?: Record<string, unknown>): Promise<T> => {
      calls.push(variables);
      if (variables?.owner === "sympoies" && variables?.name === "symphony-board") {
        return {
          viewer: { login: "octocat" },
          repository: { id: "R_1", nameWithOwner: "sympoies/symphony-board" },
        } as T;
      }
      return {
        viewer: { login: "octocat" },
        repository: null,
      } as T;
    };
  };

  const result = await validateProviderToken(
    {
      ...cfg,
      sources: [
        {
          ...cfg.sources[0]!,
          projects: ["sympoies/symphony-board", "sympoies/private-board"],
        },
      ],
    },
    { source_id: "github:github.com", env: "GITHUB_TOKEN", value: "ghp_secret_value" },
    { clientFactory },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_token");
  assert.equal(result.project_path, "sympoies/private-board");
  assert.deepEqual(calls, [
    { owner: "sympoies", name: "symphony-board" },
    { owner: "sympoies", name: "private-board" },
  ]);
});

test("validateProviderToken validates repo token pool envs against their routed repo", async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const clientFactory: TokenValidationClientFactory = (_url, _token, _provider) => {
    return async <T = any>(_query: string, variables?: Record<string, unknown>): Promise<T> => {
      calls.push(variables);
      if (variables?.owner !== "sympoies" || variables?.name !== "private-board") {
        throw new Error(`unexpected validation project: ${JSON.stringify(variables)}`);
      }
      return {
        viewer: { login: "octocat" },
        repository: { id: "R_private", nameWithOwner: "sympoies/private-board" },
      } as T;
    };
  };

  const result = await validateProviderToken(
    {
      ...cfg,
      sources: [
        {
          ...cfg.sources[0]!,
          token_pools: { private: { token_env: "GITHUB_PRIVATE_TOKEN" } },
          projects: ["sympoies/symphony-board", { path: "sympoies/private-board", token_pool: "private" }],
        },
      ],
    },
    { source_id: "github:github.com", env: "GITHUB_PRIVATE_TOKEN", value: "ghp_private_value" },
    { clientFactory },
  );

  assert.deepEqual(result, {
    ok: true,
    source_id: "github:github.com",
    env: "GITHUB_PRIVATE_TOKEN",
    provider: "github",
    account: "octocat",
    project_path: "sympoies/private-board",
  });
  assert.deepEqual(calls, [{ owner: "sympoies", name: "private-board" }]);
});

test("validateProviderToken rejects unconfigured env names before any provider call", async () => {
  let called = false;
  const result = await validateProviderToken(
    cfg,
    { source_id: "github:github.com", env: "OTHER_TOKEN", value: "secret" },
    {
      clientFactory: () => {
        called = true;
        return async <T = any>() => ({} as T);
      },
    },
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, "bad_request");
  assert.match(result.message ?? "", /not configured/);
});

test("validateProviderToken reports provider failures as invalid_token without leaking the token", async () => {
  const result = await validateProviderToken(
    cfg,
    { source_id: "github:github.com", env: "GITHUB_TOKEN", value: "ghp_bad_value" },
    {
      clientFactory: () => async () => {
        throw new Error("GraphQL HTTP 401: Bad credentials");
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_token");
  assert.match(result.message ?? "", /Bad credentials/);
  assert.ok(!JSON.stringify(result).includes("ghp_bad_value"), "failure response never includes the token value");
});
