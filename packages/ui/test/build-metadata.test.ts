import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import config from "../vite.config.ts";

test("UI build injects the release-controlled app version and source commit", () => {
  const version = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
  const definition = config.define?.__SYMPHONY_BOARD_BUILD__;
  assert.equal(typeof definition, "string", "Settings needs immutable build metadata in the emitted client");
  const metadata = JSON.parse(definition as string);
  assert.equal(metadata.version, version, "use the release-controlled root version, not the UI workspace version");
  assert.match(metadata.commit, /^[a-f0-9]{7,40}$/i);
});

test("a manual release build identifies the checked-out source, not the triggering workflow ref", async () => {
  const { execFileSync } = await import("node:child_process");
  const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("../../..", import.meta.url), encoding: "utf8" }).trim();
  const priorSha = process.env.GITHUB_SHA;
  const priorCommit = process.env.SYMPHONY_BOARD_BUILD_COMMIT;
  process.env.GITHUB_SHA = "1234567890123456789012345678901234567890";
  delete process.env.SYMPHONY_BOARD_BUILD_COMMIT;
  try {
    const { default: releaseConfig } = await import("../vite.config.ts?manual-release");
    assert.equal(JSON.parse(releaseConfig.define.__SYMPHONY_BOARD_BUILD__).commit, expected);
  } finally {
    if (priorSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = priorSha;
    if (priorCommit === undefined) delete process.env.SYMPHONY_BOARD_BUILD_COMMIT;
    else process.env.SYMPHONY_BOARD_BUILD_COMMIT = priorCommit;
  }
});
