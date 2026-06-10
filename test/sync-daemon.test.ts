import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  SyncController,
  createControlServer,
  parseSyncRequest,
  SYNC_CONTROL_HEADER,
  type ConfigControl,
  type ControlContext,
  type SourceOption,
  type SyncRequest,
} from "../src/cli/sync-daemon.ts";
import type { SourceRunResult, SyncProgressReporter, SyncRunResult } from "../src/sync-runner.ts";
import { log } from "../src/log.ts";

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
const NO_CONFIG_CONTROL: ConfigControl = { enabled: false, path: "/nonexistent/sources.json", secretsPath: null };
function ctx(controlEnabled: boolean, configControl: ConfigControl = NO_CONFIG_CONTROL, logsEnabled = false): ControlContext {
  return { controlEnabled, configControl, logsEnabled, sources: SOURCES, intervalSeconds: 120, fullEvery: 30 };
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

test("mid-run progress fills the active run's sources and active source", async () => {
  const gate = deferred<SyncRunResult>();
  let report!: SyncProgressReporter;
  const controller = new SyncController({
    run: (_req, onProgress) => {
      report = onProgress;
      return gate.promise;
    },
  });
  const outcome = controller.start({ mode: "incremental", dryRun: false, sourceId: null }, "manual");
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status.active_source_id, null, "no source is active before the runner reports one");

  report({ sources: [], active_source_id: "fake:a" });
  assert.equal(controller.current()?.active_source_id, "fake:a");

  const aDone: SourceRunResult = {
    source_id: "fake:a", status: "ok", items: 1, edges: 0, activities: 0, soft_deleted: 0, soft_deleted_edges: 0, error: null,
  };
  report({ sources: [aDone], active_source_id: "fake:b" });
  assert.deepEqual(controller.current()?.sources.map((s) => s.source_id), ["fake:a"]);
  assert.equal(controller.current()?.active_source_id, "fake:b");

  gate.resolve(okResult());
  await outcome.done;
  assert.equal(controller.lastRun()?.active_source_id, null, "a finished run claims no active source");
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

// --- HTTP config control plane ---

test("config surface hides the document and refuses writes when disabled", async () => {
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createControlServer(controller, ctx(true)); // sync on, config control off
  const base = await listen(server);
  try {
    // the probe answers, but no config document leaks
    const probe = await json(await fetch(`${base}/api/config`));
    assert.deepEqual(probe, { enabled: false, config: null, error: null });

    // even a same-origin PUT is refused while disabled
    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { [SYNC_CONTROL_HEADER]: "1" },
      body: JSON.stringify({ db_path: "x", sources: [] }),
    });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error, "control_disabled");
  } finally {
    await close(server);
  }
});

