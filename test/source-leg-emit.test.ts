import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AppConfig } from "../src/config.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import { buildContractEnvelope } from "../src/contract/emit.ts";
import { validateContract } from "../src/contract/validate.ts";
import { executeSyncRun, runConfiguredSync } from "../src/sync-runner.ts";
import { SyncController } from "../src/cli/sync-daemon.ts";
import { BoomSource, item, prepared, sc } from "./helpers/fake-source.ts";

const github = "github:github.com";
const gitlab = "gitlab:gitlab.example";
const opts = { mode: "full" as const, dryRun: false, sourceId: null };
const authTokenResolver = {
  tokensForSource: async () => [{ env: "TEST_TOKEN", value: "fixture", kind: "pat" as const, strategy: "failover" as const }],
  tokensForProject: async () => [],
  resolveSourceTokens: async () => [],
};

function currentItem(id: string) {
  return item(id, { updatedAt: new Date().toISOString() });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// JSON is deliberately inspected as wire data: these regressions run before
// the new metadata exists in the producer or mirrored types.
function readContract(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const seeded of [false, true]) {
  test(`GitHub publishes before GitLab finishes (${seeded ? "previous source health" : "empty store"}); final full emit retains all data`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "board-source-leg-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "contract.json");
    const cfg: AppConfig = { db_path: join(dir, "board.db"), sources: [sc(github), sc(gitlab)] };
    const db = await openSqliteStore(cfg.db_path);
    const first = prepared(github, [currentItem("G1")]);
    const second = prepared(gitlab, [currentItem("L1")]);
    // An earlier success must not make a pending leg appear complete this run.
    if (seeded) await executeSyncRun(db, [second], [], opts);
    const entered = deferred();
    const release = deferred();
    const fetchSecond = second.source.fetch.bind(second.source);
    second.source.fetch = async (options) => {
      entered.resolve();
      await release.promise;
      return fetchSecond(options);
    };
    const generatedAt = new Date().toISOString();
    const controller = new SyncController({
      run: (request, onProgress) => runConfiguredSync(cfg, request, path, {
        openStore: async () => db,
        authTokenResolver,
        buildSource: (config) => config.source_id === github ? first.source : second.source,
        now: () => generatedAt,
        onProgress,
      }),
    });
    const run = controller.start(opts, "scheduled");
    try {
      await entered.promise;
      const intermediate = readContract(path);
      assert.equal(intermediate.contract_version, "4.10.0");
      assert.deepEqual(intermediate.sync_run, {
        mode: "full", source_scope: null, status: "running",
        sources: [{ source_id: github, status: "ok" }, { source_id: gitlab, status: "pending" }],
      });
      if (seeded) assert.equal(intermediate.sources.find((s: { source_id: string }) => s.source_id === gitlab).last_status, "ok", "historical health stays separate from current-run coverage");
      assert.ok(intermediate.items.some((i: { source_id: string }) => i.source_id === github));
      assert.deepEqual(validateContract(intermediate), []);
      assert.equal(gunzipSync(readFileSync(`${path}.gz`)).toString(), readFileSync(path, "utf8"));
      assert.ok(Date.now() - statSync(path).mtimeMs < 1_800_000, "same file freshness signal used by container healthcheck");
      assert.equal(controller.current()?.status, "running");
      assert.equal(controller.current()?.emitted, true, "progress acknowledges the published leg before the run finishes");
    } finally {
      release.resolve();
      await run.done;
    }
    try {
      const final = readContract(path);
      assert.deepEqual(final.sync_run, {
        mode: "full", source_scope: null, status: "ok",
        sources: [{ source_id: github, status: "ok" }, { source_id: gitlab, status: "ok" }],
      });
      assert.equal(controller.lastRun()?.status, "ok");
      assert.equal(controller.lastRun()?.totals?.items, 2);
      const expectedDb = await openSqliteStore(cfg.db_path);
      try {
        const expected = await buildContractEnvelope(expectedDb, cfg, final.generated_at);
        const { sync_run: _coverage, ...projection } = final;
        assert.deepEqual(projection, expected, "final full-sync projection is otherwise unchanged");
      } finally { await expectedDb.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

}

for (const failure of ["partial", "error"] as const) {
  for (const failingFirst of [true, false]) {
    test(`${failure} leg ${failingFirst ? "before" : "after"} a successful sibling does not block its emit`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "board-leg-failure-"));
      const path = join(dir, "contract.json");
      const bad = failure === "partial"
        ? prepared(gitlab, [currentItem("L1")], { complete: false }).source
        : new BoomSource(gitlab);
      const good = prepared(github, [currentItem("G1")]).source;
      const ids = failingFirst ? [gitlab, github] : [github, gitlab];
      const cfg: AppConfig = { db_path: "unused.db", sources: ids.map(sc) };
      try {
        const result = await runConfiguredSync(cfg, opts, path, {
          openStore: () => openSqliteStore(":memory:"), authTokenResolver,
          buildSource: (config) => config.source_id === github ? good : bad,
        });
        assert.equal(result.status, failure);
        assert.equal(result.emitted, true);
        const envelope = readContract(path);
        assert.equal(envelope.sync_run.status, failure);
        assert.deepEqual(envelope.sync_run.sources, ids.map((source_id) => ({ source_id, status: source_id === github ? "ok" : failure })));
        assert.ok(envelope.items.some((i: { source_id: string }) => i.source_id === github));
        assert.deepEqual(validateContract(envelope), []);
        assert.equal(envelope.sources.find((s: { source_id: string }) => s.source_id === gitlab).last_status, failure);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test("a single failed leg still does not publish stale data", async () => {
  const db = await openSqliteStore(":memory:");
  let calls = 0;
  try {
    const result = await executeSyncRun(db, [{ config: sc(gitlab), source: new BoomSource(gitlab) }], [], opts, () => { calls++; });
    assert.equal(result.status, "error");
    assert.equal(result.emitted, false);
    assert.equal(calls, 0);
  } finally { await db.close(); }
});

test("a pre-fetch auth failure does not block a sibling and stays explicit in emitted coverage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-leg-auth-"));
  const path = join(dir, "contract.json");
  const cfg: AppConfig = { db_path: "unused.db", sources: [sc(github), sc(gitlab)] };
  try {
    const result = await runConfiguredSync(cfg, opts, path, {
      openStore: () => openSqliteStore(":memory:"),
      authTokenResolver: { ...authTokenResolver, hardMintFailure: (config) => config.source_id === github ? "fixture auth failure" : null },
      buildSource: (config) => prepared(config.source_id, [currentItem("L1")]).source,
    });
    assert.equal(result.status, "error");
    assert.equal(result.emitted, true);
    assert.deepEqual(readContract(path).sync_run.sources, [
      { source_id: github, status: "error" }, { source_id: gitlab, status: "ok" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an intermediate publication failure still runs the next leg and retries the final emit", async () => {
  const db = await openSqliteStore(":memory:");
  let calls = 0;
  try {
    const result = await executeSyncRun(db, [prepared(github, [currentItem("G1")]), prepared(gitlab, [currentItem("L1")])], [], opts, () => {
      if (++calls === 1) throw new Error("temporary output failure");
    });
    assert.equal(calls, 2);
    assert.equal(result.totals.items, 2);
    assert.equal(result.status, "ok");
    assert.equal(result.emitted, true);
    assert.equal(result.error, null);
  } finally { await db.close(); }
});

test("a final emit failure retains the already-published leg and reports failure honestly", async () => {
  const db = await openSqliteStore(":memory:");
  let calls = 0;
  try {
    const result = await executeSyncRun(db, [prepared(github, [currentItem("G1")]), prepared(gitlab, [currentItem("L1")])], [], opts, () => {
      if (++calls === 2) throw new Error("final output failure");
    });
    assert.equal(result.status, "error");
    assert.equal(result.emitted, true, "emitted records the checkpoint that actually shipped");
    assert.match(result.error ?? "", /final output failure/);
  } finally { await db.close(); }
});
