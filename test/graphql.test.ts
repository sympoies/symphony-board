import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { makeGqlClient } from "../src/sources/graphql.ts";
import { resetAuthTokenSelectionStateForTests } from "../src/sources/http.ts";

// Every GraphQL request both providers make funnels through makeGqlClient, so
// these tests lock the shared wire format and — more importantly — the error
// semantics the sync engine's deletion invariant leans on: ANY GraphQL-level
// failure throws, the engine records the source as failed, and a failed source
// never tombstones (see test/sync-engine.test.ts).

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const originalAuthTrace = process.env.SYNC_AUTH_TRACE;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  if (originalAuthTrace === undefined) delete process.env.SYNC_AUTH_TRACE;
  else process.env.SYNC_AUTH_TRACE = originalAuthTrace;
  resetAuthTokenSelectionStateForTests();
});

function mockFetch(fn: (url: URL, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    return fn(url, init ?? {});
  }) as typeof fetch;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function graphqlBudgetResponse(remaining: number): Response {
  return new Response(JSON.stringify({
    data: {
      ok: true,
      rateLimit: {
        limit: 1000,
        remaining,
        used: 1000 - remaining,
        cost: 1,
        resetAt: "2286-11-20T17:46:39.000Z",
      },
    },
  }), { status: 200 });
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

test("GitHub GraphQL budget-aware bot tokens probe unknown budgets across bots", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a", kind: "github_app", name: "example-bot-a", strategy: "budget_aware" },
    { env: "github_app:BOT_B_INSTALLATION_ID", value: "bot-b", kind: "github_app", name: "example-bot-b", strategy: "budget_aware" },
  ]);

  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(auths, ["Bearer bot-a", "Bearer bot-b", "Bearer bot-a"]);
});

test("new GitHub GraphQL clients rotate their initial unknown-budget probe cursor", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  });
  const tokens = [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a", kind: "github_app" as const, strategy: "budget_aware" as const },
    { env: "github_app:BOT_B_INSTALLATION_ID", value: "bot-b", kind: "github_app" as const, strategy: "budget_aware" as const },
  ];

  const firstClient = makeGqlClient("https://api.github.com/graphql", tokens);
  const secondClient = makeGqlClient("https://api.github.com/graphql", tokens);

  assert.deepEqual(await firstClient("query { x }"), { ok: true });
  assert.deepEqual(await secondClient("query { x }"), { ok: true });
  assert.deepEqual(auths, ["Bearer bot-a", "Bearer bot-b"]);
});

test("GitHub GraphQL budget-aware bot tokens prefer the largest observed remaining budget", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    auths.push(auth);
    const remaining = auth === "Bearer bot-a" ? "100" : "900";
    const used = String(1000 - Number(remaining));
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: {
        "x-ratelimit-limit": "1000",
        "x-ratelimit-remaining": remaining,
        "x-ratelimit-used": used,
        "x-ratelimit-reset": "9999999999",
        "x-ratelimit-resource": "graphql",
      },
    });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a", kind: "github_app", name: "example-bot-a", strategy: "budget_aware" },
    { env: "github_app:BOT_B_INSTALLATION_ID", value: "bot-b", kind: "github_app", name: "example-bot-b", strategy: "budget_aware" },
  ]);

  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(await gql("query { x }"), { ok: true });
  assert.deepEqual(auths, ["Bearer bot-a", "Bearer bot-b", "Bearer bot-b"]);
});

test("GitHub GraphQL budget-aware bot tokens read rateLimit budget from the response body", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    auths.push(auth);
    return graphqlBudgetResponse(auth === "Bearer bot-a" ? 100 : 900);
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a", kind: "github_app", name: "example-bot-a", strategy: "budget_aware" },
    { env: "github_app:BOT_B_INSTALLATION_ID", value: "bot-b", kind: "github_app", name: "example-bot-b", strategy: "budget_aware" },
  ]);

  assert.equal((await gql<{ ok: boolean }>("query { x }")).ok, true);
  assert.equal((await gql<{ ok: boolean }>("query { x }")).ok, true);
  assert.equal((await gql<{ ok: boolean }>("query { x }")).ok, true);
  assert.deepEqual(auths, ["Bearer bot-a", "Bearer bot-b", "Bearer bot-b"]);
});

test("GitHub GraphQL budget-aware bot tokens account for in-flight request cost", async () => {
  const auths: Array<string | undefined> = [];
  const heldBotA = deferred<Response>();
  mockFetch((_url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    auths.push(auth);
    if (auths.length === 3) return heldBotA.promise;
    return graphqlBudgetResponse(500);
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a", kind: "github_app", name: "example-bot-a", strategy: "budget_aware" },
    { env: "github_app:BOT_B_INSTALLATION_ID", value: "bot-b", kind: "github_app", name: "example-bot-b", strategy: "budget_aware" },
  ]);

  assert.equal((await gql<{ ok: boolean }>("query { seedA }")).ok, true);
  assert.equal((await gql<{ ok: boolean }>("query { seedB }")).ok, true);
  assert.deepEqual(auths, ["Bearer bot-a", "Bearer bot-b"]);

  const first = gql<{ ok: boolean }>("query { concurrentA }");
  assert.equal(auths[2], "Bearer bot-a");
  const second = gql<{ ok: boolean }>("query { concurrentB }");
  assert.equal(auths[3], "Bearer bot-b");

  heldBotA.resolve(graphqlBudgetResponse(500));
  assert.deepEqual((await Promise.all([first, second])).map((value) => value.ok), [true, true]);

  assert.equal((await gql<{ ok: boolean }>("query { afterRelease }")).ok, true);
  assert.equal(auths[4], "Bearer bot-a", "released in-flight state lets bot-a win the next tie again");
});

