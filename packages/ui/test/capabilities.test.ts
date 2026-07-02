import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchCapabilities } from "../src/contract.ts";
import { liveCapabilitiesStatusRows } from "../src/live-capabilities.ts";
import type { ServerCapabilities } from "../src/model.ts";

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
