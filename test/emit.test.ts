import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemRow, SourceRow, Store } from "../src/db/store.ts";
import type { AppConfig } from "../src/config.ts";
import {
  ContractValidationError,
  buildContractEnvelope,
  displayColors,
  emitContractToFile,
} from "../src/contract/emit.ts";

// The producer guard: a contract that fails schema validation must NEVER land on
// disk, and a successful write must never be observable half-finished (the web
// sidecar serves the emitted file directly). These tests run the REAL emit path
// — sync-runner.test.ts deliberately fakes the emit callback to test gating, so
// without this file the guard itself had no coverage.

function itemRow(over: Partial<ItemRow> = {}): ItemRow {
  return {
    item_id: 1,
    source_id: "github:github.com",
    external_id: "ISSUE_abc",
    kind: "issue",
    project_path: "dev-a/repo",
    iid: 7,
    url: "https://github.com/dev-a/repo/issues/7",
    title: "An issue",
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "dev-a",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    review_state: null,
    ci_state: null,
    merge_state: null,
    open_review_threads: null,
    total_review_threads: null,
    milestone: null,
    demand: 3,
    last_seen_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

const SOURCE_ROW: SourceRow = {
  source_id: "github:github.com",
  kind: "github",
  host: "github.com",
  display_name: "GitHub",
  last_success_at: "2026-06-01T00:00:00Z",
  last_status: "ok",
};

// Minimal read-only Store stub: buildContractEnvelope only calls the five list
// methods, so the emit path is testable without a DB.
function fakeStore(items: ItemRow[]): Store {
  return {
    listSources: async () => [SOURCE_ROW],
    listLiveItems: async () => items,
    listLabels: async () => [],
    listLiveEdges: async () => [],
    listActivities: async () => [],
  } as unknown as Store;
}

function appConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    db_path: "unused.db",
    sources: [
      {
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        color: "#1f6feb",
        token_env: "T",
        graphql_url: "https://api.github.com/graphql",
        projects: ["a/b", { path: "c/d", color: "#abc" }],
      },
    ],
    ...over,
  };
}

test("displayColors picks up source-level and per-repo colors, skipping plain paths", () => {
  const { sourceColors, repoColors } = displayColors(appConfig());
  assert.deepEqual(sourceColors, { "github:github.com": "#1f6feb" });
  assert.deepEqual(repoColors, [{ source_id: "github:github.com", project_path: "c/d", color: "#abc" }]);
});

test("a source or repo without a color contributes nothing", () => {
  const cfg = appConfig();
  delete cfg.sources[0]!.color;
  cfg.sources[0]!.projects = ["a/b"];
  const { sourceColors, repoColors } = displayColors(cfg);
  assert.deepEqual(sourceColors, {});
  assert.deepEqual(repoColors, []);
});

test("buildContractEnvelope maps store rows + config colors into the envelope", async () => {
  const env = await buildContractEnvelope(fakeStore([itemRow()]), appConfig(), "2026-06-08T00:00:00.000Z");
  assert.equal(env.generated_at, "2026-06-08T00:00:00.000Z");
  assert.equal(env.items.length, 1);
  assert.equal(env.items[0]!.id, "github:github.com|ISSUE_abc");
  assert.equal(env.sources[0]!.color, "#1f6feb");
});

test("emitContractToFile writes a validated contract atomically and reports counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "emit-test-"));
  try {
    const out = join(dir, "contract.json");
    const counts = await emitContractToFile(fakeStore([itemRow()]), appConfig(), out, "2026-06-08T00:00:00.000Z");
    assert.deepEqual(counts, { items: 1, totalItems: 1, edges: 0, activities: 0 });
    const text = readFileSync(out, "utf8");
    assert.ok(text.endsWith("\n"), "the emitted file is newline-terminated");
    const env = JSON.parse(text) as { items: unknown[]; contract_version: string };
    assert.equal(env.items.length, 1);
    assert.ok(env.contract_version);
    // tmp+rename: the only thing left in the directory is the finished file.
    assert.deepEqual(readdirSync(dir), ["contract.json"], "no temp artifact survives a successful emit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a contract that fails producer validation never lands on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "emit-test-"));
  try {
    const out = join(dir, "contract.json");
    // An enum-violating state: the builder passes it through, the schema rejects it.
    const store = fakeStore([itemRow({ state: "weird" as ItemRow["state"] })]);
    await assert.rejects(
      () => emitContractToFile(store, appConfig(), out, "2026-06-08T00:00:00.000Z"),
      (err: unknown) => {
        assert.ok(err instanceof ContractValidationError);
        assert.ok(err.errors.length > 0, "the violations ride on the error");
        return true;
      },
    );
    assert.equal(existsSync(out), false, "a rejected contract must not land on disk");
    assert.deepEqual(readdirSync(dir), [], "no temp artifact survives a rejected emit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate=false is an explicit escape hatch that writes without the guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "emit-test-"));
  try {
    const out = join(dir, "contract.json");
    const store = fakeStore([itemRow({ state: "weird" as ItemRow["state"] })]);
    await emitContractToFile(store, appConfig(), out, "2026-06-08T00:00:00.000Z", false);
    assert.equal(existsSync(out), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
