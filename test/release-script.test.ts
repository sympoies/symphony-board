import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

function cleanGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) {
    delete env[key];
  }
  return env;
}

function fixtureRepo(version = "1.2.3"): string {
  const dir = mkdtempSync(join(tmpdir(), "symphony-release-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(new URL("../scripts/release.sh", import.meta.url), join(dir, "scripts/release.sh"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "symphony-board", version }, null, 2));
  writeFileSync(join(dir, "bin/gh"), "#!/usr/bin/env sh\nexit 1\n");
  chmodSync(join(dir, "bin/gh"), 0o755);

  const init = spawnSync("git", ["init", "--quiet"], { cwd: dir, encoding: "utf8", env: cleanGitEnv() });
  assert.equal(init.status, 0, init.stderr);
  const remote = spawnSync("git", ["remote", "add", "origin", "git@github.com:sympoies/symphony-board.git"], {
    cwd: dir,
    encoding: "utf8",
    env: cleanGitEnv(),
  });
  assert.equal(remote.status, 0, remote.stderr);

  return dir;
}

function runRelease(cwd: string, args: string[]) {
  const path = `${join(cwd, "bin")}:${process.env.PATH ?? ""}`;
  return spawnSync("bash", ["scripts/release.sh", ...args], {
    cwd,
    env: cleanGitEnv({ PATH: path }),
    encoding: "utf8",
  });
}

test("release accepts a positional version matching package.json", () => {
  const cwd = fixtureRepo();
  const result = runRelease(cwd, ["--dry-run", "v1.2.3"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: tag=v1\.2\.3/);
  assert.match(result.stdout, /release: app_version=1\.2\.3/);
});

test("release rejects requested versions that do not match package.json", () => {
  const cwd = fixtureRepo();
  const result = runRelease(cwd, ["--dry-run", "--version", "v1.2.4"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requested release version v1\.2\.4 does not match package\.json version v1\.2\.3/);
});

test("verify-only may inspect an older published version", () => {
  const cwd = fixtureRepo();
  const result = runRelease(cwd, ["--verify-only", "--version", "v9.9.9", "--skip-public-verify"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: tag=v9\.9\.9/);
  assert.match(result.stdout, /release: skipped public GHCR verification/);
});
