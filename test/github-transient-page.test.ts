// GitHub GraphQL degrades under heavy pages in two observed ways: a gateway
// status (502/503/504), and a 200 whose body is not JSON. Both are transient.
// A full sweep must retry them with backoff and, when one page keeps failing,
// retry that page once at half size, so a single heavy page does not leave the
// whole GitHub source partial.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSource } from "../src/sources/github.ts";
import { makeGqlClient } from "../src/sources/graphql.ts";
import { DEFAULT_GITHUB_TRANSIENT_RETRY_DELAYS_MS, githubTransientRetryDelaysMs } from "../src/sources/http.ts";

const originalFetch = globalThis.fetch;
const originalDelays = process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS;
beforeEach(() => { process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS = "1,1"; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDelays === undefined) delete process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS;
  else process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS = originalDelays;
});

interface Call { query: string; variables: Record<string, unknown> }

function mockFetch(fn: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (_input, init) => {
    const call = JSON.parse(String(init?.body)) as Call;
    calls.push(call);
    return fn(call);
  }) as typeof fetch;
  return calls;
}

function page(kind: "issues" | "pullRequests", ids: string[], cursor: string | null = null): Response {
  return new Response(JSON.stringify({ data: { repository: { [kind]: {
    nodes: ids.map((id, index) => ({ id, number: index + 1, body: "", updatedAt: "2026-01-01T00:00:00Z" })),
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  } } } }), { status: 200 });
}

const truncated = () => new Response("<html>Whoa there!", { status: 200 });

function source(): GitHubSource {
  return new GitHubSource(
    { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null },
    makeGqlClient("https://api.github.com/graphql", "fixture-token"),
    ["example/project"],
  );
}

const isPrPage = (c: Call) => c.query.includes("pullRequests(");

test("default transient backoff is measured in seconds, and the override parses", () => {
  assert.ok(DEFAULT_GITHUB_TRANSIENT_RETRY_DELAYS_MS.length >= 2);
  for (const ms of DEFAULT_GITHUB_TRANSIENT_RETRY_DELAYS_MS) assert.ok(ms >= 1000, `${ms}ms is not a seconds backoff`);
  process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS = "5, 7";
  assert.deepEqual(githubTransientRetryDelaysMs(), [5, 7]);
  process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS = "nonsense";
  assert.deepEqual(githubTransientRetryDelaysMs(), [...DEFAULT_GITHUB_TRANSIENT_RETRY_DELAYS_MS]);
});

test("a GitHub 200 with a non-JSON body is retried", async () => {
  let attempts = 0;
  mockFetch(() => (++attempts === 1 ? truncated() : new Response(JSON.stringify({ data: { viewer: { login: "x" } } }))));
  const gql = makeGqlClient("https://api.github.com/graphql", "fixture-token");
  assert.deepEqual(await gql("query { viewer { login } }"), { viewer: { login: "x" } });
  assert.equal(attempts, 2);
});

test("a GitHub non-JSON body stays an error after the retry budget", async () => {
  let attempts = 0;
  mockFetch(() => { attempts++; return truncated(); });
  const gql = makeGqlClient("https://api.github.com/graphql", "fixture-token");
  await assert.rejects(() => gql("query { viewer { login } }"), /non-JSON response/);
  assert.equal(attempts, 3, "one initial attempt and two retries");
});

test("a full sweep recovers a page that keeps failing by retrying it once at half size", async () => {
  const calls = mockFetch((c) => {
    if (!isPrPage(c)) return page("issues", ["ISSUE_1"]);
    if (c.variables.first === 50) return c.variables.cursor === null ? truncated() : new Response("bad gateway", { status: 502 });
    return c.variables.cursor === null ? page("pullRequests", ["PR_1"], "next") : page("pullRequests", ["PR_2"]);
  });

  const result = await source().fetch({ full: true, since: null });

  assert.equal(result.complete, true, "a page recovered at half size keeps full coverage");
  assert.equal(result.error, null);
  assert.deepEqual(result.records.map((r) => r.externalId), ["ISSUE_1", "PR_1", "PR_2"]);
  const prPages = calls.filter(isPrPage).map((c) => [c.variables.cursor, c.variables.first]);
  assert.deepEqual(prPages, [
    [null, 50], [null, 50], [null, 50],
    [null, 25],
    ["next", 25],
  ], "the failing page is retried once at half size and the repo continues at that size");
});

