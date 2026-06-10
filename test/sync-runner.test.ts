import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/open.ts";
import { executeSyncRun, type PreparedSource, type SyncRunProgress } from "../src/sync-runner.ts";
import type { SourceConfig } from "../src/config.ts";
import type { Source, SourceDescriptor, FetchOptions, FetchResult, RawRecord } from "../src/sources/types.ts";
import type { CanonicalItem, NormalizedBundle } from "../src/model/types.ts";

// A network-free Source, like test/sync-engine.test.ts: it returns a prebuilt
// FetchResult and normalizes from a map, so the runner's per-source orchestration
// and emit gating are exercised offline.
function item(externalId: string, over: Partial<CanonicalItem> = {}): CanonicalItem {
  return {
    sourceId: "fake:test", externalId, kind: "issue", projectPath: "x/y", iid: 1,
    url: "http://x", title: "t", state: "open", stateRaw: "open", stateReason: null,
    isDraft: null, author: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null, mergedAt: null, reviewState: null, ciState: null, mergeState: null,
    milestone: null, demand: 0, ...over,
  };
}

class FakeSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "fake/1";
  private readonly result: FetchResult;
  private readonly bundles: Map<string, NormalizedBundle>;
  constructor(sourceId: string, result: FetchResult, bundles: Map<string, NormalizedBundle>) {
    this.descriptor = { sourceId, kind: "fake", host: "test", displayName: null };
    this.result = result;
    this.bundles = bundles;
  }
  async fetch(_opts: FetchOptions): Promise<FetchResult> {
    return this.result;
  }
  normalize(raw: RawRecord): NormalizedBundle | null {
    return this.bundles.get(raw.externalId) ?? null;
  }
}

class BoomSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "fake/1";
  constructor(sourceId: string) {
    this.descriptor = { sourceId, kind: "fake", host: "test", displayName: null };
  }
  async fetch(): Promise<FetchResult> {
    throw new Error("network down");
  }
  normalize(): NormalizedBundle | null {
    return null;
  }
}

function sc(sourceId: string): SourceConfig {
  return { source_id: sourceId, kind: "fake", host: "test", token_env: "FAKE_TOKEN", graphql_url: "http://x", projects: ["x/y"] };
}

function prepared(sourceId: string, items: CanonicalItem[], opts: { complete?: boolean } = {}): PreparedSource {
  // Scope each item to this source so its FK to the sources row resolves (the
  // engine ensures the source from the descriptor's sourceId).
  const scoped = items.map((it) => ({ ...it, sourceId }));
  const records: RawRecord[] = scoped.map((it) => ({
    entityKind: it.kind, externalId: it.externalId, apiVersion: "fake",
    fetchedAt: "2026-06-01T00:00:00Z", payload: it, contentHash: it.externalId,
  }));
  const bundles = new Map<string, NormalizedBundle>();
  for (const it of scoped) bundles.set(it.externalId, { item: it, labels: [], edges: [], activities: [] });
  const result: FetchResult = { records, watermark: "2026-06-01T00:00:00Z", complete: opts.complete ?? true, error: null };
  return { config: sc(sourceId), source: new FakeSource(sourceId, result, bundles) };
}

test("a successful run emits and reports aggregated totals", async () => {
  const db = openDb(":memory:");
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
  db.close();
});

test("a dry-run never emits and writes nothing", async () => {
  const db = openDb(":memory:");
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
  db.close();
});

test("a failed source fails the run and skips the emit", async () => {
  const db = openDb(":memory:");
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
  db.close();
});

test("a partial (incomplete) sweep still emits — partial is not a failure", async () => {
  const db = openDb(":memory:");
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
  db.close();
});

test("skipped sources are reported without counting as a failure", async () => {
  const db = openDb(":memory:");
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
  db.close();
});

test("each source logs a 'syncing' progress line before its result line", async () => {
  const db = openDb(":memory:");
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
  db.close();
  const syncingA = lines.findIndex((l) => l.includes("[fake:a] syncing"));
  const statusA = lines.findIndex((l) => l.includes("[fake:a] status="));
  assert.ok(syncingA >= 0, "logs a syncing line for fake:a");
  assert.ok(statusA > syncingA, "the syncing line precedes the status line");
  assert.ok(lines.some((l) => l.includes("[fake:b] syncing")), "logs a syncing line for fake:b");
});

test("an emit failure fails the run instead of silently shipping nothing", async () => {
  const db = openDb(":memory:");
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
  db.close();
});

test("onProgress reports the in-flight source and accumulating per-source results", async () => {
  const db = openDb(":memory:");
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
  db.close();
});
