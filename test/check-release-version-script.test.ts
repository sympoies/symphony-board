import { mkdtempSync, mkdirSync, writeFileSync, cpSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

// The apps scripts/check-app-versions.sh asserts against, in the order it
// reports them. check-release-version.sh delegates to that gate, so the fixture
// must carry a matching per-app version tree or the per-app gate trips before the
// tag-vs-package comparison under test is reached.
const RELEASE_APPS = ["desktop", "desktop-standalone", "android"];

// Scaffold the four version-bearing files per app that check-app-versions.sh
// reads, all pinned to `version`. The Cargo.toml/Cargo.lock shapes match the
// `^version = "…"` and `name = "symphony-board-<app>"` parsing in that script.
function writeReleaseAppVersions(dir: string, version: string): void {
  for (const app of RELEASE_APPS) {
    const crate = `symphony-board-${app}`;
    const tauri = join(dir, "packages", app, "src-tauri");
    mkdirSync(tauri, { recursive: true });
    writeFileSync(
      join(dir, "packages", app, "package.json"),
      JSON.stringify({ name: `@symphony-board/${app}`, version }, null, 2),
    );
    writeFileSync(join(tauri, "tauri.conf.json"), JSON.stringify({ version }, null, 2));
    writeFileSync(join(tauri, "Cargo.toml"), `[package]\nname = "${crate}"\nversion = "${version}"\nedition = "2021"\n`);
    writeFileSync(join(tauri, "Cargo.lock"), `[[package]]\nname = "${crate}"\nversion = "${version}"\n`);
  }
}

function fixtureRepo(version = "1.2.3"): string {
  const dir = mkdtempSync(join(tmpdir(), "symphony-release-version-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(new URL("../scripts/check-release-version.sh", import.meta.url), join(dir, "scripts/check-release-version.sh"));
  cpSync(new URL("../scripts/check-app-versions.sh", import.meta.url), join(dir, "scripts/check-app-versions.sh"));
  chmodSync(join(dir, "scripts/check-release-version.sh"), 0o755);
  chmodSync(join(dir, "scripts/check-app-versions.sh"), 0o755);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "symphony-board", version }, null, 2));
  writeReleaseAppVersions(dir, version);
  return dir;
}

function runGate(cwd: string, args: string[]) {
  return spawnSync("bash", ["scripts/check-release-version.sh", ...args], { cwd, encoding: "utf8" });
}

test("gate accepts a tag matching package.json and all per-app files", () => {
  const cwd = fixtureRepo();
  const result = runGate(cwd, ["v1.2.3"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: release tag v1\.2\.3 matches package\.json/);
});

test("gate accepts a bare (un-prefixed) tag", () => {
  const cwd = fixtureRepo();
  const result = runGate(cwd, ["1.2.3"]);

  assert.equal(result.status, 0, result.stderr);
});

test("gate rejects a tag that leads package.json", () => {
  const cwd = fixtureRepo();
  // The publish path passes GITHUB_REF_NAME as the tag; a manual/retagged release
  // can move it ahead of package.json. This is the partial-publish hazard the
  // version-gate job blocks before the publish job pushes GHCR tags.
  const result = runGate(cwd, ["v1.2.4"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requested release version v1\.2\.4 does not match package\.json version v1\.2\.3/);
});

test("gate rejects a per-app version drift even when the tag matches", () => {
  const cwd = fixtureRepo();
  writeFileSync(
    join(cwd, "packages/android/src-tauri/tauri.conf.json"),
    JSON.stringify({ version: "1.2.2" }, null, 2),
  );
  const result = runGate(cwd, ["v1.2.3"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /DRIFT\s+packages\/android\/src-tauri\/tauri\.conf\.json/);
});

test("gate requires a tag argument", () => {
  const cwd = fixtureRepo();
  const result = runGate(cwd, []);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: check-release-version\.sh <tag>/);
});

test("gate rejects a non-SemVer tag", () => {
  const cwd = fixtureRepo();
  const result = runGate(cwd, ["v1.2"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag must be SemVer/);
});
