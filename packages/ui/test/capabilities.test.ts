import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchCapabilities } from "../src/contract.ts";
import { liveCapabilitiesStatusRows } from "../src/live-capabilities.ts";
import type { ServerCapabilities } from "../src/model.ts";
import { loadCapabilities } from "../src/useCapabilities.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capabilities(live: Partial<ServerCapabilities["live"]>): ServerCapabilities {
  return {
    schema: "symphony-board-capabilities/1",
    generated_at: "2026-07-02T12:00:00.000Z",
    server: {
      mode: "docker",
      contract: true,
      range: true,
      stats: true,
    },
    live: {
      reads: false,
      snapshot: false,
      stream: false,
      transport: [],
      provider_webhooks: [],
      status: "unsupported",
      latest_seq: null,
      latest_event_at: null,
      snapshot_generated_at: null,
      ...live,
    },
  };
}

test("fetchCapabilities resolves from the configured Server URL and parses the response", async () => {
  let requested = "";
  globalThis.fetch = (async (url) => {
    requested = String(url);
    return new Response(
      JSON.stringify(
        capabilities({
          reads: true,
          snapshot: true,
          stream: true,
          transport: ["sse"],
          provider_webhooks: ["github"],
          status: "empty",
          allowlist: { enabled: true, count: 12 },
        }),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const got = await fetchCapabilities("https://board.example/base/");
  assert.equal(requested, "https://board.example/base/api/capabilities");
  assert.ok(got);
  assert.equal(got.live.reads, true);
  assert.equal(got.live.status, "empty");
  assert.deepEqual(got.live.allowlist, { enabled: true, count: 12 });
});

test("fetchCapabilities treats a missing or malformed endpoint as unavailable", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as typeof fetch;
  assert.equal(await fetchCapabilities(null), null);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ schema: "other", live: { reads: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  assert.equal(await fetchCapabilities(null), null);
});

test("fetchCapabilities rejects malformed webhook setup metadata", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(
        capabilities({
          reads: true,
          status: "ready",
          webhook_setup: {
            provider: "github",
            public_url: "https://deploy.example/webhooks/github",
            events: "issues",
          } as unknown as ServerCapabilities["live"]["webhook_setup"],
        }),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  assert.equal(await fetchCapabilities(null), null);
});

test("fetchCapabilities aborts a hung request and forwards the desktop connect timeout", async () => {
  let seen: (RequestInit & { connectTimeout?: number }) | undefined;
  globalThis.fetch = (async (_url, init?: RequestInit & { connectTimeout?: number }) => {
    seen = init;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof fetch;

  assert.equal(await fetchCapabilities(null, { requestTimeoutMs: 1, connectTimeoutMs: 2 }), null);
  assert.equal(seen?.connectTimeout, 2);
  assert.equal(seen?.signal?.aborted, true);
});

test("loadCapabilities falls back to the legacy live snapshot endpoint when capabilities are absent", async () => {
  const requested: string[] = [];
  const snapshot = {
    schema: "live-snapshot/1",
    generated_at: "2020-07-02T12:01:00.000Z",
    max_seq: 9,
    events: [
      {
        seq: 9,
        received_at: "2020-07-02T12:00:59.000Z",
        occurred_at: "2020-07-02T12:00:58.000Z",
      },
    ],
  };
  globalThis.fetch = (async (url) => {
    requested.push(String(url));
    if (String(url).includes("/api/capabilities")) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const got = await loadCapabilities("https://board.example/base/");
  assert.deepEqual(requested, [
    "https://board.example/base/api/capabilities",
    "https://board.example/base/api/live-snapshot?limit=1",
  ]);
  assert.ok(got);
  assert.equal(got.live.reads, true);
  assert.equal(got.live.status, "ready");
  assert.equal(got.live.latest_seq, 9);
  assert.equal(got.live.latest_event_at, "2020-07-02T12:00:59.000Z");
  assert.equal(got.live.snapshot_generated_at, "2020-07-02T12:01:00.000Z");
});

test("liveCapabilitiesStatusRows distinguishes unsupported, empty, and latest-event states", () => {
  assert.deepEqual(
    liveCapabilitiesStatusRows(capabilities({ reads: false, status: "unsupported" })).map((row) => row.text),
    ["Live reads unavailable on this server."],
  );

  assert.deepEqual(
    liveCapabilitiesStatusRows(capabilities({ reads: true, snapshot: true, stream: true, transport: ["sse"], status: "empty" })).map((row) => row.text),
    ["Live receiver reachable, no events in retention window."],
  );

  assert.deepEqual(
    liveCapabilitiesStatusRows(
      capabilities({
        reads: true,
        snapshot: true,
        stream: true,
        transport: ["sse"],
        provider_webhooks: ["github"],
        status: "ready",
        latest_seq: 7,
        latest_event_at: "2026-07-02T11:00:00.000Z",
        allowlist: { enabled: true, count: 3 },
        webhook_setup: {
          provider: "github",
          public_url: "https://deploy.example/webhooks/github",
          events: ["issues", "pull_request"],
        },
      }),
    ).map((row) => row.text),
    [
      "Live receiver reachable, latest seq 7 at 2026-07-02T11:00:00.000Z.",
      "Webhook setup hint: github https://deploy.example/webhooks/github (issues, pull_request).",
      "Allowlist enabled for 3 projects.",
    ],
  );
});