test("config GET/PUT round-trip: probe, guards, validation, atomic write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "config-control-test-"));
  const configPath = join(dir, "config", "sources.json");
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createControlServer(controller, ctx(true, { enabled: true, path: configPath, secretsPath: null }));
  const base = await listen(server);
  const PUT = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/config`, { method: "PUT", headers, body });
  try {
    // missing config: capability still advertised (first-run onboarding state)
    const empty = await json(await fetch(`${base}/api/config`));
    assert.equal(empty.enabled, true);
    assert.equal(empty.config, null);
    assert.equal(typeof empty.error, "string");

    // missing same-origin header
    let res = await PUT("{}");
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error, "forbidden");

    // malformed JSON
    res = await PUT("{nope", { [SYNC_CONTROL_HEADER]: "1" });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "bad_request");

    // invalid config: every problem reported in one round trip, nothing written
    res = await PUT(JSON.stringify({ sources: [{ kind: "github" }], timezone: "Nope/Zone" }), {
      [SYNC_CONTROL_HEADER]: "1",
    });
    assert.equal(res.status, 400);
    const invalid = await json(res);
    assert.equal(invalid.error, "invalid_config");
    assert.ok(invalid.errors.some((e: string) => e.includes("missing db_path")));
    assert.ok(invalid.errors.some((e: string) => e.includes('source missing "source_id"')));
    assert.ok(invalid.errors.some((e: string) => e.includes("not a valid IANA timezone")));
    assert.equal(existsSync(configPath), false, "an invalid document never reaches disk");

    // valid config writes; fields the editor does not own round-trip unchanged
    const valid = {
      db_path: join(dir, "data", "board.db"),
      timezone: "UTC",
      sources: [
        {
          source_id: "github:github.com",
          kind: "github",
          host: "github.com",
          display_name: "GitHub",
          token_env: "CONFIG_CONTROL_TEST_TOKEN",
          graphql_url: "https://api.github.com/graphql",
          projects: ["a/b", { path: "c/d", color: "#abc" }],
        },
      ],
      identities: [{ name: "Terry", usernames: ["graysurf"] }],
      exclude_actors: ["renovate*"],
      x_unknown_field: { keep: true },
    };
    res = await PUT(JSON.stringify(valid), { [SYNC_CONTROL_HEADER]: "1" });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).ok, true);

    const readBack = await json(await fetch(`${base}/api/config`));
    assert.equal(readBack.enabled, true);
    assert.equal(readBack.error, null);
    assert.deepEqual(readBack.config, valid);

    // atomic write leaves no temp file behind
    const leftovers = readdirSync(dirname(configPath)).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config control hardening: oversized bodies, independent gates, concurrent PUTs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "config-hardening-test-"));
  const configPath = join(dir, "config", "sources.json");
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  // sync control OFF, config control ON: the two gates are independent
  const server = createControlServer(controller, ctx(false, { enabled: true, path: configPath, secretsPath: null }));
  const base = await listen(server);
  const validConfig = (displayName: string) => ({
    db_path: join(dir, "board.db"),
    sources: [
      {
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        display_name: displayName,
        token_env: "HARDENING_TEST_TOKEN",
        graphql_url: "https://api.github.com/graphql",
        projects: ["a/b"],
      },
    ],
  });
  const PUT = (body: string) =>
    fetch(`${base}/api/config`, { method: "PUT", headers: { [SYNC_CONTROL_HEADER]: "1" }, body });
  try {
    // sync mutations stay refused while config mutations work
    const syncRes = await fetch(`${base}/api/sync-runs`, {
      method: "POST",
      headers: { [SYNC_CONTROL_HEADER]: "1" },
      body: "{}",
    });
    assert.equal(syncRes.status, 403);
    assert.equal((await json(syncRes)).error, "control_disabled");
    assert.equal((await PUT(JSON.stringify(validConfig("solo")))).status, 200);

    // a body over the config limit is a clean 413, not a crash or partial write
    const huge = JSON.stringify({ ...validConfig("huge"), pad: "a".repeat(300 * 1024) });
    const big = await PUT(huge);
    assert.equal(big.status, 413);
    assert.equal((await json(big)).error, "payload_too_large");

    // concurrent PUTs: last write wins and the file is never torn
    const labels = Array.from({ length: 8 }, (_, i) => `writer-${i}`);
    const results = await Promise.all(labels.map((l) => PUT(JSON.stringify(validConfig(l)))));
    assert.ok(results.every((r) => r.status === 200));
    const after = await json(await fetch(`${base}/api/config`));
    assert.equal(after.error, null, "the stored config still validates");
    assert.ok(labels.includes(after.config.sources[0].display_name), "the survivor is one submitted document");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config edit during an active sync run leaves the run undisturbed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "config-midrun-test-"));
  const configPath = join(dir, "config", "sources.json");
  const gate = deferred<SyncRunResult>();
  const controller = new SyncController({ run: () => gate.promise });
  const server = createControlServer(controller, ctx(true, { enabled: true, path: configPath, secretsPath: null }));
  const base = await listen(server);
  try {
    const started = await fetch(`${base}/api/sync-runs`, {
      method: "POST",
      headers: { [SYNC_CONTROL_HEADER]: "1" },
      body: "{}",
    });
    assert.equal(started.status, 202);
    const runId = (await json(started)).current.run_id;

    // edit config while the run is active
    const put = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { [SYNC_CONTROL_HEADER]: "1" },
      body: JSON.stringify({
        db_path: join(dir, "board.db"),
        sources: [
          {
            source_id: "github:github.com",
            kind: "github",
            host: "github.com",
            token_env: "MIDRUN_TEST_TOKEN",
            graphql_url: "https://api.github.com/graphql",
            projects: ["a/b"],
          },
        ],
      }),
    });
    assert.equal(put.status, 200);

    // the active run is still the same run, still running
    const current = (await json(await fetch(`${base}/api/sync-runs/current`))).current;
    assert.equal(current.run_id, runId);
    assert.equal(current.status, "running");

    // and it finishes normally after the edit
    gate.resolve(okResult());
    await until(async () => (await json(await fetch(`${base}/api/sync-runs/current`))).current === null);
    const last = (await json(await fetch(`${base}/api/sync-runs/last`))).last;
    assert.equal(last.run_id, runId);
    assert.equal(last.status, "ok");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets surface is write-only: set/remove tokens, report booleans, never values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "secrets-control-test-"));
  const configPath = join(dir, "config", "sources.json");
  const secretsPath = join(dir, "secrets.env");
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });
  const server = createControlServer(controller, ctx(true, { enabled: true, path: configPath, secretsPath }));
  const base = await listen(server);
  const PUT = (body: unknown) =>
    fetch(`${base}/api/secrets`, { method: "PUT", headers: { [SYNC_CONTROL_HEADER]: "1" }, body: JSON.stringify(body) });
  try {
    // write a config that references two token env names
    const source = (id: string, tokenEnv: string) => ({
      source_id: id,
      kind: "github",
      host: "github.com",
      token_env: tokenEnv,
      graphql_url: "https://api.github.com/graphql",
      projects: ["a/b"],
    });
    const cfgPut = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { [SYNC_CONTROL_HEADER]: "1" },
      body: JSON.stringify({
        db_path: join(dir, "board.db"),
        sources: [source("github:github.com", "SECRETS_TEST_TOKEN_A"), source("github:ghe.example.com", "SECRETS_TEST_TOKEN_B")],
      }),
    });
    assert.equal(cfgPut.status, 200);

    // both names report unset; the surface is writable
    let listed = await json(await fetch(`${base}/api/secrets`));
    assert.deepEqual(listed, {
      enabled: true,
      writable: true,
      secrets: { SECRETS_TEST_TOKEN_A: false, SECRETS_TEST_TOKEN_B: false },
    });

    // guards: header required, env name and value validated
    let res = await fetch(`${base}/api/secrets`, { method: "PUT", body: "{}" });
    assert.equal(res.status, 403);
    res = await PUT({ env: "not a name", value: "x" });
    assert.equal(res.status, 400);
    res = await PUT({ env: "SECRETS_TEST_TOKEN_A", value: "   " });
    assert.equal(res.status, 400);

    // set a token: the response and the listing carry booleans, never the value
    res = await PUT({ env: "SECRETS_TEST_TOKEN_A", value: "ghp_secret_value" });
    assert.equal(res.status, 200);
    const setBody = await json(res);
    assert.deepEqual(setBody, { ok: true, env: "SECRETS_TEST_TOKEN_A", set: true });
    listed = await json(await fetch(`${base}/api/secrets`));
    assert.equal(listed.secrets.SECRETS_TEST_TOKEN_A, true);
    assert.equal(listed.secrets.SECRETS_TEST_TOKEN_B, false);
    assert.ok(!JSON.stringify(listed).includes("ghp_secret_value"));

    // the file is owner-only and preserves unrelated lines on update
    const mode = statSync(secretsPath).mode & 0o777;
    assert.equal(mode, 0o600);
    res = await PUT({ env: "SECRETS_TEST_TOKEN_B", value: "glpat-other" });
    assert.equal(res.status, 200);
    const text = readFileSync(secretsPath, "utf8");
    assert.ok(text.includes("SECRETS_TEST_TOKEN_A=ghp_secret_value"));
    assert.ok(text.includes("SECRETS_TEST_TOKEN_B=glpat-other"));

    // remove: null drops the entry
    res = await PUT({ env: "SECRETS_TEST_TOKEN_A", value: null });
    assert.deepEqual(await json(res), { ok: true, env: "SECRETS_TEST_TOKEN_A", set: false });
    assert.ok(!readFileSync(secretsPath, "utf8").includes("SECRETS_TEST_TOKEN_A"));

    // with no writable secrets file, PUT refuses but GET still reports
    const noFile = createControlServer(controller, ctx(true, { enabled: true, path: configPath, secretsPath: null }));
    const noFileBase = await listen(noFile);
    try {
      const probe = await json(await fetch(`${noFileBase}/api/secrets`));
      assert.equal(probe.writable, false);
      const refused = await fetch(`${noFileBase}/api/secrets`, {
        method: "PUT",
        headers: { [SYNC_CONTROL_HEADER]: "1" },
        body: JSON.stringify({ env: "X", value: "y" }),
      });
      assert.equal(refused.status, 403);
      assert.equal((await json(refused)).error, "secrets_unavailable");
    } finally {
      await close(noFile);
    }
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the recent-log tail (GET /api/logs, the UI Diagnostics page) ---

test("GET /api/logs hides the tail when disabled and serves seq-windowed deltas when enabled", async () => {
  const controller = new SyncController({ run: () => Promise.resolve(okResult()) });

  // Disabled: the capability probe answers enabled:false and leaks nothing.
  const off = createControlServer(controller, ctx(false));
  const offBase = await listen(off);
  try {
    const probe = await json(await fetch(`${offBase}/api/logs`));
    assert.deepEqual(probe, { enabled: false, entries: [], latest_seq: 0, capacity: 0 });
  } finally {
    await close(off);
  }

  // Enabled: lines logged through src/log.ts appear; "?after=" ships deltas.
  const on = createControlServer(controller, ctx(false, NO_CONFIG_CONTROL, true));
  const onBase = await listen(on);
  try {
    log.info("logs-test marker one");
    const full = await json(await fetch(`${onBase}/api/logs`));
    assert.equal(full.enabled, true);
    assert.ok(full.capacity > 0);
    assert.ok(full.entries.some((e: { message: string }) => e.message === "logs-test marker one"));
    assert.equal(full.latest_seq, full.entries[full.entries.length - 1].seq, "latest_seq matches the newest entry");

    log.warn("logs-test marker two");
    const delta = await json(await fetch(`${onBase}/api/logs?after=${full.latest_seq}`));
    assert.equal(delta.entries.length, 1, "only entries newer than ?after=");
    assert.equal(delta.entries[0].level, "warn");
    assert.equal(delta.entries[0].message, "logs-test marker two");

    // Caught up: nothing newer, latest_seq unchanged (the restart signal the
    // UI poller watches is latest_seq dropping BELOW its last-seen seq).
    const none = await json(await fetch(`${onBase}/api/logs?after=${delta.latest_seq}`));
    assert.deepEqual(none.entries, []);
    assert.equal(none.latest_seq, delta.latest_seq);
  } finally {
    await close(on);
  }
});
