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
  const path = writeConfig(baseSource({ color: "#1f6feb", rest_url: "https://api.github.com", projects: [{ path: "c/d", color: "#abc" }] }));
  const { cfg } = loadConfig(path);
  assert.equal(cfg.sources[0]!.color, "#1f6feb");
  assert.equal(cfg.sources[0]!.rest_url, "https://api.github.com");
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

test("rejects a non-string rest_url", () => {
  const path = writeConfig(baseSource({ rest_url: 42 }));
  assert.throws(() => loadConfig(path), /rest_url must be a string/);
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

// A full config (db_path + one valid source) plus an arbitrary identities value,
// so the identity guards can be exercised independently of the source guards.
function writeWithIdentities(identities: unknown): string {
  return writeRaw({ db_path: "data/symphony.db", sources: [baseSource()], identities });
}

test("accepts a valid identities map and leaves it on the config", () => {
  const { cfg } = loadConfig(
    writeWithIdentities([{ name: "Terry Lin", usernames: ["terrylin"], emails: ["terry@example.com"], names: ["Terry LIN"] }]),
  );
  assert.equal(cfg.identities?.length, 1);
  assert.equal(cfg.identities?.[0]!.name, "Terry Lin");
  assert.deepEqual(cfg.identities?.[0]!.usernames, ["terrylin"]);
});

test("rejects a malformed identities map", () => {
  assert.throws(() => loadConfig(writeWithIdentities({})), /"identities" must be an array/);
  assert.throws(() => loadConfig(writeWithIdentities([{ usernames: ["x"] }])), /needs a non-empty "name"/);
  assert.throws(() => loadConfig(writeWithIdentities([{ name: "  " }])), /needs a non-empty "name"/);
  assert.throws(() => loadConfig(writeWithIdentities([{ name: "X", emails: "a@b.com" }])), /emails must be an array of strings/);
  assert.throws(() => loadConfig(writeWithIdentities([{ name: "X", usernames: [1] }])), /usernames must be an array of strings/);
});
