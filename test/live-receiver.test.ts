// Acceptance for the least-privilege live receiver. Boots the real servers on
// 127.0.0.1:0 (modeled on app-server.test.ts) and drives signed webhook
// deliveries, the SSE stream, the snapshot, and healthz. Network-free (loopback
// inbound only). The receiver is split into two listeners that share one store +
// broadcaster: a public webhook listener (POST /webhooks/*) and a tailnet-only
// read listener (/api/live*). Asserts: append-before-202-ack, dedupe + no
// redelivery rebroadcast, multi-event ordinals, ping, signature rejection, SSE
// framing + ?since replay + the reset/gap sentinel, listener isolation, a
// malformed Host header, the 4xx error branches, the project allowlist, the body
// cap, and the hard isolation invariant (no canonical store / token / config).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openLiveStore, type LiveStore } from "../src/live/store.ts";
import { GithubWebhookProvider, GITHUB_SOURCE_ID } from "../src/live/github.ts";
import {
  createLiveReceiver,
  type ProviderRoute,
} from "../src/live/receiver.ts";
import { headerValue, type WebhookProvider } from "../src/live/provider.ts";
import type { LiveEvent, LiveEventInput } from "../src/live/types.ts";
import type { VerifyResult } from "../src/live/verify.ts";

const SECRET = "shhh-secret";

function listen(server: Server): Promise<string> {
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      res(`http://127.0.0.1:${addr.port}`);
    });
  });
}
function close(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  attempts = 200,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}

interface Built {
  store: LiveStore;
  webhookServer: Server;
  readServer: Server;
  broadcaster: { closeAll(): void };
}
function build(
  opts: {
    allowlist?: string[];
    maxBodyBytes?: number;
    replayLimit?: number;
    routes?: ProviderRoute[];
    actorProfiles?: { observe(event: LiveEvent, onUpdate?: (event: LiveEvent) => void): void };
  } = {},
): Built {
  const store = openLiveStore(":memory:");
  const { webhookServer, readServer, broadcaster } = createLiveReceiver({
    store,
    routes: opts.routes ?? [
      {
        pathSegment: "github",
        provider: new GithubWebhookProvider(),
        sourceId: GITHUB_SOURCE_ID,
        secrets: [SECRET],
      },
    ],
    projectAllowlist: opts.allowlist,
    maxBodyBytes: opts.maxBodyBytes,
    replayLimit: opts.replayLimit,
    actorProfiles: opts.actorProfiles,
  });
  return { store, webhookServer, readServer, broadcaster };
}
async function start(b: Built): Promise<{ hook: string; read: string }> {
  return { hook: await listen(b.webhookServer), read: await listen(b.readServer) };
}
async function stop(b: Built): Promise<void> {
  await close(b.webhookServer);
  await close(b.readServer);
  b.store.close();
}

function issuesOpened(num: number): Record<string, unknown> {
  return {
    action: "opened",
    issue: {
      number: num,
      node_id: `I_${num}`,
      title: `issue ${num}`,
      html_url: `https://github.com/sympoies/symphony-board/issues/${num}`,
      body: "body text",
      updated_at: "2026-06-20T08:00:00Z",
    },
    repository: {
      full_name: "sympoies/symphony-board",
      html_url: "https://github.com/sympoies/symphony-board",
    },
    sender: { login: "reporter", html_url: "https://github.com/reporter" },
  };
}

async function postDelivery(
  base: string,
  o: {
    event: string;
    delivery: string;
    payload: unknown;
    secret?: string;
    signed?: boolean;
    omitDelivery?: boolean;
    rawBody?: string;
  },
): Promise<Response> {
  const raw = o.rawBody ?? JSON.stringify(o.payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": o.event,
    "x-github-hook-id": "hook-1",
  };
  if (!o.omitDelivery) headers["x-github-delivery"] = o.delivery;
  if (o.signed ?? true) {
    headers["x-hub-signature-256"] =
      "sha256=" + createHmac("sha256", o.secret ?? SECRET).update(raw).digest("hex");
  }
  return fetch(`${base}/webhooks/github`, { method: "POST", headers, body: raw });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getJson(base: string, path: string): Promise<any> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as unknown };
}

function openSse(base: string, path: string, frames: string[]) {
  const url = new URL(path, base);
  const req = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          frames.push(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      });
    },
  );
  req.end();
  return req;
}

function dataSeqs(frames: string[]): number[] {
  return frames
    .filter((f) => f.includes("data:") && f.includes("event: live"))
    .map((f) => {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse((line ?? "data: {}").slice(6)).seq as number;
    });
}