test("GitHub GraphQL budget cache does not stale-block a replaced token with the same env label", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    auths.push(auth);
    if (auth === "Bearer bot-old") {
      return new Response(JSON.stringify({ data: null, errors: [{ message: "API rate limit exceeded" }] }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
      });
    }
    return graphqlBudgetResponse(500);
  });

  const oldClient = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_INSTALLATION_ID", value: "bot-old", kind: "github_app", name: "example-bot", strategy: "budget_aware" },
  ]);
  await assert.rejects(() => oldClient("query { x }"), /rate limit/);

  const newClient = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_INSTALLATION_ID", value: "bot-new", kind: "github_app", name: "example-bot", strategy: "budget_aware" },
  ]);
  assert.equal((await newClient<{ ok: boolean }>("query { x }")).ok, true);
  assert.deepEqual(auths, ["Bearer bot-old", "Bearer bot-new"]);
});

test("GitHub GraphQL diagnostics clients do not clear another client's budget state", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    auths.push(auth);
    if (auth === "Bearer pat") {
      return new Response(JSON.stringify({
        data: {
          viewer: { login: "operator" },
          rateLimit: { limit: 5000, remaining: 4999, used: 1, cost: 1, resetAt: "2286-11-20T17:46:39.000Z" },
        },
      }), { status: 200 });
    }
    return graphqlBudgetResponse(auth === "Bearer bot-a" ? 100 : 900);
  });

  const syncClient = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a", kind: "github_app", name: "example-bot-a", strategy: "budget_aware" },
    { env: "github_app:BOT_B_INSTALLATION_ID", value: "bot-b", kind: "github_app", name: "example-bot-b", strategy: "budget_aware" },
  ]);
  assert.equal((await syncClient<{ ok: boolean }>("query { seedA }")).ok, true);
  assert.equal((await syncClient<{ ok: boolean }>("query { seedB }")).ok, true);

  const diagnosticsProbe = makeGqlClient("https://api.github.com/graphql", [
    { env: "GH_PAT", value: "pat", kind: "pat", strategy: "failover" },
  ], { provider: "github" });
  await diagnosticsProbe("query { viewer { login } rateLimit { limit cost remaining used resetAt } }");

  assert.equal((await syncClient<{ ok: boolean }>("query { afterProbe }")).ok, true);
  assert.deepEqual(auths, ["Bearer bot-a", "Bearer bot-b", "Bearer pat", "Bearer bot-b"]);
});

test("GitHub GraphQL auth trace logs token labels without token values", async () => {
  const lines: string[] = [];
  process.env.SYNC_AUTH_TRACE = "1";
  console.log = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof console.log;
  mockFetch(() => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A_INSTALLATION_ID", value: "bot-a-secret", kind: "github_app", name: "bot-a", strategy: "budget_aware" },
  ]);

  assert.deepEqual(await gql("query($owner:String!, $name:String!) { repository(owner:$owner, name:$name) { issues(first:1) { nodes { id } } } }", {
    owner: "sympoies",
    name: "symphony-board",
  }), { ok: true });
  const trace = lines.find((line) => line.includes("[auth-trace]"));
  assert.ok(trace, "auth trace should emit one log line");
  assert.match(trace, /token=github_app:BOT_A_INSTALLATION_ID/);
  assert.match(trace, /repo=sympoies\/symphony-board/);
  assert.match(trace, /op=issues/);
  assert.doesNotMatch(trace, /bot-a-secret/);
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

test("bot_then_pat retry prefers an available bot over the PAT before exhausting the bot pool", async () => {
  // Pool order [botA(budget_aware), botB(budget_aware), PAT(failover)]. The
  // unknown-budget probe selects botB on the 2nd request; when botB hits a
  // primary rate limit, the retry must rotate to the still-available botA, NOT
  // spend PAT quota while a bot is available.
  const auths: Array<string | undefined> = [];
  let botBLimited = false;
  mockFetch((_url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    auths.push(auth);
    if (auth === "Bearer botB" && !botBLimited) {
      botBLimited = true;
      return new Response(JSON.stringify({ data: null, errors: [{ message: "API rate limit exceeded" }] }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
      });
    }
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  });

  const gql = makeGqlClient("https://api.github.com/graphql", [
    { env: "github_app:BOT_A", value: "botA", kind: "github_app", strategy: "budget_aware" },
    { env: "github_app:BOT_B", value: "botB", kind: "github_app", strategy: "budget_aware" },
    { env: "GH_PAT", value: "pat", kind: "pat", strategy: "failover" },
  ]);

  assert.deepEqual(await gql("query { x }"), { ok: true }); // call 1 -> botA
  assert.deepEqual(await gql("query { x }"), { ok: true }); // call 2 -> botB (rate-limited) -> retry

  assert.deepEqual(auths, ["Bearer botA", "Bearer botB", "Bearer botA"]);
  assert.ok(!auths.includes("Bearer pat"), "PAT must not be used while a bot is still available");
});