test("a page that also fails at half size leaves the source partial", async () => {
  mockFetch((c) => (isPrPage(c) ? new Response("bad gateway", { status: 502 }) : page("issues", ["ISSUE_1"])));
  const result = await source().fetch({ full: true, since: null });
  assert.equal(result.complete, false);
  assert.match(result.error ?? "", /change_request: GraphQL HTTP 502/);
});

test("transport failures do not trigger the half-size retry", async () => {
  const calls = mockFetch((c) => {
    if (!isPrPage(c)) return page("issues", ["ISSUE_1"]);
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  });
  const result = await source().fetch({ full: true, since: null });
  assert.equal(result.complete, false);
  assert.ok(calls.filter(isPrPage).every((c) => c.variables.first === 50));
});

// Serves `total` pull requests in pages of the requested size, keyed by an
// offset cursor, so a test can check coverage across a page-size change.
function prPages(total: number, c: Call): Response {
  const offset = c.variables.cursor === null ? 0 : Number(c.variables.cursor);
  const size = Number(c.variables.first);
  const end = Math.min(total, offset + size);
  const ids = Array.from({ length: end - offset }, (_, i) => `PR_${offset + i}`);
  return page("pullRequests", ids, end < total ? String(end) : null);
}

test("a half-size retry keeps the full sweep's record coverage", async () => {
  mockFetch((c) => {
    if (!isPrPage(c)) return page("issues", ["ISSUE_1"]);
    if (c.variables.first === 50 && c.variables.cursor === null) return truncated();
    return prPages(1500, c);
  });
  const result = await source().fetch({ full: true, since: null });
  assert.equal(result.records.filter((r) => r.entityKind === "change_request").length, 1500);
  assert.equal(result.complete, true);
});

test("a full sweep reaches a repository with more than 2000 pull requests", async () => {
  mockFetch((c) => (isPrPage(c) ? prPages(2001, c) : page("issues", ["ISSUE_1"])));
  const result = await source().fetch({ full: true, since: null });
  assert.equal(result.records.filter((r) => r.entityKind === "change_request").length, 2001);
  assert.equal(result.complete, true);
});

test("a full sweep that stops at its record cap with more pages left is partial", async () => {
  mockFetch((c) => (isPrPage(c) ? prPages(4001, c) : page("issues", ["ISSUE_1"])));
  const result = await source().fetch({ full: true, since: null });
  assert.equal(result.complete, false, "unseen older pull requests must not be tombstoned");
  assert.match(result.error ?? "", /change_request/);
});

test("non-JSON and gateway retries share one three-attempt budget", async () => {
  const replies = [() => truncated(), () => new Response("bad gateway", { status: 502 }), () => new Response("bad gateway", { status: 502 }),
    () => new Response(JSON.stringify({ data: { viewer: { login: "x" } } }))];
  let attempts = 0;
  mockFetch(() => replies[attempts++]!());
  const gql = makeGqlClient("https://api.github.com/graphql", "fixture-token");
  await assert.rejects(() => gql("query { viewer { login } }"), /GraphQL HTTP 502/);
  assert.equal(attempts, 3);
});

test("a recovered mixed transient sequence stays within three attempts", async () => {
  const replies = [() => new Response("bad gateway", { status: 502 }), () => truncated(),
    () => new Response(JSON.stringify({ data: { viewer: { login: "x" } } }))];
  let attempts = 0;
  mockFetch(() => replies[attempts++]!());
  const gql = makeGqlClient("https://api.github.com/graphql", "fixture-token");
  assert.deepEqual(await gql("query { viewer { login } }"), { viewer: { login: "x" } });
  assert.equal(attempts, 3);
});

test("a longer delay override does not add retry attempts", async () => {
  process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS = "0,0,0,0";
  assert.equal(githubTransientRetryDelaysMs().length, DEFAULT_GITHUB_TRANSIENT_RETRY_DELAYS_MS.length);
  let attempts = 0;
  mockFetch(() => { attempts++; return new Response("unavailable", { status: 503 }); });
  const gql = makeGqlClient("https://api.github.com/graphql", "fixture-token");
  await assert.rejects(() => gql("query { viewer { login } }"), /GraphQL HTTP 503/);
  assert.equal(attempts, 3);
});

for (const status of [401, 429]) {
  test(`a non-JSON ${status} does not trigger the half-size retry`, async () => {
    const calls = mockFetch((c) => (isPrPage(c) ? new Response("<html>denied", { status }) : page("issues", ["ISSUE_1"])));
    const result = await source().fetch({ full: true, since: null });
    assert.equal(result.complete, false);
    assert.ok(calls.filter(isPrPage).every((c) => c.variables.first === 50));
  });
}
