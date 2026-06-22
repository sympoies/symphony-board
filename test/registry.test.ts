import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSource } from "../src/sources/registry.ts";
import { GitHubSource } from "../src/sources/github.ts";
import { GitLabSource } from "../src/sources/gitlab.ts";
import type { SourceConfig } from "../src/config.ts";

// buildSource is the only place a SourceConfig becomes a live Source — a wiring
// mistake here (wrong class, dropped descriptor field) breaks every sync, so the
// mapping is locked even though each class is tested on its own.

function cfg(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    source_id: "github:github.com",
    kind: "github",
    host: "github.com",
    token_env: "T",
    graphql_url: "https://api.github.com/graphql",
    projects: ["o/r"],
    ...over,
  };
}

test("a github config builds a GitHubSource with the descriptor mapped field-for-field", () => {
  const src = buildSource(cfg({ display_name: "GitHub" }), "tok");
  assert.ok(src instanceof GitHubSource);
  assert.deepEqual(src.descriptor, {
    sourceId: "github:github.com",
    kind: "github",
    host: "github.com",
    displayName: "GitHub",
  });
});

test("a missing display_name maps to a null descriptor displayName", () => {
  const src = buildSource(cfg(), "tok");
  assert.equal(src.descriptor.displayName, null);
});

test("a gitlab config builds a GitLabSource", () => {
  const src = buildSource(
    cfg({ source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", graphql_url: "https://gitlab.com/api/graphql" }),
    "tok",
  );
  assert.ok(src instanceof GitLabSource);
  assert.equal(src.descriptor.sourceId, "gitlab:gitlab.com");
  assert.equal(src.descriptor.kind, "gitlab");
});

test("a github config with tokenless projects marks the source partial", async () => {
  const calls: Array<{ url: string; method: string; auth: string | null; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      auth: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      body: String(init?.body ?? ""),
    });
    if (method !== "POST") {
      const restPayload = url.endsWith("/repos/sympoies/repo") ? { default_branch: "main" } : [];
      return new Response(JSON.stringify(restPayload), { status: 200, headers: { "content-type": "application/json" } });
    }
    const payload = String(init?.body ?? "").includes("pullRequests(")
      ? { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }
      : { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const src = buildSource(
      cfg({ projects: ["default/repo", { path: "sympoies/repo", token_pool: "sympoies" }] }),
      [],
      new Map([["default/repo", []], ["sympoies/repo", [{ env: "RUNNER_PROJECT_POOL", value: "repo-token" }]]]),
    );

    const result = await src.fetch({ since: null, full: true });

    assert.equal(result.complete, false);
    assert.match(result.error ?? "", /missing token for projects: default\/repo/);
    const graphqlCalls = calls.filter((call) => call.method === "POST");
    assert.equal(graphqlCalls.length, 2, "only the token-covered repo is fetched over GraphQL");
    assert.ok(calls.every((call) => call.auth === "Bearer repo-token"));
    assert.ok(graphqlCalls.every((call) => call.body.includes('"owner":"sympoies"') && call.body.includes('"name":"repo"')));
    assert.ok(calls.every((call) => !call.url.includes("default/repo") && !call.body.includes('"owner":"default"')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown source kind throws and names the offending source", () => {
  assert.throws(
    () => buildSource(cfg({ kind: "bitbucket", source_id: "bb:x" }), "tok"),
    /unknown source kind "bitbucket" for bb:x/,
  );
});
