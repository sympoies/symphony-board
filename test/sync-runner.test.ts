import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import type { Store } from "../src/db/store.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import { executeSyncRun, runConfiguredSync, type SyncRunProgress } from "../src/sync-runner.ts";
// Network-free Source fakes (FakeSource/BoomSource/prepared) shared with the
// Postgres live e2e; see test/helpers/fake-source.ts.
import { BoomSource, item, prepared, sc } from "./helpers/fake-source.ts";

test("a successful run emits and reports aggregated totals", async () => {
  const db = await openSqliteStore(":memory:");
  let emitCalls = 0;
  const result = await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1"), item("A2")]), prepared("fake:b", [item("B1")])],
    [],
    { mode: "full", dryRun: false, sourceId: null },
    () => { emitCalls++; },
  );
  assert.equal(result.status, "ok");
  assert.equal(result.emitted, true);
  assert.equal(emitCalls, 1, "emit runs exactly once on a successful non-dry run");
  assert.equal(result.totals.items, 3);
  assert.equal(result.sources.length, 2);
  await db.close();
});

test("a dry-run never emits and writes nothing", async () => {
  const db = await openSqliteStore(":memory:");
  let emitCalls = 0;
  const result = await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1")])],
    [],
    { mode: "incremental", dryRun: true, sourceId: null },
    () => { emitCalls++; },
  );
  assert.equal(result.emitted, false);
  assert.equal(emitCalls, 0, "a dry-run never invokes the emit callback");
  await db.close();
});

test("a failed source fails the run and skips the emit", async () => {
  const db = await openSqliteStore(":memory:");
  let emitCalls = 0;
  const result = await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1")]), { config: sc("fake:b"), source: new BoomSource("fake:b") }],
    [],
    { mode: "full", dryRun: false, sourceId: null },
    () => { emitCalls++; },
  );
  assert.equal(result.status, "error");
  assert.equal(result.emitted, false);
  assert.equal(emitCalls, 0, "a failed run must not present stale derived data as fresh");
  assert.equal(result.sources.find((s) => s.source_id === "fake:b")?.error, "network down");
  await db.close();
});

test("a partial (incomplete) sweep still emits — partial is not a failure", async () => {
  const db = await openSqliteStore(":memory:");
  let emitCalls = 0;
  const result = await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1")], { complete: false })],
    [],
    { mode: "full", dryRun: false, sourceId: null },
    () => { emitCalls++; },
  );
  assert.equal(result.status, "partial");
  assert.equal(result.emitted, true);
  assert.equal(emitCalls, 1);
  await db.close();
});

test("disappearance is isolated per source: a sibling's full+complete sweep never deletes a partial source's unseen items", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5)); // later sweeps must start strictly after the seed
  const db = await openSqliteStore(":memory:");
  // Seed both sources full+complete: 2 items each.
  await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1"), item("A2")]), prepared("fake:b", [item("B1"), item("B2")])],
    [],
    { mode: "full", dryRun: false, sourceId: null },
  );
  assert.equal((await db.listLiveItems()).length, 4);
  await tick();

  // Second full run: A completes seeing only A1; B reports an INCOMPLETE sweep
  // seeing nothing. Deletion must apply to A's unseen item only.
  const result = await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1")]), prepared("fake:b", [], { complete: false })],
    [],
    { mode: "full", dryRun: false, sourceId: null },
  );
  assert.equal(result.status, "partial");
  const a = result.sources.find((s) => s.source_id === "fake:a");
  const b = result.sources.find((s) => s.source_id === "fake:b");
  assert.equal(a?.status, "ok");
  assert.equal(a?.soft_deleted, 1, "the complete source tombstones exactly its own unseen item");
  assert.equal(b?.status, "partial");
  assert.equal(b?.soft_deleted, 0, "the incomplete source must not tombstone");
  const live = (await db.listLiveItems()).map((r) => r.external_id).sort();
  assert.deepEqual(live, ["A1", "B1", "B2"], "B's unseen items survive A's full+complete sweep");
  await db.close();
});

test("skipped sources are reported without counting as a failure", async () => {
  const db = await openSqliteStore(":memory:");
  const result = await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1")])],
    ["fake:b"],
    { mode: "full", dryRun: false, sourceId: null },
    () => {},
  );
  assert.equal(result.status, "ok");
  const skipped = result.sources.find((s) => s.source_id === "fake:b");
  assert.equal(skipped?.status, "skipped");
  await db.close();
});

