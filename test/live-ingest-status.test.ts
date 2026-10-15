// Live receiver ingestion status (GET /api/live-status on the read listener).
// Boots the real listeners on 127.0.0.1:0 with an injected clock and drives
// signed, rejected, and stray webhook requests. Asserts the raw fields an
// external monitor needs: last accepted / rejected delivery times, the rejected
// status, rolling-window counts, and the store's newest received event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openLiveStore } from "../src/live/store.ts";
import { GithubWebhookProvider, GITHUB_SOURCE_ID } from "../src/live/github.ts";
import { createLiveReceiver } from "../src/live/receiver.ts";

const SECRET = "status-secret";

function listen(server: Server): Promise<string> {
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      res(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}
function close(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

function issuesOpened(num: number): Record<string, unknown> {
  return {
    action: "opened",
    issue: {
      number: num,
      node_id: `I_${num}`,
      title: `issue ${num}`,
      html_url: `https://github.com/example/repo/issues/${num}`,
      body: "body",
      updated_at: "2026-06-20T08:00:00Z",
    },
    repository: { full_name: "example/repo", html_url: "https://github.com/example/repo" },
    sender: { login: "reporter", html_url: "https://github.com/reporter" },
  };
}

async function post(
  base: string,
  o: { delivery?: string; secret?: string; path?: string; payload?: unknown },
): Promise<number> {
  const raw = JSON.stringify(o.payload ?? issuesOpened(1));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": "issues",
    "x-hub-signature-256":
      "sha256=" + createHmac("sha256", o.secret ?? SECRET).update(raw).digest("hex"),
  };
  if (o.delivery) headers["x-github-delivery"] = o.delivery;
  const res = await fetch(`${base}${o.path ?? "/webhooks/github"}`, { method: "POST", headers, body: raw });
  await res.arrayBuffer();
  return res.status;
}

async function status(read: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${read}/api/live-status`);
  return { status: res.status, body: await res.json() };
}

test("live-status reports accepted and rejected deliveries with a rolling window", async () => {
  let nowMs = Date.parse("2026-10-15T08:00:00.000Z");
  const store = openLiveStore(":memory:");
  const { webhookServer, readServer, broadcaster } = createLiveReceiver({
    store,
    routes: [{ pathSegment: "github", provider: new GithubWebhookProvider(), sourceId: GITHUB_SOURCE_ID, secrets: [SECRET] }],
    now: () => nowMs,
  });
  const hook = await listen(webhookServer);
  const read = await listen(readServer);
  try {
    const empty = await status(read);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.schema, "live-status/1");
    assert.equal(empty.body.observed_at, "2026-10-15T08:00:00.000Z");
    assert.equal(empty.body.started_at, "2026-10-15T08:00:00.000Z");
    assert.equal(empty.body.window_seconds, 3600);
    assert.deepEqual(empty.body.webhooks, {
      last_accepted_at: null,
      last_rejected_at: null,
      last_rejected_status: null,
      last_rejected_status_class: null,
      accepted_in_window: 0,
      rejected_in_window: 0,
    });
    assert.equal(empty.body.latest_event_received_at, null);

    assert.equal(await post(hook, { delivery: "d-1" }), 202);
    nowMs += 60_000;
    assert.equal(await post(hook, { delivery: "d-2", secret: "wrong" }), 401);
    // Requests without a provider delivery id (scanners) or for an unknown
    // provider are not counted as rejected deliveries.
    assert.equal(await post(hook, { secret: "wrong" }), 401);
    assert.equal(await post(hook, { delivery: "d-3", path: "/webhooks/unknown" }), 404);

    const after = await status(read);
    assert.equal(after.body.webhooks.last_accepted_at, "2026-10-15T08:00:00.000Z");
    assert.equal(after.body.webhooks.last_rejected_at, "2026-10-15T08:01:00.000Z");
    assert.equal(after.body.webhooks.last_rejected_status, 401);
    assert.equal(after.body.webhooks.last_rejected_status_class, "4xx");
    assert.equal(after.body.webhooks.accepted_in_window, 1);
    assert.equal(after.body.webhooks.rejected_in_window, 1);
    assert.match(after.body.latest_event_received_at, /^\d{4}-\d\d-\d\dT/);

    // Counts age out of the one-hour window; last-seen times persist.
    nowMs += 61 * 60_000;
    const aged = await status(read);
    assert.equal(aged.body.webhooks.accepted_in_window, 0);
    assert.equal(aged.body.webhooks.rejected_in_window, 0);
    assert.equal(aged.body.webhooks.last_accepted_at, "2026-10-15T08:00:00.000Z");
    assert.equal(aged.body.webhooks.last_rejected_status, 401);
  } finally {
    broadcaster.closeAll();
    await close(webhookServer);
    await close(readServer);
    store.close();
  }
});

test("live-status is served only on the read listener", async () => {
  const store = openLiveStore(":memory:");
  const { webhookServer, readServer, broadcaster } = createLiveReceiver({
    store,
    routes: [{ pathSegment: "github", provider: new GithubWebhookProvider(), sourceId: GITHUB_SOURCE_ID, secrets: [SECRET] }],
  });
  const hook = await listen(webhookServer);
  const read = await listen(readServer);
  try {
    assert.equal((await fetch(`${hook}/api/live-status`)).status, 404);
    assert.equal((await fetch(`${read}/api/live-status`)).status, 200);
  } finally {
    broadcaster.closeAll();
    await close(webhookServer);
    await close(readServer);
    store.close();
  }
});
