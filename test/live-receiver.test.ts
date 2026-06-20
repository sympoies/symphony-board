// Sprint 3 acceptance for the least-privilege live receiver. Boots the real
// server on 127.0.0.1:0 (modeled on app-server.test.ts), drives signed webhook
// deliveries, the SSE stream, the snapshot, and healthz. Network-free (loopback
// inbound only). Asserts: append-before-202-ack, dedupe, ping, signature
// rejection, SSE framing + ?since replay, project allowlist, body cap, and the
// hard isolation invariant (no canonical store / token / config; secret never
// stored).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openLiveStore, type LiveStore } from "../src/live/store.ts";
import { GithubWebhookProvider, GITHUB_SOURCE_ID } from "../src/live/github.ts";
import { createLiveReceiver } from "../src/live/receiver.ts";

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
  server: Server;
  broadcaster: { closeAll(): void };
}
function build(
  opts: { allowlist?: string[]; maxBodyBytes?: number } = {},
): Built {
  const store = openLiveStore(":memory:");
  const { server, broadcaster } = createLiveReceiver({
    store,
    routes: [
      {
        pathSegment: "github",
        provider: new GithubWebhookProvider(),
        sourceId: GITHUB_SOURCE_ID,
        secrets: [SECRET],
      },
    ],
    projectAllowlist: opts.allowlist,
    maxBodyBytes: opts.maxBodyBytes,
  });
  return { store, server, broadcaster };
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
  },
): Promise<Response> {
  const raw = JSON.stringify(o.payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": o.event,
    "x-github-delivery": o.delivery,
    "x-github-hook-id": "hook-1",
  };
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
    .filter((f) => f.includes("data:"))
    .map((f) => {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse((line ?? "data: {}").slice(6)).seq as number;
    });
}

test("a valid signed delivery is stored once and a redelivery is a no-op", async () => {
  const { store, server } = build();
  const base = await listen(server);
  try {
    const r1 = await postDelivery(base, {
      event: "issues",
      delivery: "d-1",
      payload: issuesOpened(1),
    });
    assert.equal(r1.status, 202);
    assert.equal(store.recent(100).length, 1, "stored exactly once before ack");
    const r2 = await postDelivery(base, {
      event: "issues",
      delivery: "d-1",
      payload: issuesOpened(1),
    });
    assert.equal(r2.status, 202);
    assert.equal(store.recent(100).length, 1, "redelivery stored nothing");
  } finally {
    await close(server);
    store.close();
  }
});

test("an invalid signature is rejected and stores nothing", async () => {
  const { store, server } = build();
  const base = await listen(server);
  try {
    const res = await postDelivery(base, {
      event: "issues",
      delivery: "d-bad",
      payload: issuesOpened(1),
      secret: "wrong-secret",
    });
    assert.equal(res.status, 401);
    assert.equal(store.recent(100).length, 0);
    const missing = await postDelivery(base, {
      event: "issues",
      delivery: "d-bad2",
      payload: issuesOpened(1),
      signed: false,
    });
    assert.equal(missing.status, 401);
    assert.equal(store.recent(100).length, 0);
  } finally {
    await close(server);
    store.close();
  }
});

test("a ping is acked 200 and stores nothing", async () => {
  const { store, server } = build();
  const base = await listen(server);
  try {
    const res = await postDelivery(base, {
      event: "ping",
      delivery: "d-ping",
      payload: { zen: "Keep it logically awesome." },
    });
    assert.equal(res.status, 200);
    assert.equal(store.recent(100).length, 0);
  } finally {
    await close(server);
    store.close();
  }
});

test("the snapshot returns recent events newest-first plus max_seq", async () => {
  const { store, server } = build();
  const base = await listen(server);
  try {
    await postDelivery(base, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
    await postDelivery(base, { event: "issues", delivery: "d-2", payload: issuesOpened(2) });
    const { status, body } = await getJson(base, "/api/live-snapshot?limit=10");
    assert.equal(status, 200);
    const snap = body as { events: { seq: number }[]; max_seq: number };
    assert.equal(snap.max_seq, 2);
    assert.deepEqual(snap.events.map((e) => e.seq), [2, 1]);
  } finally {
    await close(server);
    store.close();
  }
});

test("healthz returns 200", async () => {
  const { store, server } = build();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    await close(server);
    store.close();
  }
});

test("an oversized body is rejected with 413 before verification", async () => {
  const { store, server } = build({ maxBodyBytes: 64 });
  const base = await listen(server);
  try {
    const big = { action: "opened", filler: "x".repeat(500) };
    const res = await postDelivery(base, {
      event: "issues",
      delivery: "d-big",
      payload: big,
    });
    assert.equal(res.status, 413);
    assert.equal(store.recent(100).length, 0);
  } finally {
    await close(server);
    store.close();
  }
});

test("SSE streams a broadcast after connect and frames are id:-tagged", async () => {
  const { store, server } = build();
  const base = await listen(server);
  const frames: string[] = [];
  const sse = openSse(base, "/api/live", frames);
  try {
    await until(() => frames.some((f) => f.includes("retry")));
    const res = await postDelivery(base, {
      event: "issues",
      delivery: "d-1",
      payload: issuesOpened(1),
    });
    assert.equal(res.status, 202);
    await until(() => frames.some((f) => f.includes("data:")));
    const dataFrame = frames.find((f) => f.includes("data:")) ?? "";
    assert.ok(dataFrame.includes("id: 1"), "frame carries id: <seq>");
    assert.ok(dataFrame.includes("event: live"));
    assert.deepEqual(dataSeqs(frames), [1]);
  } finally {
    sse.destroy();
    await close(server);
    store.close();
  }
});

test("SSE ?since replays only events after the cursor", async () => {
  const { store, server } = build();
  const base = await listen(server);
  await postDelivery(base, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
  await postDelivery(base, { event: "issues", delivery: "d-2", payload: issuesOpened(2) });
  const frames: string[] = [];
  const sse = openSse(base, "/api/live?since=1", frames);
  try {
    await until(() => frames.some((f) => f.includes("data:")));
    assert.deepEqual(dataSeqs(frames), [2]);
  } finally {
    sse.destroy();
    await close(server);
    store.close();
  }
});

test("the project allowlist drops out-of-scope org repos", async () => {
  const { store, server } = build({ allowlist: ["sympoies/symphony-board"] });
  const base = await listen(server);
  try {
    const otherRepo = issuesOpened(9);
    (otherRepo.repository as Record<string, unknown>).full_name = "sympoies/unrelated";
    const dropped = await postDelivery(base, {
      event: "issues",
      delivery: "d-other",
      payload: otherRepo,
    });
    assert.equal(dropped.status, 204);
    assert.equal(store.recent(100).length, 0, "out-of-scope repo not stored");
    const kept = await postDelivery(base, {
      event: "issues",
      delivery: "d-mine",
      payload: issuesOpened(1),
    });
    assert.equal(kept.status, 202);
    assert.equal(store.recent(100).length, 1);
  } finally {
    await close(server);
    store.close();
  }
});

test("the webhook secret never lands in a stored event", async () => {
  const { store, server } = build();
  const base = await listen(server);
  try {
    await postDelivery(base, { event: "issues", delivery: "d-1", payload: issuesOpened(1) });
    const dump = JSON.stringify(store.recent(100));
    assert.equal(dump.includes(SECRET), false);
  } finally {
    await close(server);
    store.close();
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
