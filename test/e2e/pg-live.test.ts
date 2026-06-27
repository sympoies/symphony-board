// Live Postgres e2e: a REAL Postgres (scripts/ci/pg-e2e.sh docker-composes a
// throwaway one) taken from zero — empty database — through migration, a full
// sync, an incremental sync, the disappearance sweep, contract emission, and
// the writer-lease guarantees, all through the same engine/runner code
// the daemon runs. Providers are network-free fixtures (test/helpers); hitting
// live provider APIs stays out of automated tests by policy.
//
// Lives under test/e2e/ — outside the `test/*.test.ts` glob — so `pnpm test`
// stays Docker-free; `pnpm run test:pg-e2e` (and the CI `pg` job) runs it with
// SYMPHONY_PG_TEST_URL set. Without the env var the suite skips itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.ts";
import type { Store } from "../../src/db/store.ts";
import type { CanonicalActivity } from "../../src/model/types.ts";
import type { ReconciledEdge } from "../../src/model/edges.ts";
import { executeSyncRun } from "../../src/sync-runner.ts";
import { emitContractToFile } from "../../src/contract/emit.ts";
import { validateContract } from "../../src/contract/validate.ts";
import { item, prepared, sc } from "../helpers/fake-source.ts";

const PG_URL = (process.env.SYMPHONY_PG_TEST_URL ?? "").trim();

const GH = "fake:gh";
const GL = "fake:gl";

function activity(externalId: string, occurredAt: string, over: Partial<CanonicalActivity> = {}): CanonicalActivity {
  return {
    sourceId: GH,
    externalId,
    kind: "issue",
    action: "opened",
    projectPath: "x/y",
    targetKind: "issue",
    target: { sourceId: GH, externalId: "GH_ISSUE_1" },
    targetIid: 1,
    title: "Opened an issue",
    url: "http://x",
    actor: "tester",
    actorKey: `provider-user:${GH}:tester`,
    occurredAt,
    summary: "did a thing",
    details: { source: "e2e" },
    ...over,
  };
}

function closesEdge(): ReconciledEdge {
  return {
    type: "closes",
    from: { sourceId: GH, externalId: "GH_PR_1" },
    to: { sourceId: GH, externalId: "GH_ISSUE_1" },
    fromState: "merged",
    toState: "closed",
    lifecycle: "fulfilled",
    discoveredFrom: "from",
  };
}

