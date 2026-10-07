import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSource } from "../src/sources/github.ts";
import { makeGqlClient } from "../src/sources/graphql.ts";
import { makeRestClient } from "../src/sources/rest.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(fn: (init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (_input, init) => fn(init ?? {})) as typeof fetch;
}

function transportError(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  });
}

function page(kind: "issues" | "pullRequests", ids: string[], cursor: string | null = null): Response {
  return new Response(JSON.stringify({ data: { repository: { [kind]: {
    nodes: ids.map((id, index) => ({ id, number: index + 1, body: "", updatedAt: "2026-01-01T00:00:00Z" })),
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  } } } }), { status: 200 });
}

function source(): GitHubSource {
  return new GitHubSource(
    { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null },
    makeGqlClient("https://api.github.com/graphql", "fixture-token"),
    ["example/project"],
  );
}

test("a full GitHub sweep recovers a first failed project request without repeating pages", async () => {
  const cursors: Array<string | null> = [];
  mockFetch((init) => {
    const { query, variables } = JSON.parse(String(init.body));
    if (!query.includes("pullRequests(")) return page("issues", ["ISSUE_1"]);
    cursors.push(variables.cursor);
    if (cursors.length === 1) throw transportError();
    return variables.cursor === null
      ? page("pullRequests", ["PR_1"], "next")
      : page("pullRequests", ["PR_2"]);
  });

  const result = await source().fetch({ full: true, since: null });

  assert.equal(result.complete, true, "a recovered request must not mark full-source coverage partial");
  assert.equal(result.error, null);
  assert.deepEqual(result.records.map((record) => record.externalId), ["ISSUE_1", "PR_1", "PR_2"]);
  assert.deepEqual(cursors, [null, null, "next"], "only the failed request is repeated");
});

test("a full GitHub sweep remains partial after exhausting transport retries", async () => {
  let attempts = 0;
  mockFetch((init) => {
    const { query } = JSON.parse(String(init.body));
    if (!query.includes("pullRequests(")) return page("issues", ["ISSUE_1"]);
    attempts++;
    throw transportError();
  });

  const result = await source().fetch({ full: true, since: null });

  assert.equal(attempts, 3, "the request has one initial attempt and two retries");
  assert.equal(result.complete, false, "exhaustion cannot claim full coverage");
  assert.match(result.error ?? "", /change_request: fetch failed/);
  assert.deepEqual(result.records.map((record) => record.externalId), ["ISSUE_1"]);
});

test("GitHub REST recovers a first transport failure", async () => {
  let attempts = 0;
  mockFetch(() => {
    if (++attempts === 1) throw transportError();
    return new Response(JSON.stringify([{ id: "EVENT_1" }]), { status: 200 });
  });
  const rest = makeRestClient("https://api.github.com", "fixture-token", "github");

  assert.deepEqual(await rest("repos/example/project/events"), [{ id: "EVENT_1" }]);
  assert.equal(attempts, 2);
});

test("GitHub transport and gateway failures share one budget and count every request", async () => {
  let attempts = 0;
  let requests = 0;
  const finalError = transportError();
  mockFetch(() => {
    attempts++;
    if (attempts === 1) throw transportError();
    if (attempts === 2) return new Response("bad gateway", { status: 502 });
    throw finalError;
  });
  const gql = makeGqlClient("https://api.github.com/graphql", "fixture-token", {
    onRequest: () => { requests++; },
  });

  await assert.rejects(() => gql("query { viewer { login } }"), (err) => err === finalError);
  assert.equal(attempts, 3, "switching failure type cannot restart the retry budget");
  assert.equal(requests, 3, "request telemetry includes failed transport attempts");
});

test("unrelated fetch errors are not retried", async () => {
  for (const error of [new TypeError("Failed to parse URL"), new Error("unexpected client error")]) {
    let attempts = 0;
    mockFetch(() => { attempts++; throw error; });
    const gql = makeGqlClient("https://api.github.com/graphql", "fixture-token");
    await assert.rejects(() => gql("query { viewer { login } }"), (err) => err === error);
    assert.equal(attempts, 1);
  }
});

test("GitLab transport failures retain their existing fail-fast behavior", async () => {
  for (const request of [
    () => makeGqlClient("https://gitlab.example/api/graphql", "fixture-token", { provider: "gitlab" })("query { x }"),
    () => makeRestClient("https://gitlab.example/api/v4", "fixture-token", "gitlab")("projects/1/events"),
  ]) {
    let attempts = 0;
    const error = transportError();
    mockFetch(() => { attempts++; throw error; });
    await assert.rejects(request, (err) => err === error);
    assert.equal(attempts, 1);
  }
});

test("GitHub request timeouts remain bounded to one attempt", async () => {
  let attempts = 0;
  mockFetch((init) => {
    attempts++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
  const rest = makeRestClient("https://api.github.com", "fixture-token", "github", 20);
  await assert.rejects(() => rest("repos/example/project/events"), /timed out after 20ms/);
  assert.equal(attempts, 1);
});
