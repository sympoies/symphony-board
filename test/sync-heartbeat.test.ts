// Board container health: the daemon is healthy while its last contract is
// recent, or while a long sweep keeps making provider progress (the sync
// heartbeat). A sweep that stops making progress turns unhealthy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, statSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardHealthy, contractMaxAgeMs, heartbeatPath, startSyncHeartbeat } from "../src/sync-heartbeat.ts";
import { fetchWithTimeout, lastProviderResponseAt } from "../src/sources/http.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-21T13:15:00.000Z");

test("a fresh contract is healthy whatever the heartbeat says", () => {
  assert.equal(boardHealthy({ nowMs: NOW, contractMtimeMs: NOW - 5 * MIN, heartbeatMtimeMs: null, contractMaxAgeMs: 30 * MIN }), true);
  assert.equal(boardHealthy({ nowMs: NOW, contractMtimeMs: NOW - 5 * MIN, heartbeatMtimeMs: NOW - 60 * MIN, contractMaxAgeMs: 30 * MIN }), true);
});

test("a stale contract is healthy while the sweep heartbeat is fresh", () => {
  assert.equal(boardHealthy({ nowMs: NOW, contractMtimeMs: NOW - 45 * MIN, heartbeatMtimeMs: NOW - 1 * MIN, contractMaxAgeMs: 30 * MIN }), true);
});

test("a stale contract with a stale heartbeat is unhealthy (a stalled sweep)", () => {
  assert.equal(boardHealthy({ nowMs: NOW, contractMtimeMs: NOW - 45 * MIN, heartbeatMtimeMs: NOW - 11 * MIN, contractMaxAgeMs: 30 * MIN }), false);
  assert.equal(boardHealthy({ nowMs: NOW, contractMtimeMs: NOW - 45 * MIN, heartbeatMtimeMs: null, contractMaxAgeMs: 30 * MIN }), false);
});

test("without any contract the heartbeat alone is not healthy", () => {
  // `web` waits for board health so it never serves before the first contract.
  assert.equal(boardHealthy({ nowMs: NOW, contractMtimeMs: null, heartbeatMtimeMs: NOW, contractMaxAgeMs: 30 * MIN }), false);
});

test("the contract bound is at least 30 minutes and twice the loop interval", () => {
  assert.equal(contractMaxAgeMs(120), 30 * MIN);
  assert.equal(contractMaxAgeMs(1800), 60 * MIN);
});

test("the heartbeat lives next to the contract", () => {
  assert.equal(heartbeatPath("data/contract.json"), join("data", "sync-progress.json"));
});

test("the heartbeat is rewritten only when provider progress advanced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-heartbeat-"));
  const path = join(dir, "sync-progress.json");
  let progressAt = 0;
  const writes: number[] = [];
  const stop = startSyncHeartbeat(path, {
    progressAt: () => progressAt,
    tickMs: 5,
    onWrite: () => writes.push(progressAt),
  });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(existsSync(path), false, "no provider progress yet: no heartbeat");
    progressAt = Date.now();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(existsSync(path), true);
    assert.deepEqual(writes, [progressAt], "one write per advance, not per tick");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every provider response, whatever its status, counts as progress", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 502;
    res.end("bad gateway");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const before = Date.now();
    const res = await fetchWithTimeout(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {}, 5_000);
    await res.text();
    assert.ok(lastProviderResponseAt() >= before);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

function runHealthcheck(env: Record<string, string>): Promise<number> {
  const script = fileURLToPath(new URL("../src/cli/healthcheck.ts", import.meta.url));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", script],
      { env: { ...process.env, ...env } },
      (err) => resolve(err ? (typeof err.code === "number" ? err.code : 1) : 0),
    );
  });
}

test("the container healthcheck command applies the same decision to the files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-health-"));
  const contract = join(dir, "contract.json");
  const heartbeat = join(dir, "sync-progress.json");
  const ago = (m: number) => new Date(Date.now() - m * MIN);
  const env = { CONTRACT_OUT: contract, INTERVAL: "120" };
  try {
    assert.equal(await runHealthcheck(env), 1, "no contract yet");
    writeFileSync(contract, "{}");
    assert.equal(await runHealthcheck(env), 0, "fresh contract");
    utimesSync(contract, ago(45), ago(45));
    assert.equal(await runHealthcheck(env), 1, "stale contract, no heartbeat");
    writeFileSync(heartbeat, "{}");
    assert.equal(await runHealthcheck(env), 0, "stale contract, fresh heartbeat");
    utimesSync(heartbeat, ago(11), ago(11));
    assert.ok(statSync(heartbeat).mtimeMs < Date.now() - 10 * MIN);
    assert.equal(await runHealthcheck(env), 1, "stale contract, stale heartbeat");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