function dataEvents(frames: string[]): LiveEvent[] {
  return frames
    .filter((f) => f.includes("data:") && f.includes("event: live"))
    .map((f) => {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse((line ?? "data: {}").slice(6)) as LiveEvent;
    });
}

// Raw GET so a custom (possibly malformed) Host header can be set, which fetch
// will not permit. Resolves the status code, or 0 on a connection error.
function rawGet(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = new URL(base);
  return new Promise((resolveStatus) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path, method: "GET", headers },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      },
    );
    req.on("error", () => resolveStatus(0));
    req.end();
  });
}

test("a valid signed delivery is stored once and a redelivery is a no-op", async () => {
  const b = build();
  const { hook } = await start(b);
  try {
    const r1 = await postDelivery(hook, {
      event: "issues",
      delivery: "d-1",
      payload: issuesOpened(1),
    });
    assert.equal(r1.status, 202);
    assert.equal(b.store.recent(100).length, 1, "stored exactly once before ack");
    const r2 = await postDelivery(hook, {
      event: "issues",
      delivery: "d-1",
      payload: issuesOpened(1),
    });
    assert.equal(r2.status, 202);
    assert.equal(b.store.recent(100).length, 1, "redelivery stored nothing");
  } finally {
    await stop(b);
  }
});

test("actor profile observation runs after a successful append without blocking the ack", async () => {
  let resolveObserved!: (event: LiveEvent) => void;
  const observed = new Promise<LiveEvent>((resolve) => {
    resolveObserved = resolve;
  });
  const b = build({
    actorProfiles: {
      observe(event) {
        resolveObserved(event);
      },
    },
  });
  const { hook } = await start(b);
  try {
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "d-profile",
      payload: issuesOpened(1),
    });
    assert.equal(res.status, 202);
    const seen = await observed;
    assert.equal(seen.actor?.login, "reporter");
    assert.equal(b.store.recent(100).length, 1);
  } finally {
    await stop(b);
  }
});

test("actor profile observer failures never reject a webhook delivery", async () => {
  const b = build({
    actorProfiles: {
      observe() {
        throw new Error("profile lookup failed");
      },
    },
  });
  const { hook } = await start(b);
  try {
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "d-profile-fail",
      payload: issuesOpened(1),
    });
    assert.equal(res.status, 202);
    assert.equal(b.store.recent(100).length, 1);
  } finally {
    await stop(b);
  }
});

test("actor profile observer updates are broadcast as same-seq replacements", async () => {
  const b = build({
    actorProfiles: {
      observe(event, onUpdate) {
        setTimeout(() => {
          onUpdate?.({
            ...event,
            actor: {
              ...(event.actor ?? {}),
              login: event.actor?.login ?? null,
              avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
              profile_url: "https://github.com/reporter",
            },
          });
        }, 0);
      },
    },
  });
  const { hook, read } = await start(b);
  const frames: string[] = [];
  const sse = openSse(read, "/api/live", frames);
  try {
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "d-profile-update",
      payload: issuesOpened(1),
    });
    assert.equal(res.status, 202);
    await until(() => dataEvents(frames).length >= 2);
    const events = dataEvents(frames);
    assert.equal(events[1]?.seq, events[0]?.seq);
    assert.equal(events[0]?.actor?.avatar_url ?? null, null);
    assert.equal(events[1]?.actor?.avatar_url, "https://avatars.githubusercontent.com/u/1?v=4");
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("an invalid signature is rejected and stores nothing", async () => {
  const b = build();
  const { hook } = await start(b);
  try {
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "d-bad",
      payload: issuesOpened(1),
      secret: "wrong-secret",
    });
    assert.equal(res.status, 401);
    assert.equal(b.store.recent(100).length, 0);
    const missing = await postDelivery(hook, {
      event: "issues",
      delivery: "d-bad2",
      payload: issuesOpened(1),
      signed: false,
    });
    assert.equal(missing.status, 401);
    assert.equal(b.store.recent(100).length, 0);
  } finally {
    await stop(b);
  }
});

test("a ping is acked 200 and stores nothing", async () => {
  const b = build();
  const { hook } = await start(b);
  try {
    const res = await postDelivery(hook, {
      event: "ping",
      delivery: "d-ping",
      payload: { zen: "Keep it logically awesome." },
    });
    assert.equal(res.status, 200);
    assert.equal(b.store.recent(100).length, 0);
  } finally {
    await stop(b);
  }
});

test("a verified body that is not JSON is rejected 400 invalid_json", async () => {
  const b = build();
  const { hook } = await start(b);
  try {
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "d-nojson",
      payload: null,
      rawBody: "this is not json{",
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error?: string }).error, "invalid_json");
    assert.equal(b.store.recent(100).length, 0);
  } finally {
    await stop(b);
  }
});

