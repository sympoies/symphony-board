// Driver selection: src/db/factory.ts owns "which store does this config
// mean". The pg path itself is gated by scripts/ci/pg-e2e.sh; here we pin the
// selection rules, which must hold without any Postgres around.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import { describeConfiguredStore, openConfiguredStore, openConfiguredStoreReadOnly } from "../src/db/factory.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { db_path: ":memory:", sources: [], ...over };
}

test("the factory defaults to SQLite at db_path", async () => {
  const store = await openConfiguredStore(cfg());
  const diag = await store.diagnostics();
  assert.equal(diag.path, ":memory:", "the SQLite driver opened the configured path");
  await store.close();
});

test("a config naming db_url_env fails loudly when the env var is unset", async () => {
  delete process.env.SYMPHONY_TEST_UNSET_DB_URL;
  await assert.rejects(
    openConfiguredStore(cfg({ db_url_env: "SYMPHONY_TEST_UNSET_DB_URL" })),
    /db_url_env, but env SYMPHONY_TEST_UNSET_DB_URL is not set/,
    "silent SQLite fallback would split the canonical store across two databases",
  );
});

test("the read-only factory defaults to SQLite at db_path and refuses writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-factory-"));
  const dbPath = join(dir, "store.db");
  try {
    // The writer migrates; the read-only open never does.
    await (await openSqliteStore(dbPath)).close();

    const ro = await openConfiguredStoreReadOnly(cfg({ db_path: dbPath }));
    const diag = await ro.diagnostics();
    assert.equal(diag.path, dbPath, "the SQLite driver opened the configured path");
    await assert.rejects(
      ro.ensureSource({ sourceId: "x", kind: "github", host: "x", displayName: null }, "2026-06-01T00:00:00Z"),
      /readonly|read-only|attempt/i,
      "writes through the read-only handle fail",
    );
    await ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the read-only factory fails loudly when db_url_env is unset", async () => {
  delete process.env.SYMPHONY_TEST_UNSET_DB_URL;
  await assert.rejects(
    openConfiguredStoreReadOnly(cfg({ db_url_env: "SYMPHONY_TEST_UNSET_DB_URL" })),
    /db_url_env, but env SYMPHONY_TEST_UNSET_DB_URL is not set/,
    "the read-only path keeps the same no-silent-fallback rule as the writer",
  );
});

test("describeConfiguredStore names the env var, never the URL", () => {
  assert.equal(describeConfiguredStore(cfg()), ":memory:");
  assert.equal(describeConfiguredStore(cfg({ db_url_env: "SYMPHONY_DB_URL" })), "postgres (via env SYMPHONY_DB_URL)");
});
