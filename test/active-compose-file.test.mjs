import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveComposeFile } from "../scripts/active-compose-file.mjs";
import { resolveRuntime, parseEnvContent } from "../scripts/lib/repo-env.mjs";

const CLI = fileURLToPath(new URL("../scripts/active-compose-file.mjs", import.meta.url));
// An explicit SYMPHONY_BOARD_ENV in the child env wins over any repo .env, so
// these stay deterministic regardless of the checkout's .env.
const runCli = (value) =>
  spawnSync(process.execPath, [CLI], {
    encoding: "utf8",
    env: value === undefined ? { ...process.env } : { ...process.env, SYMPHONY_BOARD_ENV: value },
  });

// deploy.sh must pick its docker compose stack from the SAME SYMPHONY_BOARD_ENV
// switch project-review-cleanup reads, so the two never target different stacks.

test("resolveComposeFile maps postgres to the Postgres stack", () => {
  assert.equal(
    resolveComposeFile({ processEnv: { SYMPHONY_BOARD_ENV: "postgres" }, repoEnv: {} }),
    "docker/compose.pg.yaml",
  );
});

test("resolveComposeFile maps sqlite to the default SQLite stack", () => {
  assert.equal(
    resolveComposeFile({ processEnv: { SYMPHONY_BOARD_ENV: "sqlite" }, repoEnv: {} }),
    "docker/compose.yaml",
  );
});

test("resolveComposeFile defaults to the SQLite stack when the switch is unset", () => {
  assert.equal(resolveComposeFile({ processEnv: {}, repoEnv: {} }), "docker/compose.yaml");
  assert.equal(resolveComposeFile(), "docker/compose.yaml");
});

test("resolveComposeFile falls back to the repo .env when the process env is unset", () => {
  assert.equal(
    resolveComposeFile({ processEnv: {}, repoEnv: { SYMPHONY_BOARD_ENV: "postgres" } }),
    "docker/compose.pg.yaml",
  );
});

test("an explicit process env wins over the repo .env (same precedence as review-cleanup)", () => {
  assert.equal(
    resolveComposeFile({ processEnv: { SYMPHONY_BOARD_ENV: "sqlite" }, repoEnv: { SYMPHONY_BOARD_ENV: "postgres" } }),
    "docker/compose.yaml",
  );
});

test("SYMPHONY_BOARD_RUNTIME is honored as an alias", () => {
  assert.equal(
    resolveComposeFile({ processEnv: { SYMPHONY_BOARD_RUNTIME: "postgres" }, repoEnv: {} }),
    "docker/compose.pg.yaml",
  );
});

test("resolveComposeFile is case- and whitespace-insensitive", () => {
  assert.equal(
    resolveComposeFile({ processEnv: { SYMPHONY_BOARD_ENV: "  POSTGRES  " }, repoEnv: {} }),
    "docker/compose.pg.yaml",
  );
});

test("an unsupported runtime throws a usage error", () => {
  assert.throws(
    () => resolveComposeFile({ processEnv: { SYMPHONY_BOARD_ENV: "mysql" }, repoEnv: {} }),
    (err) => err.usage === true && /unsupported SYMPHONY_BOARD_ENV=mysql/.test(err.message),
  );
});

test("resolveRuntime preserves the unset-vs-sqlite distinction review-cleanup needs", () => {
  assert.equal(resolveRuntime({ processEnv: {}, repoEnv: {} }), "");
  assert.equal(resolveRuntime({ processEnv: { SYMPHONY_BOARD_ENV: "sqlite" }, repoEnv: {} }), "sqlite");
  assert.equal(resolveRuntime({ processEnv: { SYMPHONY_BOARD_ENV: "postgres" }, repoEnv: {} }), "postgres");
});

test("the CLI prints exactly the compose path + newline and exits 0 (the contract deploy.sh captures)", () => {
  const pg = runCli("postgres");
  assert.equal(pg.status, 0);
  assert.equal(pg.stdout, "docker/compose.pg.yaml\n");

  const sqlite = runCli("sqlite");
  assert.equal(sqlite.status, 0);
  assert.equal(sqlite.stdout, "docker/compose.yaml\n");
});

test("the CLI exits 2 with a usage message and no stdout on an unsupported runtime", () => {
  const bad = runCli("mysql");
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /unsupported SYMPHONY_BOARD_ENV=mysql/);
});

test("parseEnvContent reads simple keys, ignores comments/blanks, strips quotes and export", () => {
  const env = parseEnvContent(
    ["# comment", "", "SYMPHONY_BOARD_ENV=postgres", 'GITHUB_TOKEN="ghp_x"', "export FOO='bar'", "BAD LINE"].join("\n"),
  );
  assert.equal(env.SYMPHONY_BOARD_ENV, "postgres");
  assert.equal(env.GITHUB_TOKEN, "ghp_x");
  assert.equal(env.FOO, "bar");
  assert.equal("BAD LINE" in env, false);
});
