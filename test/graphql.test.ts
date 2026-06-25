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
    return new Response(JSON.stringify({ data: { viewer: { login: "dev-a" } } }), { status: 200 });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", "gh-token");
  const data = await gql<{ viewer: { login: string } }>("query Q($a: Int) { viewer { login } }", { a: 1 });

  assert.deepEqual(data, { viewer: { login: "dev-a" } });
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

test("GitHub GraphQL primary rate limit rotates to the next token for the same request", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    if (auths.length === 1) {
      return new Response(JSON.stringify({ data: null, errors: [{ message: "API rate limit exceeded" }] }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1770000000" },
      });
    }
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "GITHUB_TOKEN", value: "primary" },
    { env: "GITHUB_TOKEN_BACKUP", value: "backup" },
  ]);

  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(auths, ["Bearer primary", "Bearer backup"]);
});

test("GitHub GraphQL round-robin bot tokens alternate between successful requests", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a", kind: "github_app", name: "example-bot-a", strategy: "round_robin" },
    { env: "github_app:BOT_B_INSTALLATION_ID", value: "bot-b", kind: "github_app", name: "example-bot-e", strategy: "round_robin" },
  ]);

  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(auths, ["Bearer bot-a", "Bearer bot-b", "Bearer bot-a"]);
});

test("once every token is cooled down, the GraphQL client stops hammering them", async () => {
  // When every token in the pool has been primary-rate-limited, the client must
  // NOT keep sending requests with a known-cooled-down PAT. It must short-circuit
  // and reject without another doomed request.
  let calls = 0;
  mockFetch(() => {
    calls++;
    return new Response(JSON.stringify({ data: null, errors: [{ message: "API rate limit exceeded" }] }), {
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
    });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "GITHUB_TOKEN", value: "primary" },
    { env: "GITHUB_TOKEN_BACKUP", value: "backup" },
  ]);

  // First call tries each token once, cools both down, then rejects.
  await assert.rejects(() => gql("query { x }"));
  assert.equal(calls, 2, "first call tries both tokens once each");

  // Second call: both tokens are still cooled down -> no further request.
  await assert.rejects(() => gql("query { x }"), /rate-limited/);
  assert.equal(calls, 2, "no further request once all tokens are cooled down");
});

test("a single-token GitHub client cools down and stops hammering after a primary rate limit", async () => {
  // With no fallback pool (the default), a primary rate limit must still cool
  // the token down so the NEXT request short-circuits instead of re-sending the
  // exhausted PAT for the rest of the run.
  let calls = 0;
  mockFetch(() => {
    calls++;
    return new Response(JSON.stringify({ data: null, errors: [{ message: "API rate limit exceeded" }] }), {
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
    });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", "only-token");

  await assert.rejects(() => gql("query { x }"));
  assert.equal(calls, 1, "first call hits the single token once");

  await assert.rejects(() => gql("query { x }"), /rate-limited/);
  assert.equal(calls, 1, "no further request after the single token is cooled down");
});

test("GitHub GraphQL fallback repo-access failures identify the fallback token", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    if (auths.length === 1) {
      return new Response(JSON.stringify({ data: null, errors: [{ message: "API rate limit exceeded" }] }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1770000000" },
      });
    }
    return new Response(
      JSON.stringify({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository with the name 'org/private'." }] }),
      { status: 200 },
    );
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "GITHUB_TOKEN", value: "primary" },
    { env: "GITHUB_TOKEN_BACKUP", value: "backup" },
  ]);

  await assert.rejects(() => gql("query { repository(owner:\"org\", name:\"private\") { id } }"), /fallback token lacks repo access/);
  assert.deepEqual(auths, ["Bearer primary", "Bearer backup"]);
});