test(
  "postgres live e2e: from zero to a fully synced, contract-emitting store",
  { skip: PG_URL.length === 0 ? "SYMPHONY_PG_TEST_URL not set (use pnpm run test:pg-e2e)" : false },
  async (t) => {
    const { openPostgresStore } = await import("../../src/db/postgres.ts");
    const postgres = (await import("postgres")).default;
    const schema = `e2e_${Date.now().toString(36)}`;
    const dir = mkdtempSync(join(tmpdir(), "symphony-pg-e2e-"));
    const contractPath = join(dir, "contract.json");
    const cfg: AppConfig = { db_path: ":memory:", sources: [sc(GH), sc(GL)] };

    // The store under test, plus a second independent handle to the SAME
    // logical store — the "other writer".
    const store = await openPostgresStore(PG_URL, { schema });
    const second = await openPostgresStore(PG_URL, { schema });

    try {
      await t.test("from zero: opening migrated the empty database to the current schema", async () => {
        const diag = await store.diagnostics();
        assert.equal(diag.driver, "postgres");
        assert.equal(diag.schema_version, 10, "all migrations applied on first open");
        const tables = Object.keys((await store.overview(1)).tables).sort();
        assert.deepEqual(
          tables,
          ["activity", "edge", "item", "item_label", "meta", "raw", "repo_activity_bounds", "review_thread", "source", "sync_run", "sync_state"],
          "every canonical table exists in the store's schema",
        );
      });

      await t.test("full sync writes items, edges, and activities, and emits a valid contract", async () => {
        const ghItems = [
          item("GH_ISSUE_1", { kind: "issue", state: "closed", closedAt: "2026-06-02T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z" }),
          item("GH_PR_1", { kind: "change_request", iid: 2, state: "merged", mergedAt: "2026-06-02T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z", isDraft: false }),
        ];
        const glItems = [
          // GitLab-style merged MR: merged_at set, closed_at null.
          item("GL_MR_1", { kind: "change_request", state: "merged", closedAt: null, mergedAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-02T00:00:00Z" }),
        ];
        const activities = new Map([
          [
            "GH_ISSUE_1",
            [
              // Mixed UTC offsets: instant order (not string order) must hold
              // end-to-end through the live driver. 16:59:35+08:00 is
              // 08:59:35Z — the EARLIER instant despite the later string.
              activity("act-utc", "2026-06-08T09:45:23Z"),
              activity("act-local", "2026-06-08T16:59:35.000+08:00"),
            ],
          ],
        ]);
        const edges = new Map([["GH_PR_1", [closesEdge()]]]);

        const result = await executeSyncRun(
          store,
          [
            prepared(GH, ghItems, { edges, activities, watermark: "2026-06-02T00:00:00Z" }),
            prepared(GL, glItems, { watermark: "2026-05-02T00:00:00Z" }),
          ],
          [],
          { mode: "full", dryRun: false, sourceId: null },
          async () => {
            await emitContractToFile(store, cfg, contractPath, "2026-06-11T00:00:00Z");
          },
        );

        assert.equal(result.status, "ok");
        assert.equal(result.emitted, true);
        assert.equal(result.totals.items, 3);
        assert.equal(result.totals.edges, 1);
        assert.equal(result.totals.activities, 2);

        assert.equal((await store.listLiveItems()).length, 3);
        assert.equal((await store.listLiveEdges()).length, 1);
        assert.deepEqual(
          (await store.listActivities()).map((a) => a.external_id),
          ["act-utc", "act-local"],
          "newest instant first: 09:45Z sorts ahead of 16:59+08:00 (= 08:59Z)",
        );
        assert.equal(await store.getWatermark(GH), "2026-06-02T00:00:00Z");

        const contract = JSON.parse(readFileSync(contractPath, "utf8"));
        assert.equal(validateContract(contract).length, 0, "the emitted contract passes the producer schema");
        assert.equal(contract.items.length, 3);
        assert.equal(contract.edges.length, 1);
        assert.equal(contract.sources.length, 2);
      });

      await t.test("incremental sync updates in place and the watermark only moves forward", async () => {
        const result = await executeSyncRun(
          store,
          [prepared(GH, [item("GH_ISSUE_1", { title: "updated title", updatedAt: "2026-06-03T00:00:00Z" })], { watermark: "2026-06-03T00:00:00Z" })],
          [],
          { mode: "incremental", dryRun: false, sourceId: null },
          () => {},
        );
        assert.equal(result.status, "ok");
        const updated = (await store.listLiveItems()).find((r) => r.external_id === "GH_ISSUE_1");
        assert.equal(updated?.title, "updated title");
        assert.equal((await store.listLiveItems()).length, 3, "incremental never tombstones unseen items");
        assert.equal(await store.getWatermark(GH), "2026-06-03T00:00:00Z");

        // The pg driver's GREATEST upsert: an interleaved older run can never
        // regress the watermark.
        await store.updateSyncState(GH, "2026-01-01T00:00:00Z", "ok", null, "2026-06-03T01:00:00Z");
        assert.equal(await store.getWatermark(GH), "2026-06-03T00:00:00Z", "an older watermark is ignored");
      });

      await t.test("disappearance: only a full + complete sweep tombstones unseen items and edges", async () => {
        // Full but INCOMPLETE sweep missing GH_PR_1: must not delete anything.
        const incomplete = await executeSyncRun(
          store,
          [prepared(GH, [item("GH_ISSUE_1", { title: "updated title" })], { complete: false })],
          [],
          { mode: "full", dryRun: false, sourceId: null },
          () => {},
        );
        assert.equal(incomplete.status, "partial");
        assert.equal(incomplete.totals.soft_deleted, 0, "an incomplete sweep never deletes");
        assert.equal((await store.listLiveItems()).length, 3);

        // Full + complete sweep missing GH_PR_1: the item and the intra-source
        // edge it carried disappear; the GL source is untouched.
        const complete = await executeSyncRun(
          store,
          [prepared(GH, [item("GH_ISSUE_1", { title: "updated title" })])],
          [],
          { mode: "full", dryRun: false, sourceId: null },
          () => {},
        );
        assert.equal(complete.status, "ok");
        assert.equal(complete.totals.soft_deleted, 1, "the unseen item tombstoned");
        assert.equal(complete.totals.soft_deleted_edges, 1, "the unseen intra-source edge tombstoned");
        const live = (await store.listLiveItems()).map((r) => r.external_id).sort();
        assert.deepEqual(live, ["GH_ISSUE_1", "GL_MR_1"]);
        assert.equal((await store.listLiveEdges()).length, 0);
        const ov = await store.overview(10);
        assert.equal(ov.items.tombstoned, 1);
        assert.equal(ov.edges.tombstoned, 1);
      });

      await t.test("a second concurrent writer is refused and its run skips wholesale", async () => {
        assert.equal(await store.acquireWriterLease(), true, "the first handle holds the lease");
        let emitCalls = 0;
        const refused = await executeSyncRun(
          second,
          [prepared(GH, [item("INTRUDER")])],
          [],
          { mode: "full", dryRun: false, sourceId: null },
          () => {
            emitCalls++;
          },
        );
        assert.equal(refused.status, "skipped");
        assert.equal(refused.emitted, false);
        assert.equal(emitCalls, 0);
        assert.equal(
          (await store.listLiveItems()).some((r) => r.external_id === "INTRUDER"),
          false,
          "the refused run wrote nothing",
        );
        await store.releaseWriterLease();
      });

      await t.test("a crashed holder's lease auto-releases with its session — no TTL machinery", async () => {
        assert.equal(await second.acquireWriterLease(), true);
        const pid = Number((await second.diagnostics()).lease_pid);
        assert.ok(pid > 0, "the held lease exposes its backend pid");

        // Kill the holder's backend out from under it — a real crash, not a
        // clean release. The session dies, and Postgres drops its advisory
        // locks with it.
        const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
        try {
          await admin`SELECT pg_terminate_backend(${pid})`;
        } finally {
          await admin.end({ timeout: 5 });
        }

        // Backend teardown is asynchronous; the lock must be free shortly.
        let acquired = false;
        for (let i = 0; i < 40 && !acquired; i++) {
          acquired = await store.acquireWriterLease();
          if (!acquired) await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(acquired, true, "the dead holder's lease became acquirable");
        await store.releaseWriterLease();
      });

      await t.test("the run history records the whole journey", async () => {
        const runs = (await store.overview(20)).sync_runs;
        // full(2 sources) + incremental + full-incomplete + full-complete; the
        // refused run never opened a run row.
        assert.equal(runs.length, 5);
        assert.deepEqual(
          runs.map((r) => r.status).sort(),
          ["ok", "ok", "ok", "ok", "partial"],
          "every run row reached a terminal status",
        );
      });
    } finally {
      await store.close();
      await second.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "postgres read-only open: a pinned read-only session that never migrates",
  { skip: PG_URL.length === 0 ? "SYMPHONY_PG_TEST_URL not set (use pnpm run test:pg-e2e)" : false },
  async () => {
    const { openPostgresStore, openPostgresStoreReadOnly } = await import("../../src/db/postgres.ts");
    const schema = `ro_${Date.now().toString(36)}`;

    // A store the writer has never migrated is an error at open — the
    // read-only path must refuse, never migrate (the writer owns migrations).
    await assert.rejects(
      openPostgresStoreReadOnly(PG_URL, { schema }),
      /schema version 0 is older than expected/,
      "an unmigrated store is refused, mirroring the SQLite read-only open",
    );

    const writer = await openPostgresStore(PG_URL, { schema });
    try {
      await writer.ensureSource({ sourceId: GH, kind: "github", host: "github.com", displayName: "GitHub" }, "2026-06-01T00:00:00Z");
      await writer.upsertItem(item("GH_ISSUE_RO", { sourceId: GH }), "test", "2026-06-01T00:00:00Z");

      const ro = await openPostgresStoreReadOnly(PG_URL, { schema });
      try {
        const diag = await ro.diagnostics();
        assert.equal(diag.driver, "postgres");
        assert.equal(diag.schema_version, 10, "the migrated store opens at the current schema");
        assert.equal((await ro.listSources()).length, 1);
        assert.equal((await ro.listLiveItems()).length, 1);

        await assert.rejects(
          ro.ensureSource({ sourceId: "x", kind: "github", host: "x", displayName: null }, "2026-06-01T00:00:00Z"),
          /read-only/i,
          "the session is pinned read-only at the server, so writes fail loudly",
        );
        await assert.rejects(
          ro.transaction(async (tx) => {
            await tx.upsertItem(item("INTRUDER_RO", { sourceId: GH }), "test", "2026-06-01T00:00:00Z");
          }),
          /read-only/i,
          "transaction() on the read-only handle cannot write either",
        );
      } finally {
        await ro.close();
      }
      assert.equal((await writer.listLiveItems()).length, 1, "nothing leaked through the read-only handle");
    } finally {
      await writer.close();
    }
  },
);