test("a verified non-ping delivery without a delivery id is rejected 400", async () => {
  const b = build();
  const { hook } = await start(b);
  try {
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "unused",
      payload: issuesOpened(1),
      omitDelivery: true,
    });
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error?: string }).error,
      "missing_delivery_id",
    );
    assert.equal(b.store.recent(100).length, 0);
  } finally {
    await stop(b);
  }
});

test("an unknown provider path segment is rejected 404", async () => {
  const b = build();
  const { hook } = await start(b);
  try {
    const res = await fetch(`${hook}/webhooks/gitlab`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error?: string }).error, "unknown_provider");
  } finally {
    await stop(b);
  }
});

test("the snapshot returns recent events newest-first plus max_seq", async () => {
  const b = build();
  const { hook, read } = await start(b);
  try {
    await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
    await postDelivery(hook, { event: "issues", delivery: "d-2", payload: issuesOpened(2) });
    const { status, body } = await getJson(read, "/api/live-snapshot?limit=10");
    assert.equal(status, 200);
    const snap = body as { schema: string; events: { seq: number }[]; max_seq: number };
    assert.equal(snap.schema, "live-snapshot/1");
    assert.equal(snap.max_seq, 2);
    assert.deepEqual(snap.events.map((e) => e.seq), [2, 1]);
  } finally {
    await stop(b);
  }
});

test("healthz returns 200 on both listeners", async () => {
  const b = build();
  const { hook, read } = await start(b);
  try {
    assert.equal((await fetch(`${read}/healthz`)).status, 200);
    assert.equal((await fetch(`${hook}/healthz`)).status, 200);
  } finally {
    await stop(b);
  }
});

