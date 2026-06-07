import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectPaths } from "../src/config.ts";

// loadConfig reads a file, so each case writes a throwaway fixture. The OS would
// reap tmp anyway; we clean up explicitly to keep the dir tidy between runs.
const tmp = mkdtempSync(join(tmpdir(), "sb-config-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function baseSource(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: "github:github.com",
    kind: "github",
    host: "github.com",
    token_env: "GITHUB_TOKEN",
    graphql_url: "https://api.github.com/graphql",
    projects: ["a/b"],
    ...over,
  };
}
function writeConfig(source: Record<string, unknown>): string {
  const p = join(tmp, `cfg-${n++}.json`);
  writeFileSync(p, JSON.stringify({ db_path: "data/symphony.db", sources: [source] }));
  return p;
}

test("projectPaths drops per-repo color metadata and keeps order", () => {
  const path = writeConfig(baseSource({ projects: ["a/b", { path: "c/d", color: "#fff" }, "e/f"] }));
  const { cfg } = loadConfig(path);
  assert.deepEqual(projectPaths(cfg.sources[0]!), ["a/b", "c/d", "e/f"]);
});

test("accepts a source-level color and a per-repo color (3- and 6-digit hex)", () => {
  const path = writeConfig(baseSource({ color: "#1f6feb", projects: [{ path: "c/d", color: "#abc" }] }));
  const { cfg } = loadConfig(path);
  assert.equal(cfg.sources[0]!.color, "#1f6feb");
});

test("rejects a non-hex source color", () => {
  const path = writeConfig(baseSource({ color: "blue" }));
  assert.throws(() => loadConfig(path), /color "blue" is not a hex color/);
});

test("rejects a non-hex per-repo color", () => {
  const path = writeConfig(baseSource({ projects: [{ path: "c/d", color: "red" }] }));
  assert.throws(() => loadConfig(path), /color "red" is not a hex color/);
});

test("rejects a project entry with no path", () => {
  const path = writeConfig(baseSource({ projects: [{ color: "#fff" }] }));
  assert.throws(() => loadConfig(path), /project entry with no "path"/);
});
