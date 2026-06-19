import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { SyncController, SYNC_CONTROL_HEADER } from "../src/cli/sync-daemon.ts";
import { createAppServer, type AppServerOptions } from "../src/cli/app-server.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
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

// Raw GET that does NOT auto-decode Content-Encoding (Node's fetch transparently
// gunzips), so a gzip test can inspect the wire bytes and headers directly.
function getRaw(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// A sandbox dir holding a valid config, a migrated empty DB, and room for a
// contract file — the standalone app's data-dir layout in miniature.
async function sandbox(): Promise<{ dir: string; opts: AppServerOptions }> {
  const dir = mkdtempSync(join(tmpdir(), "app-server-test-"));
  const dbPath = join(dir, "data", "board.db");
  const configPath = join(dir, "config", "sources.json");
  const db = await openSqliteStore(dbPath); // creates data/ and migrates the empty store
  await db.close();
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
      logsEnabled: true,
      secretsPath: join(dir, "secrets.env"),
      intervalSeconds: 120,
      fullEvery: 30,
    },
  };
}

test("app-server serves health, contract, range, and the sync control surface", async () => {
  const { dir, opts } = await sandbox();
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

    // store stats: the migrated empty store summarizes to zero rows
    const statsRes = await fetch(`${base}/api/stats`);
    assert.equal(statsRes.status, 200);
    const stats = await json(statsRes);
    assert.equal(stats.items.live, 0);
    assert.equal(stats.tables.item, 0);
    assert.ok(stats.db.schema_version >= 3);

    // review cleanup discovery: mounted on the same read-only store sidecar role
    const reviewCandidatesRes = await fetch(`${base}/api/review-candidates`);
    assert.equal(reviewCandidatesRes.status, 200);
    assert.deepEqual(await json(reviewCandidatesRes), []);

    // recent-log tail: enabled here; "?after=latest" means caught up
    const logs = await json(await fetch(`${base}/api/logs`));
    assert.equal(logs.enabled, true);
    const caughtUp = await json(await fetch(`${base}/api/logs?after=${logs.latest_seq}`));
    assert.deepEqual(caughtUp.entries, []);

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

test("app-server gzips /contract.json for Accept-Encoding: gzip, serves raw otherwise, and re-compresses on file change", async () => {
  const { dir, opts } = await sandbox();
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createAppServer(controller, opts);
  const base = await listen(server);
  try {
    // A body large enough that gzip is unambiguously smaller than the raw bytes.
    const payloadA = JSON.stringify({ contract_version: "4.0.0", items: [], activities: Array.from({ length: 200 }, (_, i) => ({ id: `a-${i}`, kind: "commit" })) });
    writeFileSync(opts.contractOut, payloadA);

    // gzip negotiated: Content-Encoding header + a valid gzip body that decodes
    // to the contract, Vary so a shared cache keys on Accept-Encoding.
    const gz = await getRaw(base, "/contract.json", { "Accept-Encoding": "gzip" });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.equal(gz.headers["content-type"], "application/json");
    assert.equal(gz.headers["cache-control"], "no-store");
    assert.equal(Number(gz.headers["content-length"]), gz.body.length, "compressed responses expose their encoded size");
    assert.match(String(gz.headers["vary"] ?? ""), /accept-encoding/i);
    assert.equal(JSON.parse(gunzipSync(gz.body).toString("utf8")).contract_version, "4.0.0");
    assert.ok(gz.body.length < Buffer.byteLength(payloadA), "gzip body is smaller than raw");

    // no gzip requested: raw bytes, no Content-Encoding.
    const raw = await getRaw(base, "/contract.json", { "Accept-Encoding": "identity" });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers["content-encoding"], undefined);
    assert.equal(raw.body.toString("utf8"), payloadA);

    // cache invalidates on file change: a new emit (bumped mtime) must serve the
    // new content, not the stale compressed buffer.
    const payloadB = JSON.stringify({ contract_version: "4.0.0", items: [], activities: Array.from({ length: 200 }, (_, i) => ({ id: `b-${i}`, kind: "review" })) });
    writeFileSync(opts.contractOut, payloadB);
    const future = new Date(Date.now() + 5000);
    utimesSync(opts.contractOut, future, future);
    const gz2 = await getRaw(base, "/contract.json", { "Accept-Encoding": "gzip" });
    assert.equal(gz2.headers["content-encoding"], "gzip");
    const decodedB = JSON.parse(gunzipSync(gz2.body).toString("utf8"));
    assert.equal(decodedB.activities[0].id, "b-0", "re-compressed after the contract file changed");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app-server gzips /api/range for Accept-Encoding: gzip and serves raw otherwise", async () => {
  const { dir, opts } = await sandbox();
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createAppServer(controller, opts);
  const base = await listen(server);
  try {
    // /api/range is the large dynamic envelope (6mo/1yr selections); the
    // standalone server must gzip it when accepted, matching the nginx-fronted
    // compose path that already compresses the same route.
    const gz = await getRaw(base, "/api/range?from=2026-01-01&to=2026-01-02", { "Accept-Encoding": "gzip" });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.equal(gz.headers["content-type"], "application/json");
    assert.equal(gz.headers["cache-control"], "no-store");
    assert.match(String(gz.headers["vary"] ?? ""), /accept-encoding/i);
    const envelope = JSON.parse(gunzipSync(gz.body).toString("utf8"));
    assert.equal(typeof envelope.contract_version, "string");
    assert.equal(envelope.range_query.from, "2026-01-01T00:00:00.000Z");

    // no gzip requested: raw bytes, no Content-Encoding.
    const raw = await getRaw(base, "/api/range?from=2026-01-01&to=2026-01-02", { "Accept-Encoding": "identity" });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers["content-encoding"], undefined);
    assert.equal(JSON.parse(raw.body.toString("utf8")).range_query.from, "2026-01-01T00:00:00.000Z");
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
    logsEnabled: false,
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

    // range, stats, and review-candidates report the config failure instead of crashing the process
    const range = await fetch(`${base}/api/range?from=2026-01-01&to=2026-01-02`);
    assert.equal(range.status, 500);
    assert.equal((await json(range)).error, "config_error");
    const stats = await fetch(`${base}/api/stats`);
    assert.equal(stats.status, 500);
    assert.equal((await json(stats)).error, "config_error");
    const reviewCandidates = await fetch(`${base}/api/review-candidates`);
    assert.equal(reviewCandidates.status, 500);
    assert.equal((await json(reviewCandidates)).error, "config_error");

    // the log tail is disabled on this deployment: probe answers, leaks nothing
    const logs = await json(await fetch(`${base}/api/logs`));
    assert.deepEqual(logs, { enabled: false, entries: [], latest_seq: 0, capacity: 0 });

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
