import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  SyncController,
  createControlServer,
  parseSyncRequest,
  type ControlContext,
  type SourceOption,
  type SyncRequest,
} from "../src/cli/sync-daemon.ts";
import type { SyncRunResult } from "../src/sync-runner.ts";

const NO_TOTALS = { items: 0, edges: 0, activities: 0, soft_deleted: 0, soft_deleted_edges: 0 };
function okResult(): SyncRunResult {
  return { status: "ok", sources: [], totals: NO_TOTALS, emitted: true, error: null };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SOURCES: SourceOption[] = [{ source_id: "fake:a", display_name: "A", kind: "fake" }];
function ctx(controlEnabled: boolean): ControlContext {
  return { controlEnabled, sources: SOURCES, intervalSeconds: 120, fullEvery: 30 };
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
async function until(predicate: () => boolean | Promise<boolean>, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}

// --- controller: the single run lock ---

test("the controller rejects a second run while one is active and serializes them", async () => {
  const gate = deferred<SyncRunResult>();
  const controller = new SyncController({ run: () => gate.promise, now: () => "2026-06-08T00:00:00Z", makeRunId: (seq) => `run-${seq}` });

  const first = controller.start({ mode: "full", dryRun: false, sourceId: null }, "manual");
  assert.equal(first.accepted, true);
  assert.equal(controller.isRunning(), true);

  const second = controller.start({ mode: "incremental", dryRun: false, sourceId: null }, "manual");
  assert.equal(second.accepted, false, "no second run while one is active — never two SQLite writers");
  assert.equal(second.status.run_id, first.status.run_id, "the rejection returns the active run");

  gate.resolve(okResult());
  await first.done;
  assert.equal(controller.isRunning(), false);
  assert.equal(controller.current(), null);
  assert.equal(controller.lastRun()?.run_id, "run-1");
  assert.equal(controller.lastRun()?.status, "ok");

  // The slot is free again after the first finished.
  const third = controller.start({ mode: "full", dryRun: false, sourceId: null }, "manual");
  assert.equal(third.accepted, true);
  assert.equal(third.status.run_id, "run-2");
  gate.resolve(okResult());
  await third.done;
});

test("a scheduled tick skips (does not queue) while a manual run is active", async () => {
  const gate = deferred<SyncRunResult>();
  const controller = new SyncController({ run: () => gate.promise });
  const manual = controller.start({ mode: "incremental", dryRun: false, sourceId: null }, "manual");
  assert.equal(manual.accepted, true);

  const outcome = await controller.runScheduled(true);
  assert.equal(outcome, "skipped", "the scheduled sweep skips rather than overlapping the manual writer");

  gate.resolve(okResult());
  await manual.done;
});

// --- request parsing ---

test("parseSyncRequest defaults, validates, and rejects unknown values", () => {
  assert.deepEqual(parseSyncRequest("", SOURCES), { ok: true, request: { mode: "incremental", dryRun: false, sourceId: null } });
  assert.deepEqual(parseSyncRequest(JSON.stringify({ mode: "full", dry_run: true, source_id: "fake:a" }), SOURCES), {
    ok: true,
    request: { mode: "full", dryRun: true, sourceId: "fake:a" },
  });
  assert.equal(parseSyncRequest(JSON.stringify({ mode: "sideways" }), SOURCES).ok, false);
  assert.equal(parseSyncRequest(JSON.stringify({ source_id: "nope" }), SOURCES).ok, false);
  assert.equal(parseSyncRequest(JSON.stringify({ dry_run: "yes" }), SOURCES).ok, false);
  assert.equal(parseSyncRequest("not json", SOURCES).ok, false);
});

// --- HTTP control surface ---

test("control server serves status, guards the POST, and rejects re-entrant runs", async () => {
  const gate = deferred<SyncRunResult>();
  const captured: SyncRequest[] = [];
  const controller = new SyncController({
    run: (req) => {
      captured.push(req);
      return gate.promise;
    },
    now: () => "2026-06-08T00:00:00Z",
    makeRunId: (seq) => `run-${seq}`,
  });
  const server = createControlServer(controller, ctx(true));
  const base = await listen(server);
  const POST = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/sync-runs`, { method: "POST", headers, body });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    const info = await json(await fetch(`${base}/api/sync-control`));
    assert.equal(info.enabled, true);
    assert.equal(info.sources[0].source_id, "fake:a");
    assert.equal(info.current, null);

    // missing same-origin header
    let res = await POST("{}");
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error, "forbidden");

    // unknown source_id
    res = await POST(JSON.stringify({ source_id: "nope" }), { "X-Symphony-Sync-Control": "1" });
    assert.equal(res.status, 400);

    // start a run -> 202 running
    res = await POST(JSON.stringify({ mode: "full", dry_run: true }), { "X-Symphony-Sync-Control": "1" });
    assert.equal(res.status, 202);
    const started = (await json(res)).current;
    assert.equal(started.status, "running");
    assert.equal(started.mode, "full");
    assert.equal(started.dry_run, true);
    assert.deepEqual(captured[0], { mode: "full", dryRun: true, sourceId: null });

    // re-entrant POST -> 409 with the active run
    res = await POST("{}", { "X-Symphony-Sync-Control": "1" });
    assert.equal(res.status, 409);
    const reentrant = await json(res);
    assert.equal(reentrant.error, "run_active");
    assert.equal(reentrant.current.run_id, started.run_id);

    // current reflects the active run
    const current = (await json(await fetch(`${base}/api/sync-runs/current`))).current;
    assert.equal(current.run_id, started.run_id);

    // finish the run: current clears, last is set
    gate.resolve(okResult());
    await until(async () => (await json(await fetch(`${base}/api/sync-runs/current`))).current === null);
    const last = (await json(await fetch(`${base}/api/sync-runs/last`))).last;
    assert.equal(last.run_id, started.run_id);
    assert.equal(last.status, "ok");
  } finally {
    await close(server);
  }
});

test("control server refuses manual runs when control is disabled", async () => {
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createControlServer(controller, ctx(false));
  const base = await listen(server);
  try {
    const info = await json(await fetch(`${base}/api/sync-control`));
    assert.equal(info.enabled, false);

    const res = await fetch(`${base}/api/sync-runs`, {
      method: "POST",
      headers: { "X-Symphony-Sync-Control": "1" },
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error, "control_disabled");
    assert.equal(controller.isRunning(), false, "a disabled control plane never starts a run");
  } finally {
    await close(server);
  }
});
