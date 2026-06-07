import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectPaths, tokenFor } from "../src/config.ts";

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
// Write an arbitrary top-level value to exercise the document-shape guards.
function writeRaw(value: unknown): string {
  const p = join(tmp, `raw-${n++}.json`);
  writeFileSync(p, JSON.stringify(value));
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

test("rejects document-shape violations: non-object, missing db_path, no sources", () => {
  assert.throws(() => loadConfig(writeRaw(42)), /is not an object/);
  assert.throws(() => loadConfig(writeRaw(null)), /is not an object/);
  assert.throws(() => loadConfig(writeRaw({ sources: [baseSource()] })), /missing db_path/);
  assert.throws(() => loadConfig(writeRaw({ db_path: "d", sources: [] })), /has no sources/);
  assert.throws(() => loadConfig(writeRaw({ db_path: "d" })), /has no sources/);
});

test("rejects a source missing a required field, an empty projects list, and a piped source_id", () => {
  assert.throws(() => loadConfig(writeConfig(baseSource({ kind: undefined }))), /source missing "kind"/);
  assert.throws(() => loadConfig(writeConfig(baseSource({ graphql_url: undefined }))), /source missing "graphql_url"/);
  assert.throws(() => loadConfig(writeConfig(baseSource({ source_id: "a|b" }))), /must not contain '\|'/);
  assert.throws(() => loadConfig(writeConfig(baseSource({ projects: [] }))), /has no projects/);
});

test("tokenFor reads the declared env var, trims it, and returns null when unset or blank", () => {
  const { cfg } = loadConfig(writeConfig(baseSource({ token_env: "SB_TEST_TOKEN_XYZ" })));
  const s = cfg.sources[0]!;
  delete process.env.SB_TEST_TOKEN_XYZ;
  assert.equal(tokenFor(s), null, "unset env -> null (caller skips the source)");
  process.env.SB_TEST_TOKEN_XYZ = "   ";
  assert.equal(tokenFor(s), null, "all-whitespace -> null");
  process.env.SB_TEST_TOKEN_XYZ = "  ghp_secret  ";
  assert.equal(tokenFor(s), "ghp_secret", "surrounding whitespace is trimmed");
  delete process.env.SB_TEST_TOKEN_XYZ;
});
