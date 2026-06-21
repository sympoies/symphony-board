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

function workflowBasenameFunction(): string {
  const match = workflow.match(
    /# BEGIN test:resolve_live_config_basename\n(?<body>[\s\S]*?)\n\s*# END test:resolve_live_config_basename/,
  );
  assert.ok(match?.groups?.body, "workflow exposes the tested basename parser block");
  return match.groups.body
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function resolveBasename(envText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "live-config-"));
  try {
    const envPath = join(dir, ".env");
    const scriptPath = join(dir, "resolve.sh");
    writeFileSync(envPath, envText, "utf8");
    writeFileSync(
      scriptPath,
      `set -euo pipefail\n${workflowBasenameFunction()}\nresolve_live_config_basename "$1"\n`,
      "utf8",
    );
    return execFileSync("bash", [scriptPath, envPath], {
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
    /resolve_live_config_basename "\$stack_env"/,
    "the deploy must honor the stack's configured source basename",
  );
  assert.doesNotMatch(
    workflow,
    /\$infra\/scripts\/live-config-basename\.sh/,
    "the deploy job does not check out this repo, so basename parsing must not call a missing external helper",
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
      const scriptPath = join(dir, "resolve.sh");
      writeFileSync(envPath, `SYMPHONY_CONFIG_BASENAME=${value}\n`, "utf8");
      writeFileSync(
        scriptPath,
        `set -euo pipefail\n${workflowBasenameFunction()}\nresolve_live_config_basename "$1"\n`,
        "utf8",
      );
      assert.throws(
        () => execFileSync("bash", [scriptPath, envPath], { stdio: "pipe" }),
        /Command failed/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
