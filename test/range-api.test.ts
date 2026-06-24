import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { type Server } from "node:http";
import { createRangeApiServer, type RangeApiOptions } from "../src/cli/range-api.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";

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
// contract file — the Docker `api` sidecar's mounted data-dir layout in
// miniature. `timezone` is a constructor argument so a test can rewrite it and
// observe whether the sidecar re-reads config.
async function sandbox(timezone = "UTC"): Promise<{ dir: string; configPath: string; opts: RangeApiOptions }> {
  const dir = mkdtempSync(join(tmpdir(), "range-api-test-"));
  const dbPath = join(dir, "data", "board.db");
  const configPath = join(dir, "config", "sources.json");
  const db = await openSqliteStore(dbPath); // creates data/ and migrates the empty store
  await db.close();
  mkdirSync(join(dir, "config"), { recursive: true });
  writeConfig(configPath, dbPath, timezone);
  return { dir, configPath, opts: { configPath, contractOut: join(dir, "data", "contract.json") } };
}

function writeConfig(configPath: string, dbPath: string, timezone: string): void {
  const config = {
    db_path: dbPath,
    timezone,
    sources: [
      {
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        display_name: "GitHub",
        token_env: "RANGE_API_TEST_TOKEN_UNSET",
        graphql_url: "https://api.github.com/graphql",
        projects: ["example/repo"],
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config), { encoding: "utf8" });
}

test("range-api serves health, range, stats, review-candidates, activity-daily, and 404s the rest", async () => {
  const { dir, opts } = await sandbox();
  const server = createRangeApiServer(opts);
  const base = await listen(server);
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await json(health), { ok: true });

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
    const stats = await json(await fetch(`${base}/api/stats`));
    assert.equal(stats.items.live, 0);
    assert.ok(stats.db.schema_version >= 3);

    // review-candidate discovery on the read-only store sidecar role
    const reviewCandidates = await fetch(`${base}/api/review-candidates`);
    assert.equal(reviewCandidates.status, 200);
    assert.deepEqual(await json(reviewCandidates), []);

    // activity-daily reads the emitted contract file: 404 until the first emit
    const missingDaily = await fetch(`${base}/api/activity-daily`);
    assert.equal(missingDaily.status, 404);
    writeFileSync(opts.contractOut, JSON.stringify({ contract_version: "4.0.0", items: [], activity_daily: null }));
    const daily = await fetch(`${base}/api/activity-daily`);
    assert.equal(daily.status, 200);

    // unknown routes and non-GET methods 404
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/range?from=2026-01-01&to=2026-01-02`, { method: "POST" })).status, 404);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression for #439: the `api` sidecar must re-read config per request so a
// config-only edit (identities, exclude_actors, colors, repo set, timezone)
// applies without a container restart, matching app-server.ts and the board
// daemon. `timezone` is the store-free probe: it threads straight onto
// range_query and shifts the zoned window boundaries, so a frozen startup
// config would keep returning the old zone after the file changed on disk.
test("range-api applies a config-only edit without a restart (#439)", async () => {
  const { dir, configPath, opts } = await sandbox("UTC");
  const dbPath = join(dir, "data", "board.db");
  const server = createRangeApiServer(opts);
  const base = await listen(server);
  try {
    const before = await json(await fetch(`${base}/api/range?from=2026-06-01&to=2026-06-02`));
    assert.equal(before.range_query.timezone, "UTC");
    assert.equal(before.range_query.from, "2026-06-01T00:00:00.000Z");
    assert.equal(before.range_query.to, "2026-06-02T23:59:59.999Z");

    // Edit config on disk — no restart, no new server.
    writeConfig(configPath, dbPath, "Asia/Tokyo");

    const after = await json(await fetch(`${base}/api/range?from=2026-06-01&to=2026-06-02`));
    assert.equal(after.range_query.timezone, "Asia/Tokyo", "config edit must apply without a restart");
    assert.equal(after.range_query.from, "2026-05-31T15:00:00.000Z", "zoned window boundary follows the edited timezone");
    assert.equal(after.range_query.to, "2026-06-02T14:59:59.999Z");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A broken config must map to a per-request failure, not crash the listener at
// startup — the sidecar matches app-server.ts's degrade behavior.
test("range-api degrades to a per-request config error without crashing the listener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "range-api-broken-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  const configPath = join(dir, "config", "sources.json");
  writeFileSync(configPath, "{ not valid json", "utf8");
  const opts: RangeApiOptions = { configPath, contractOut: join(dir, "data", "contract.json") };

  // The server builds and listens even with a broken config.
  const server = createRangeApiServer(opts);
  const base = await listen(server);
  try {
    // healthz needs no config and stays up
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    // config-backed routes report the failure per request instead of crashing
    const range = await fetch(`${base}/api/range?from=2026-01-01&to=2026-01-02`);
    assert.equal(range.status, 500);
    assert.equal((await json(range)).error, "config_error");
    const stats = await fetch(`${base}/api/stats`);
    assert.equal(stats.status, 500);
    assert.equal((await json(stats)).error, "config_error");
    const reviewCandidates = await fetch(`${base}/api/review-candidates`);
    assert.equal(reviewCandidates.status, 500);
    assert.equal((await json(reviewCandidates)).error, "config_error");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
