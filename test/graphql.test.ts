import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { makeGqlClient } from "../src/sources/graphql.ts";

// Every GraphQL request both providers make funnels through makeGqlClient, so
// these tests lock the shared wire format and — more importantly — the error
// semantics the sync engine's deletion invariant leans on: ANY GraphQL-level
// failure throws, the engine records the source as failed, and a failed source
// never tombstones (see test/sync-engine.test.ts).

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(fn: (url: URL, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    return fn(url, init ?? {});
  }) as typeof fetch;
}

test("makeGqlClient POSTs the query with bearer auth and unwraps json.data", async () => {
  let seenUrl: URL | undefined;
  let seenInit: RequestInit = {};
  mockFetch((url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(JSON.stringify({ data: { viewer: { login: "graysurf" } } }), { status: 200 });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", "gh-token");
  const data = await gql<{ viewer: { login: string } }>("query Q($a: Int) { viewer { login } }", { a: 1 });

  assert.deepEqual(data, { viewer: { login: "graysurf" } });
  assert.equal(seenUrl?.href, "https://api.github.com/graphql");
  assert.equal(seenInit.method, "POST");
  const headers = seenInit.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer gh-token");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["User-Agent"], "symphony-board");
  assert.deepEqual(JSON.parse(String(seenInit.body)), { query: "query Q($a: Int) { viewer { login } }", variables: { a: 1 } });
});

test("variables default to an empty object on the wire", async () => {
  let body: unknown;
  mockFetch((_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  });
  const gql = makeGqlClient("https://gitlab.com/api/graphql", "gl-token");
  await gql("query { x }");
  assert.deepEqual(body, { query: "query { x }", variables: {} });
});

test("a non-JSON body is reported with the HTTP status and endpoint", async () => {
  mockFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
  const gql = makeGqlClient("https://gitlab.example.com/api/graphql", "tok");
  await assert.rejects(
    () => gql("query { x }"),
    /GraphQL HTTP 502: non-JSON response from https:\/\/gitlab\.example\.com\/api\/graphql/,
  );
});

test("an HTTP error prefers the JSON message field, falling back to the raw body", async () => {
  mockFetch(() => new Response(JSON.stringify({ message: "rate limited" }), { status: 403 }));
  const gql = makeGqlClient("https://api.github.com/graphql", "tok");
  await assert.rejects(() => gql("query { x }"), /GraphQL HTTP 403: rate limited/);

  mockFetch(() => new Response(JSON.stringify({ oops: 1 }), { status: 500 }));
  await assert.rejects(() => gql("query { x }"), /GraphQL HTTP 500: \{"oops":1\}/);
});

test("GraphQL-level errors fail the call even when partial data is present", async () => {
  // The GraphQL spec allows { data, errors } simultaneously. We deliberately
  // DISCARD the partial data and throw: a half-seen sweep must read as a failed
  // source (which never tombstones), not as a complete-but-smaller result.
  mockFetch(() =>
    new Response(
      JSON.stringify({ data: { project: { issues: { nodes: [] } } }, errors: [{ message: "boom" }, { message: "denied" }] }),
      { status: 200 },
    ),
  );
  const gql = makeGqlClient("https://api.github.com/graphql", "tok");
  await assert.rejects(() => gql("query { x }"), /GraphQL errors: boom; denied/);
});

test("an empty errors array is not an error", async () => {
  mockFetch(() => new Response(JSON.stringify({ data: { ok: true }, errors: [] }), { status: 200 }));
  const gql = makeGqlClient("https://api.github.com/graphql", "tok");
  assert.deepEqual(await gql("query { x }"), { ok: true });
});