test("the listeners are isolated: reads are 404 on the webhook port and vice versa", async () => {
  const b = build();
  const { hook, read } = await start(b);
  try {
    // The public webhook listener exposes no read routes.
    assert.equal((await fetch(`${hook}/api/live-snapshot`)).status, 404);
    assert.equal((await fetch(`${hook}/api/live`)).status, 404);
    // The read listener accepts no webhook POSTs.
    const wh = await fetch(`${read}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(wh.status, 404);
  } finally {
    await stop(b);
  }
});

test("a malformed Host header does not crash the receiver (#316 item 1)", async () => {
  const b = build();
  const { read } = await start(b);
  try {
    const status = await rawGet(read, "/healthz", { Host: "::::bad::::" });
    assert.equal(status, 200, "fixed parse base ignores a syntactically bad Host");
  } finally {
    await stop(b);
  }
});

test("an oversized body is rejected with 413 before verification", async () => {
  const b = build({ maxBodyBytes: 64 });
  const { hook } = await start(b);
  try {
    const big = { action: "opened", filler: "x".repeat(500) };
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "d-big",
      payload: big,
    });
    assert.equal(res.status, 413);
    assert.equal(b.store.recent(100).length, 0);
  } finally {
    await stop(b);
  }
});

test("SSE streams a broadcast after connect and frames are exactly id:-tagged", async () => {
  const b = build();
  const { hook, read } = await start(b);
  const frames: string[] = [];
  const sse = openSse(read, "/api/live", frames);
  try {
    await until(() => frames.some((f) => f.includes("retry")));
    const res = await postDelivery(hook, {
      event: "issues",
      delivery: "d-1",
      payload: issuesOpened(1),
    });
    assert.equal(res.status, 202);
    await until(() => frames.some((f) => f.includes("data:")));
    const dataFrame = frames.find((f) => f.includes("data:")) ?? "";
    // Tight match: `includes("id: 1")` would also accept `id: 10`.
    assert.match(dataFrame, /(^|\n)id: 1\n/, "frame carries the exact id: <seq>");
    assert.ok(dataFrame.includes("event: live"));
    assert.deepEqual(dataSeqs(frames), [1]);
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("a redelivery is not rebroadcast to live SSE subscribers", async () => {
  const b = build();
  const { hook, read } = await start(b);
  const frames: string[] = [];
  const sse = openSse(read, "/api/live", frames);
  try {
    await until(() => frames.some((f) => f.includes("retry")));
    await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
    await until(() => dataSeqs(frames).length === 1);
    // Same delivery id again: appends nothing new, so nothing is rebroadcast.
    await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(dataSeqs(frames), [1], "redelivery produced no new frame");
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("a multi-event delivery appends each event with its own ordinal and seq", async () => {
  // A provider that yields two events for one delivery exercises the ordinal
  // path (GitHub adapts 1:1; GitLab push fan-out is the real multi-event case).
  const provider: WebhookProvider = {
    id: "github",
    eventHeaderName: "x-test-event",
    hookIdHeaderName: null,
    verify(): VerifyResult {
      return { ok: true };
    },
    deliveryId(headers: IncomingHttpHeaders): string | null {
      return headerValue(headers, "x-test-delivery");
    },
    isControlEvent(): boolean {
      return false;
    },
    toLiveEvents(): LiveEventInput[] {
      const mk = (n: number): LiveEventInput => ({
        event_id: "multi-1",
        source_id: GITHUB_SOURCE_ID,
        provider: "github",
        received_at: "2026-06-20T00:00:00Z",
        event_type: "push",
        category: "push",
        title: `commit ${n}`,
        delivery: {
          delivery_id: "multi-1",
          event_header: "push",
          signature_status: "verified",
        },
      });
      return [mk(1), mk(2)];
    },
  };
  const b = build({
    routes: [
      { pathSegment: "test", provider, sourceId: GITHUB_SOURCE_ID, secrets: [] },
    ],
  });
  const { hook } = await start(b);
  try {
    const res = await fetch(`${hook}/webhooks/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-delivery": "multi-1" },
      body: "{}",
    });
    assert.equal(res.status, 202);
    const rows = b.store.recent(100);
    assert.equal(rows.length, 2, "both ordinals stored");
    assert.deepEqual(
      rows.map((r) => r.seq).sort((a, c) => a - c),
      [1, 2],
    );
    // A redelivery of the same multi-event delivery is fully deduped.
    await fetch(`${hook}/webhooks/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-delivery": "multi-1" },
      body: "{}",
    });
    assert.equal(b.store.recent(100).length, 2, "redelivery added nothing");
  } finally {
    await stop(b);
  }
});

test("SSE ?since replays only events after the cursor", async () => {
  const b = build();
  const { hook, read } = await start(b);
  await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
  await postDelivery(hook, { event: "issues", delivery: "d-2", payload: issuesOpened(2) });
  const frames: string[] = [];
  const sse = openSse(read, "/api/live?since=1", frames);
  try {
    await until(() => frames.some((f) => f.includes("data:")));
    assert.deepEqual(dataSeqs(frames), [2]);
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("SSE emits a reset sentinel when the cursor is ahead of the store", async () => {
  const b = build();
  const { hook, read } = await start(b);
  await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
  const frames: string[] = [];
  // Cursor 99 is far ahead of max_seq 1 (restart / heavy prune below cursor).
  const sse = openSse(read, "/api/live?since=99", frames);
  try {
    await until(() => frames.some((f) => f.includes("event: reset")));
    const reset = frames.find((f) => f.includes("event: reset")) ?? "";
    const data = JSON.parse(
      (reset.split("\n").find((l) => l.startsWith("data: ")) ?? "data: {}").slice(6),
    );
    assert.equal(data.reason, "stale_cursor");
    assert.equal(data.max_seq, 1);
    assert.deepEqual(dataSeqs(frames), [], "no stale replay alongside a reset");
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("SSE emits a gap reset when the backlog exceeds the replay limit", async () => {
  const b = build({ replayLimit: 2 });
  const { hook, read } = await start(b);
  for (let i = 1; i <= 5; i++) {
    await postDelivery(hook, { event: "issues", delivery: `d-${i}`, payload: issuesOpened(i) });
  }
  const frames: string[] = [];
  const sse = openSse(read, "/api/live?since=0", frames);
  try {
    await until(() => frames.some((f) => f.includes("event: reset")));
    const reset = frames.find((f) => f.includes("event: reset")) ?? "";
    const data = JSON.parse(
      (reset.split("\n").find((l) => l.startsWith("data: ")) ?? "data: {}").slice(6),
    );
    assert.equal(data.reason, "gap");
    assert.equal(data.max_seq, 5);
    assert.deepEqual(dataSeqs(frames), [], "gap signalled instead of a partial replay");
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("the project allowlist drops out-of-scope org repos", async () => {
  const b = build({ allowlist: ["sympoies/symphony-board"] });
  const { hook } = await start(b);
  try {
    const otherRepo = issuesOpened(9);
    (otherRepo.repository as Record<string, unknown>).full_name = "sympoies/unrelated";
    const dropped = await postDelivery(hook, {
      event: "issues",
      delivery: "d-other",
      payload: otherRepo,
    });
    assert.equal(dropped.status, 204);
    assert.equal(b.store.recent(100).length, 0, "out-of-scope repo not stored");
    const kept = await postDelivery(hook, {
      event: "issues",
      delivery: "d-mine",
      payload: issuesOpened(1),
    });
    assert.equal(kept.status, 202);
    assert.equal(b.store.recent(100).length, 1);
  } finally {
    await stop(b);
  }
});

test("the webhook secret never lands in a stored event", async () => {
  const b = build();
  const { hook } = await start(b);
  try {
    await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
    const dump = JSON.stringify(b.store.recent(100));
    assert.equal(dump.includes(SECRET), false);
  } finally {
    await stop(b);
  }
});

test("the webhook listener bounds ingress; the read listener disables the request timeout for SSE", () => {
  const b = build();
  try {
    // Public webhook ingress is bounded (flood control); long-lived SSE reads are
    // not cut by a per-request timeout.
    assert.equal(b.webhookServer.requestTimeout, 30_000);
    assert.equal(b.webhookServer.headersTimeout, 15_000);
    assert.equal(b.webhookServer.maxConnections, 256);
    assert.equal(
      b.readServer.requestTimeout,
      0,
      "an SSE stream must not be killed by a request timeout",
    );
  } finally {
    b.store.close();
  }
});

test("a new delivery is broadcast from memory identical to its stored row, hook_id threaded", async () => {
  const b = build();
  const { hook, read } = await start(b);
  const frames: string[] = [];
  const sse = openSse(read, "/api/live", frames);
  try {
    await until(() => frames.some((f) => f.includes("retry")));
    await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
    await until(() => dataSeqs(frames).length === 1);
    const frame = frames.find((f) => f.includes("event: live")) ?? "";
    const line = frame.split("\n").find((l) => l.startsWith("data: ")) ?? "data: {}";
    const broadcast = JSON.parse(line.slice(6));
    const stored = b.store.recent(1)[0];
    assert.ok(stored);
    // Broadcast-from-memory parity: the SSE frame is the exact stored row (would
    // break if the receiver reverted to a divergent re-query), and the hook id
    // header is threaded into the persisted delivery.
    assert.deepEqual(broadcast, stored);
    assert.equal(broadcast.delivery.hook_id, "hook-1");
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("live events keep streaming on the same connection after a reset sentinel", async () => {
  const b = build();
  const { hook, read } = await start(b);
  await postDelivery(hook, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
  const frames: string[] = [];
  // A stale cursor triggers a reset; the server then keeps streaming on the same
  // connection from its head.
  const sse = openSse(read, "/api/live?since=99", frames);
  try {
    await until(() => frames.some((f) => f.includes("event: reset")));
    await postDelivery(hook, { event: "issues", delivery: "d-2", payload: issuesOpened(2) });
    await until(() => dataSeqs(frames).includes(2));
    assert.ok(
      dataSeqs(frames).includes(2),
      "an event appended after the reset is delivered on the same connection",
    );
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("a backlog exactly at the replay limit replays in full without a reset", async () => {
  const b = build({ replayLimit: 3 });
  const { hook, read } = await start(b);
  for (let i = 1; i <= 3; i++) {
    await postDelivery(hook, { event: "issues", delivery: `d-${i}`, payload: issuesOpened(i) });
  }
  const frames: string[] = [];
  const sse = openSse(read, "/api/live?since=0", frames); // 3 backlog rows == replayLimit
  try {
    await until(() => dataSeqs(frames).length === 3);
    assert.deepEqual(dataSeqs(frames), [1, 2, 3], "exactly-at-limit backlog replays in full");
    assert.ok(
      !frames.some((f) => f.includes("event: reset")),
      "no gap reset at the boundary",
    );
  } finally {
    sse.destroy();
    await stop(b);
  }
});

test("the receiver imports no canonical store, token, or config", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    "src/live/receiver.ts",
    "src/live/broadcaster.ts",
    "src/cli/live-receiver.ts",
  ];
  for (const f of files) {
    const src = readFileSync(resolve(root, f), "utf8");
    assert.ok(!/from\s+["'][^"']*db\/store/.test(src), `${f} imports the canonical store`);
    assert.ok(
      !/from\s+["'][^"']*db\/(sqlite|postgres|factory)/.test(src),
      `${f} imports a canonical driver`,
    );
    assert.ok(
      !/openConfiguredStore/.test(src),
      `${f} opens the canonical store`,
    );
    assert.ok(
      !/acquireWriterLease|releaseWriterLease/.test(src),
      `${f} touches the canonical writer lease`,
    );
    assert.ok(!/_TOKEN/.test(src), `${f} references a provider token`);
    assert.ok(!/loadConfig|sources\.json/.test(src), `${f} loads provider config`);
  }
});