test("runConfiguredSync builds sources with primary and fallback tokens", async () => {
  const cfg: AppConfig = {
    db_path: "unused.db",
    sources: [{
      source_id: "github:github.com",
      kind: "github",
      host: "github.com",
      token_env: "RUNNER_POOL_PRIMARY",
      fallback_token_envs: ["RUNNER_POOL_BACKUP_1"],
      graphql_url: "https://api.github.com/graphql",
      projects: ["o/r"],
    }],
  };
  const seen: unknown[] = [];
  process.env.RUNNER_POOL_PRIMARY = "primary";
  process.env.RUNNER_POOL_BACKUP_1 = "backup";
  try {
    const result = await runConfiguredSync(cfg, { mode: "full", dryRun: true, sourceId: null }, null, {
      openStore: () => openSqliteStore(":memory:"),
      buildSource: (sc, tokens) => {
        seen.push(tokens);
        return prepared(sc.source_id, [item("A1")]).source;
      },
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(seen, [[
      { env: "RUNNER_POOL_PRIMARY", value: "primary" },
      { env: "RUNNER_POOL_BACKUP_1", value: "backup" },
    ]]);
  } finally {
    delete process.env.RUNNER_POOL_PRIMARY;
    delete process.env.RUNNER_POOL_BACKUP_1;
  }
});

test("runConfiguredSync skips disabled sources even when tokens are configured", async () => {
  const cfg: AppConfig = {
    db_path: "unused.db",
    sources: [
      { ...sc("fake:off"), enabled: false },
      sc("fake:on"),
    ],
  };
  const built: string[] = [];
  process.env.FAKE_TOKEN = "token";
  try {
    const result = await runConfiguredSync(cfg, { mode: "full", dryRun: true, sourceId: null }, null, {
      openStore: () => openSqliteStore(":memory:"),
      buildSource: (sourceConfig) => {
        built.push(sourceConfig.source_id);
        return prepared(sourceConfig.source_id, [item("A1")]).source;
      },
    });

    assert.deepEqual(built, ["fake:on"]);
    assert.equal(result.status, "ok");
    assert.equal(result.sources.find((s) => s.source_id === "fake:off")?.status, "skipped");
    assert.equal(result.sources.find((s) => s.source_id === "fake:on")?.status, "ok");
  } finally {
    delete process.env.FAKE_TOKEN;
  }
});

test("runConfiguredSync reports an explicitly scoped disabled source as skipped", async () => {
  const cfg: AppConfig = {
    db_path: "unused.db",
    sources: [{ ...sc("fake:off"), enabled: false }],
  };
  let built = false;
  process.env.FAKE_TOKEN = "token";
  try {
    const result = await runConfiguredSync(cfg, { mode: "full", dryRun: true, sourceId: "fake:off" }, null, {
      openStore: () => openSqliteStore(":memory:"),
      buildSource: (sourceConfig) => {
        built = true;
        return prepared(sourceConfig.source_id, [item("A1")]).source;
      },
    });

    assert.equal(built, false);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.sources.map((s) => [s.source_id, s.status]), [["fake:off", "skipped"]]);
  } finally {
    delete process.env.FAKE_TOKEN;
  }
});

test("each source logs a 'syncing' progress line before its result line", async () => {
  const db = await openSqliteStore(":memory:");
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (msg?: unknown): void => {
    lines.push(String(msg));
  };
  try {
    await executeSyncRun(
      db,
      [prepared("fake:a", [item("A1")]), prepared("fake:b", [item("B1")])],
      [],
      { mode: "full", dryRun: false, sourceId: null },
      () => {},
    );
  } finally {
    console.log = origLog;
  }
  await db.close();
  const syncingA = lines.findIndex((l) => l.includes("[fake:a] syncing"));
  const statusA = lines.findIndex((l) => l.includes("[fake:a] status="));
  assert.ok(syncingA >= 0, "logs a syncing line for fake:a");
  assert.ok(statusA > syncingA, "the syncing line precedes the status line");
  assert.ok(lines.some((l) => l.includes("[fake:b] syncing")), "logs a syncing line for fake:b");
});

test("an emit failure fails the run instead of silently shipping nothing", async () => {
  const db = await openSqliteStore(":memory:");
  const result = await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1")])],
    [],
    { mode: "full", dryRun: false, sourceId: null },
    () => { throw new Error("contract invalid"); },
  );
  assert.equal(result.status, "error");
  assert.equal(result.emitted, false);
  assert.match(result.error ?? "", /contract emit failed: contract invalid/);
  await db.close();
});

