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

// The apps scripts/check-app-versions.sh asserts against, in the order it
// reports them. package-desktop-release.sh re-runs that gate before building, so
// the fixture must carry a matching per-app version tree or the gate trips on
// the missing files before the tag-vs-package check under test is reached.
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

// package-desktop-release.sh `need_command`s these before building. None is
// actually invoked in these tests — the tag-vs-package guard dies first, and on
// a matching tag the run dies at the missing-bundle check before any of them run
// — but they must exist on PATH for the script to get that far.
const STUB_COMMANDS = ["ditto", "rustc", "shasum", "pnpm"];

function fixtureRepo(version = "1.2.3"): string {
  const dir = mkdtempSync(join(tmpdir(), "symphony-package-release-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(new URL("../scripts/package-desktop-release.sh", import.meta.url), join(dir, "scripts/package-desktop-release.sh"));
  cpSync(new URL("../scripts/check-app-versions.sh", import.meta.url), join(dir, "scripts/check-app-versions.sh"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "symphony-board", version }, null, 2));
  writeReleaseAppVersions(dir, version);
  for (const cmd of STUB_COMMANDS) {
    writeFileSync(join(dir, "bin", cmd), "#!/usr/bin/env sh\nexit 0\n");
    chmodSync(join(dir, "bin", cmd), 0o755);
  }

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

function runPackage(cwd: string, args: string[]) {
  // Prepend the fixture bin/ so the stub commands satisfy need_command, then the
  // real PATH so git/node/jq still resolve.
  const path = `${join(cwd, "bin")}:${process.env.PATH ?? ""}`;
  return spawnSync("bash", ["scripts/package-desktop-release.sh", ...args], {
    cwd,
    env: cleanGitEnv({ PATH: path }),
    encoding: "utf8",
  });
}

test("package refuses a --version that does not match package.json", () => {
  const cwd = fixtureRepo();
  // The tag (passed as --version by publish-image.yml from GITHUB_REF_NAME) runs
  // ahead of package.json — a manually published or retagged release. The bundled
  // .app version comes from tauri.conf.json (== package.json), so without this
  // guard the v1.2.4 zip would ship an .app advertising 1.2.3.
  const result = runPackage(cwd, ["--version", "v1.2.4", "--target", "aarch64-apple-darwin", "--skip-build"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requested release version v1\.2\.4 does not match package\.json version v1\.2\.3/);
});

test("package lets a --version matching package.json past the version gate", () => {
  const cwd = fixtureRepo();
  // A matching tag clears check-app-versions.sh and the new tag-vs-package guard,
  // then dies later at the missing built bundle — proving the guard does not
  // false-positive on a correct release.
  const result = runPackage(cwd, ["--version", "v1.2.3", "--target", "aarch64-apple-darwin", "--skip-build"]);

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /does not match package\.json/);
  assert.match(result.stderr, /expected app bundle missing/);
});
