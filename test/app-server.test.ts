import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SyncController, SYNC_CONTROL_HEADER } from "../src/cli/sync-daemon.ts";
import { createAppServer, type AppServerOptions } from "../src/cli/app-server.ts";
import { openDb } from "../src/db/open.ts";
import type { SyncRunResult } from "../src/sync-runner.ts";

const NO_TOTALS = { items: 0, edges: 0, activities: 0, soft_deleted: 0, soft_deleted_edges: 0 };
function okResult(): SyncRunResult {
  return { status: "ok", sources: [], totals: NO_TOTALS, emitted: true, error: null };
}

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
// Node's fetch types `Response.json()` as `Promise<unknown>`; these are test
// assertions over a JSON shape we control, so read it as a loose record.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

// A sandbox dir holding a valid config, a migrated empty DB, and room for a
// contract file — the standalone app's data-dir layout in miniature.
function sandbox(): { dir: string; opts: AppServerOptions } {
  const dir = mkdtempSync(join(tmpdir(), "app-server-test-"));
  const dbPath = join(dir, "data", "board.db");
  const configPath = join(dir, "config", "sources.json");
  const db = openDb(dbPath); // creates data/ and migrates the empty store
  db.close();
  mkdirSync(join(dir, "config"), { recursive: true });
  const config = {
    db_path: dbPath,
    timezone: "UTC",
    sources: [
      {
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        display_name: "GitHub",
        token_env: "APP_SERVER_TEST_TOKEN_UNSET",
        graphql_url: "https://api.github.com/graphql",
        projects: ["example/repo"],
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config), { encoding: "utf8" });
  return {
    dir,
    opts: {
      configPath,
      contractOut: join(dir, "data", "contract.json"),
      controlEnabled: true,
      configControlEnabled: true,
      secretsPath: join(dir, "secrets.env"),
      intervalSeconds: 120,
      fullEvery: 30,
    },
  };
}

test("app-server serves health, contract, range, and the sync control surface", async () => {
  const { dir, opts } = sandbox();
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createAppServer(controller, opts);
  const base = await listen(server);
  try {
    // health (control handler fallback)
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await json(health), { ok: true });

    // contract: 404 until the first emit, then served verbatim with no-store
    const missing = await fetch(`${base}/contract.json`);
    assert.equal(missing.status, 404);
    assert.equal((await json(missing)).error, "no_contract");
    writeFileSync(opts.contractOut, JSON.stringify({ contract_version: "3.0.0", items: [] }));
    const served = await fetch(`${base}/contract.json`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("cache-control"), "no-store");
    assert.equal((await json(served)).contract_version, "3.0.0");

    // range: a valid window over the empty store yields a contract envelope
    const range = await fetch(`${base}/api/range?from=2026-01-01&to=2026-01-02`);
    assert.equal(range.status, 200);
    const envelope = await json(range);
    assert.equal(typeof envelope.contract_version, "string");
    assert.deepEqual(envelope.items, []);
    assert.equal(envelope.range_query.from, "2026-01-01T00:00:00.000Z");

    // range validation errors surface as 400
    const bad = await fetch(`${base}/api/range?from=nope&to=2026-01-02`);
    assert.equal(bad.status, 400);

    // control surface: probe reflects config sources; manual run starts
    const control = await fetch(`${base}/api/sync-control`);
    assert.equal(control.status, 200);
    const info = await json(control);
    assert.equal(info.enabled, true);
    assert.deepEqual(info.sources.map((s: { source_id: string }) => s.source_id), ["github:github.com"]);

    const started = await fetch(`${base}/api/sync-runs`, {
      method: "POST",
      headers: { [SYNC_CONTROL_HEADER]: "1" },
      body: "{}",
    });
    assert.equal(started.status, 202);

    // config control plane: GET serves the live document
    const cfgRes = await fetch(`${base}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfgBody = await json(cfgRes);
    assert.equal(cfgBody.enabled, true);
    assert.equal(cfgBody.config.sources[0].source_id, "github:github.com");

    // PUT applies without a restart: the next control probe sees the new source
    const next = cfgBody.config;
    next.sources.push({
      source_id: "gitlab:gitlab.com",
      kind: "gitlab",
      host: "gitlab.com",
      token_env: "APP_SERVER_TEST_TOKEN_UNSET_2",
      graphql_url: "https://gitlab.com/api/graphql",
      projects: ["group/project"],
    });
    const put = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { [SYNC_CONTROL_HEADER]: "1" },
      body: JSON.stringify(next),
    });
    assert.equal(put.status, 200);
    const probeAfter = await json(await fetch(`${base}/api/sync-control`));
    assert.deepEqual(
      probeAfter.sources.map((s: { source_id: string }) => s.source_id),
      ["github:github.com", "gitlab:gitlab.com"],
    );

    // unknown routes 404
    const nope = await fetch(`${base}/api/nope`);
    assert.equal(nope.status, 404);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app-server degrades cleanly when the config is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "app-server-test-"));
  const opts: AppServerOptions = {
    configPath: join(dir, "config", "sources.json"), // never written
    contractOut: join(dir, "data", "contract.json"),
    controlEnabled: true,
    configControlEnabled: true,
    secretsPath: null,
    intervalSeconds: 120,
    fullEvery: 30,
  };
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createAppServer(controller, opts);
  const base = await listen(server);
  try {
    // the control surface stays up with no source scopes
    const control = await fetch(`${base}/api/sync-control`);
    assert.equal(control.status, 200);
    assert.deepEqual((await json(control)).sources, []);

    // range reports the config failure instead of crashing the process
    const range = await fetch(`${base}/api/range?from=2026-01-01&to=2026-01-02`);
    assert.equal(range.status, 500);
    assert.equal((await json(range)).error, "config_error");

    // the config capability is still advertised with no document — the
    // first-run onboarding state the Settings editor starts from
    const probe = await json(await fetch(`${base}/api/config`));
    assert.equal(probe.enabled, true);
    assert.equal(probe.config, null);
    assert.equal(typeof probe.error, "string");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
