import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { defaultRestUrl, makeRestClient } from "../src/sources/rest.ts";

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

test("defaultRestUrl derives provider REST bases from kind and host", () => {
  assert.equal(defaultRestUrl("github", "github.com"), "https://api.github.com");
  assert.equal(defaultRestUrl("github", "github.example.com"), "https://github.example.com/api/v3");
  assert.equal(defaultRestUrl("gitlab", "gitlab.example.com"), "https://gitlab.example.com/api/v4");
  assert.equal(defaultRestUrl("other", "provider.example.com"), "https://provider.example.com");
});

test("makeRestClient sends GitHub auth headers and filters empty query params", async () => {
  let seenUrl: URL | undefined;
  let seenHeaders: Record<string, string> = {};
  mockFetch((url, init) => {
    seenUrl = url;
    seenHeaders = init.headers as Record<string, string>;
    return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
  });

  const client = makeRestClient("https://api.github.com/", "gh-token", "github");
  const data = await client<Array<{ ok: boolean }>>("repos/o/r/commits", {
    per_page: 100,
    page: 2,
    include: true,
    skip: null,
    omit: undefined,
  });

  assert.deepEqual(data, [{ ok: true }]);
  assert.ok(seenUrl);
  assert.equal(seenUrl.href, "https://api.github.com/repos/o/r/commits?per_page=100&page=2&include=true");
  assert.equal(seenHeaders.Authorization, "Bearer gh-token");
  assert.equal(seenHeaders.Accept, "application/vnd.github+json");
  assert.equal(seenHeaders["X-GitHub-Api-Version"], "2022-11-28");
});

test("makeRestClient sends GitLab token headers", async () => {
  let seenHeaders: Record<string, string> = {};
  mockFetch((_url, init) => {
    seenHeaders = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const client = makeRestClient("https://gitlab.example.com/api/v4", "gl-token", "gitlab");
  const data = await client<{ ok: boolean }>("projects/1/events");

  assert.deepEqual(data, { ok: true });
  assert.equal(seenHeaders["PRIVATE-TOKEN"], "gl-token");
  assert.equal(seenHeaders.Authorization, undefined);
});

test("makeRestClient reports non-JSON and HTTP failures", async () => {
  mockFetch(() => new Response("not-json", { status: 200 }));
  const client = makeRestClient("https://api.github.com", "tok", "github");
  await assert.rejects(() => client("repos/o/r/commits"), /non-JSON response/);

  mockFetch(() => new Response(JSON.stringify({ message: "rate limited" }), { status: 403 }));
  await assert.rejects(() => client("repos/o/r/commits"), /REST HTTP 403: rate limited/);
});

test("makeRestClient aborts a stalled request after the timeout", { timeout: 2000 }, async () => {
  // A socket that hangs (e.g. half-up network/VPN right after the Mac wakes):
  // the mock respects the abort signal but otherwise never settles.
  mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const client = makeRestClient("https://api.github.com", "tok", "github", 50);
  await assert.rejects(() => client("repos/o/r/commits"), /timed out after 50ms/);
});

test("GitHub REST primary rate limit rotates to the next token for the same request", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    if (auths.length === 1) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1770000000" },
      });
    }
    return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
  });

  const client = makeRestClient("https://api.github.com", [
    { env: "GITHUB_TOKEN", value: "primary" },
    { env: "GITHUB_TOKEN_BACKUP", value: "backup" },
  ], "github");

  assert.deepEqual(await client("repos/o/r/commits"), [{ ok: true }]);
  assert.deepEqual(auths, ["Bearer primary", "Bearer backup"]);
});

test("once every token is cooled down, the REST client stops hammering them", async () => {
  // #222 follow-up: mirror of the GraphQL guard — when every token in the pool
  // has been primary-rate-limited, the REST client must short-circuit rather
  // than send another doomed request with a known-cooled-down PAT.
  let calls = 0;
  mockFetch(() => {
    calls++;
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
    });
  });

  const client = makeRestClient("https://api.github.com", [
    { env: "GITHUB_TOKEN", value: "primary" },
    { env: "GITHUB_TOKEN_BACKUP", value: "backup" },
  ], "github");

  await assert.rejects(() => client("repos/o/r/commits"));
  assert.equal(calls, 2, "first call tries both tokens once each");

  await assert.rejects(() => client("repos/o/r/commits"), /rate-limited/);
  assert.equal(calls, 2, "no further request once all tokens are cooled down");
});

test("a single-token GitHub REST client cools down after a primary rate limit", async () => {
  // #225 follow-up (mirror of the GraphQL guard): a single-token REST client
  // must record the cooldown too, so the next request short-circuits instead of
  // re-sending the exhausted PAT.
  let calls = 0;
  mockFetch(() => {
    calls++;
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
    });
  });

  const client = makeRestClient("https://api.github.com", "only-token", "github");

  await assert.rejects(() => client("repos/o/r/commits"));
  assert.equal(calls, 1, "first call hits the single token once");

  await assert.rejects(() => client("repos/o/r/commits"), /rate-limited/);
  assert.equal(calls, 1, "no further request after the single token is cooled down");
});

test("GitHub REST secondary rate limit does not rotate PATs", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "10", "retry-after": "60" },
    });
  });

  const client = makeRestClient("https://api.github.com", [
    { env: "GITHUB_TOKEN", value: "primary" },
    { env: "GITHUB_TOKEN_BACKUP", value: "backup" },
  ], "github");

  await assert.rejects(() => client("repos/o/r/commits"), /secondary rate limit/);
  assert.deepEqual(auths, ["Bearer primary"]);
});

test("GitHub REST fallback repo-access failures identify the fallback token", async () => {
  const auths: Array<string | undefined> = [];
  mockFetch((_url, init) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    if (auths.length === 1) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1770000000" },
      });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  });

  const client = makeRestClient("https://api.github.com", [
    { env: "GITHUB_TOKEN", value: "primary" },
    { env: "GITHUB_TOKEN_BACKUP", value: "backup" },
  ], "github");

  await assert.rejects(() => client("repos/o/private/commits"), /fallback token lacks repo access/);
  assert.deepEqual(auths, ["Bearer primary", "Bearer backup"]);
});
