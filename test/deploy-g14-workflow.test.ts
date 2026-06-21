import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy-g14.yml", import.meta.url),
  "utf8",
);
const helper = new URL("../scripts/live-config-basename.sh", import.meta.url);

function resolveBasename(envText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "live-config-"));
  try {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, envText, "utf8");
    return execFileSync("bash", [helper.pathname, envPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deploy-g14 derives the Live allowlist from the configured source basename", () => {
  assert.match(
    workflow,
    /live-config-basename\.sh/,
    "the deploy must honor the stack's configured source basename",
  );
  assert.doesNotMatch(
    workflow,
    /live-allowlist\.sh" "\$infra\/stacks\/symphony-board\/config\/sources\.pg\.json"/,
    "the allowlist command must not hard-code the default pg source file",
  );
  assert.match(
    workflow,
    /config\/\$config_basename/,
    "the allowlist command should read config/$SYMPHONY_CONFIG_BASENAME",
  );
});

test("live-config-basename resolves defaults, quotes, exports, and last assignment wins", () => {
  assert.equal(resolveBasename(""), "sources.pg.json");
  assert.equal(resolveBasename("SYMPHONY_CONFIG_BASENAME=sources.live.json\n"), "sources.live.json");
  assert.equal(resolveBasename("export SYMPHONY_CONFIG_BASENAME=\"sources.custom.json\"\n"), "sources.custom.json");
  assert.equal(
    resolveBasename("SYMPHONY_CONFIG_BASENAME=sources.old.json\nSYMPHONY_CONFIG_BASENAME='sources.new.json'\n"),
    "sources.new.json",
  );
});

test("live-config-basename rejects path-like or empty basenames", () => {
  for (const value of ["../sources.json", "nested/sources.json", ""]) {
    const dir = mkdtempSync(join(tmpdir(), "live-config-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, `SYMPHONY_CONFIG_BASENAME=${value}\n`, "utf8");
      assert.throws(
        () => execFileSync("bash", [helper.pathname, envPath], { stdio: "pipe" }),
        /Invalid SYMPHONY_CONFIG_BASENAME/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
