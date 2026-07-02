import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createRangeApiServer } from "../src/cli/range-api.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import { createLiveReceiver, type ProviderRoute } from "../src/live/receiver.ts";
import { openLiveStore, type LiveStore } from "../src/live/store.ts";
import type { LiveEventInput } from "../src/live/types.ts";
import type { VerifyResult } from "../src/live/verify.ts";
import type { WebhookProvider } from "../src/live/provider.ts";
import { buildCapabilities } from "../src/server/capabilities.ts";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

async function sandbox(): Promise<{ dir: string; configPath: string; contractOut: string }> {
  const dir = mkdtempSync(join(tmpdir(), "capabilities-test-"));
  const dbPath = join(dir, "data", "board.db");
  const configPath = join(dir, "config", "sources.json");
  const db = await openSqliteStore(dbPath);
  await db.close();
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      db_path: dbPath,
      timezone: "UTC",
      sources: [
        {
          source_id: "github:github.com",
          kind: "github",
          host: "github.com",
          display_name: "GitHub",
          token_env: "CAPABILITIES_TEST_TOKEN_UNSET",
          graphql_url: "https://api.github.com/graphql",
          projects: ["example/repo"],
        },
      ],
    }),
    "utf8",
  );
  return { dir, configPath, contractOut: join(dir, "data", "contract.json") };
}

test("range-api serves read-side capabilities with Live unsupported by default", async () => {
  const { dir, configPath, contractOut } = await sandbox();
  const server = createRangeApiServer({ configPath, contractOut });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/capabilities`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.schema, "symphony-board-capabilities/1");
    assert.equal(body.server.mode, "api");
    assert.equal(body.server.contract, true);
    assert.equal(body.server.range, true);
    assert.equal(body.server.stats, true);
    assert.equal(body.live.reads, false);
    assert.equal(body.live.status, "unsupported");
    assert.equal(body.live.latest_seq, null);
    assert.equal(body.live.webhook_setup, undefined);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capabilities reports configured Live reads as unreachable when the probe fails", async () => {
  const failures: Array<{ name: string; fetchImpl: typeof fetch }> = [
    {
      name: "http_500",
      fetchImpl: (async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as typeof fetch,
    },
    {
      name: "network",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    },
    {
      name: "malformed",
      fetchImpl: (async () => new Response(JSON.stringify({ schema: "not-live", events: [], max_seq: 1 }))) as typeof fetch,
    },
  ];

  for (const { name, fetchImpl } of failures) {
    const caps = await buildCapabilities({
      serverMode: "docker",
      liveReadBaseUrl: `http://live.invalid/${name}`,
      fetchImpl,
      liveProbeTimeoutMs: 1,
    });
    assert.equal(caps.live.reads, true, name);
    assert.equal(caps.live.snapshot, true, name);
    assert.equal(caps.live.stream, true, name);
    assert.equal(caps.live.status, "unreachable", name);
    assert.equal(caps.live.latest_seq, null, name);
    assert.equal(caps.live.latest_event_at, null, name);
  }
});

test("capabilities reports an empty but reachable Live receiver distinctly", async () => {
  const caps = await buildCapabilities({
    serverMode: "docker",
    liveReadBaseUrl: "http://live.invalid",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          schema: "live-snapshot/1",
          generated_at: "2026-07-02T12:00:00.000Z",
          events: [],
          max_seq: 0,
        }),
        { status: 200 },
      )) as typeof fetch,
  });

  assert.equal(caps.live.reads, true);
  assert.equal(caps.live.status, "empty");
  assert.equal(caps.live.latest_seq, 0);
  assert.equal(caps.live.latest_event_at, null);
  assert.equal(caps.live.snapshot_generated_at, "2026-07-02T12:00:00.000Z");
});

class NoopProvider implements WebhookProvider {
  readonly id = "github" as const;
  readonly eventHeaderName = "x-github-event";
  readonly hookIdHeaderName = "x-github-hook-id";

  verify(): VerifyResult {
    return { ok: false, reason: "missing_signature" };
  }

  deliveryId(): string | null {
    return null;
  }

  isControlEvent(): boolean {
    return false;
  }

  toLiveEvents(): LiveEventInput[] {
    return [];
  }
}

function liveEvent(n: number): LiveEventInput {
  return {
    event_id: `event-${n}`,
    source_id: "github:github.com",
    provider: "github",
    received_at: `2026-07-02T12:00:0${n}.000Z`,
    occurred_at: `2026-07-02T11:00:0${n}.000Z`,
    event_type: "issues",
    action: "opened",
    category: "issue",
    target: { kind: "issue", source_id: "github:github.com", project_path: "example/repo", number: n },
    title: `issue ${n}`,
    delivery: { delivery_id: `delivery-${n}`, event_header: "issues", signature_status: "verified" },
  };
}

test("capabilities summarizes a reachable Live receiver without credential material", async () => {
  const store: LiveStore = openLiveStore(":memory:");
  await store.append(liveEvent(1));
  const route: ProviderRoute = {
    pathSegment: "github",
    provider: new NoopProvider(),
    sourceId: "github:github.com",
    secrets: ["secret-that-must-not-leak"],
  };
  const { webhookServer, readServer, broadcaster } = createLiveReceiver({ store, routes: [route], projectAllowlist: ["example/repo", "other/repo"] });
  const liveBase = await listen(readServer);
  try {
    const caps = await buildCapabilities({
      serverMode: "docker",
      liveReadBaseUrl: liveBase,
      providerWebhooks: ["github"],
      allowlistProjects: ["example/repo", "other/repo"],
      webhookSetup: {
        provider: "github",
        publicUrl: "https://deploy.example/webhooks/github",
        events: ["issues", "pull_request"],
      },
      now: () => "2026-07-02T12:00:10.000Z",
    });
    assert.equal(caps.generated_at, "2026-07-02T12:00:10.000Z");
    assert.equal(caps.live.reads, true);
    assert.equal(caps.live.snapshot, true);
    assert.equal(caps.live.stream, true);
    assert.equal(caps.live.status, "ready");
    assert.equal(caps.live.latest_seq, 1);
    assert.equal(caps.live.latest_event_at, "2026-07-02T12:00:01.000Z");
    assert.deepEqual(caps.live.allowlist, { enabled: true, count: 2 });
    assert.deepEqual(caps.live.webhook_setup, {
      provider: "github",
      public_url: "https://deploy.example/webhooks/github",
      events: ["issues", "pull_request"],
    });
    assert.equal(JSON.stringify(caps).includes("secret-that-must-not-leak"), false);
  } finally {
    broadcaster.closeAll();
    await close(webhookServer);
    await close(readServer);
    store.close();
  }
});
