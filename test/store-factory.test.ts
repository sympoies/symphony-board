// Driver selection: src/db/factory.ts owns "which store does this config
// mean". The pg path itself is gated by scripts/ci/pg-e2e.sh; here we pin the
// selection rules, which must hold without any Postgres around.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.ts";
import { describeConfiguredStore, openConfiguredStore } from "../src/db/factory.ts";

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

test("describeConfiguredStore names the env var, never the URL", () => {
  assert.equal(describeConfiguredStore(cfg()), ":memory:");
  assert.equal(describeConfiguredStore(cfg({ db_url_env: "SYMPHONY_DB_URL" })), "postgres (via env SYMPHONY_DB_URL)");
});
