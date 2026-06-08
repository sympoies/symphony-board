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