// A file-backed store pair for writer-lease runner tests: `holder` simulates
// another live writer process (the daemon), `db` is the store the runner under
// test was handed. Same pattern as the conformance suite's openShared.
async function sharedStores(): Promise<{ holder: Store; db: Store; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "symphony-runner-"));
  const holder = await openSqliteStore(join(dir, "store.db"));
  const db = await openSqliteStore(join(dir, "store.db"));
  return {
    holder,
    db,
    cleanup: async () => {
      await holder.close();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a lease-denied run is skipped entirely: nothing written, nothing emitted", async () => {
  const { holder, db, cleanup } = await sharedStores();
  try {
    assert.equal(await holder.acquireWriterLease(), true, "the other writer holds the lease");
    let emitCalls = 0;
    const result = await executeSyncRun(
      db,
      [prepared("fake:a", [item("A1")])],
      [],
      { mode: "full", dryRun: false, sourceId: null },
      () => { emitCalls++; },
    );
    assert.equal(result.status, "skipped");
    assert.equal(result.emitted, false);
    assert.equal(emitCalls, 0, "a skipped run never emits");
    assert.deepEqual(result.sources, [], "no source was attempted");
    assert.equal((await holder.listLiveItems()).length, 0, "a skipped run writes nothing");
  } finally {
    await cleanup();
  }
});

test("a dry-run needs no writer lease", async () => {
  // A dry-run writes nothing, so it must work while the daemon holds the
  // lease — that is exactly the "inspect a live deployment" use case.
  const { holder, db, cleanup } = await sharedStores();
  try {
    assert.equal(await holder.acquireWriterLease(), true);
    const result = await executeSyncRun(
      db,
      [prepared("fake:a", [item("A1")])],
      [],
      { mode: "full", dryRun: true, sourceId: null },
      () => {},
    );
    assert.equal(result.status, "ok", "the dry-run ran despite the held lease");
    assert.equal(result.totals.items, 1);
  } finally {
    await cleanup();
  }
});

test("the writer lease is released when the run finishes", async () => {
  const { holder, db, cleanup } = await sharedStores();
  try {
    await executeSyncRun(db, [prepared("fake:a", [item("A1")])], [], { mode: "full", dryRun: false, sourceId: null }, () => {});
    assert.equal(await holder.acquireWriterLease(), true, "the lease is free again after the run");
    await holder.releaseWriterLease();
  } finally {
    await cleanup();
  }
});

test("onProgress reports the in-flight source and accumulating per-source results", async () => {
  const db = await openSqliteStore(":memory:");
  const snapshots: SyncRunProgress[] = [];
  await executeSyncRun(
    db,
    [prepared("fake:a", [item("A1")]), prepared("fake:b", [item("B1")])],
    ["fake:skip"],
    { mode: "full", dryRun: false, sourceId: null },
    () => {},
    (p) => snapshots.push(p),
  );
  // One report before each source (naming it active) and one after it finishes.
  const [beforeA, afterA, beforeB, afterB] = snapshots;
  assert.ok(beforeA && afterA && beforeB && afterB, "exactly four progress reports");
  assert.equal(snapshots.length, 4);
  assert.equal(beforeA.active_source_id, "fake:a");
  assert.deepEqual(beforeA.sources.map((s) => s.source_id), ["fake:skip"], "skipped sources are visible from the first report");
  assert.equal(afterA.active_source_id, null);
  assert.deepEqual(afterA.sources.map((s) => s.source_id), ["fake:skip", "fake:a"]);
  assert.equal(beforeB.active_source_id, "fake:b");
  assert.equal(afterB.active_source_id, null);
  assert.equal(afterB.sources.length, 3);
  assert.notEqual(beforeA.sources, afterA.sources, "each report is a snapshot, not an alias of the runner's mutable array");
  await db.close();
});
