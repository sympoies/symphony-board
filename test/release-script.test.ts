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
// reports them. release.sh re-runs that gate, so the fixture must carry a
// matching per-app version tree or the gate trips on the missing files.
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
  const dir = mkdtempSync(join(tmpdir(), "symphony-release-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(new URL("../scripts/release.sh", import.meta.url), join(dir, "scripts/release.sh"));
  cpSync(new URL("../scripts/check-app-versions.sh", import.meta.url), join(dir, "scripts/check-app-versions.sh"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "symphony-board", version }, null, 2));
  writeReleaseAppVersions(dir, version);
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

test("release refuses to cut when a per-app version drifts from package.json", () => {
  const cwd = fixtureRepo();
  // android lags the release version — exactly the PR #263 regression this gate
  // guards. The push/PR ci workflow would catch it, but a release cut from a
  // commit whose ci has not passed would not, so release.sh re-runs the gate.
  writeFileSync(
    join(cwd, "packages/android/src-tauri/tauri.conf.json"),
    JSON.stringify({ version: "1.2.2" }, null, 2),
  );

  const result = runRelease(cwd, ["--dry-run", "v1.2.3"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /DRIFT\s+packages\/android\/src-tauri\/tauri\.conf\.json/);
});

test("release rejects requested versions that do not match package.json", () => {
  const cwd = fixtureRepo();
  const result = runRelease(cwd, ["--dry-run", "--version", "v1.2.4"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requested release version v1\.2\.4 does not match package\.json version v1\.2\.3/);
});

test("verify-only may inspect an older published version", () => {
  const cwd = fixtureRepo();
  const result = runRelease(cwd, [
    "--verify-only",
    "--version",
    "v9.9.9",
    "--skip-public-verify",
    "--skip-desktop-verify",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: tag=v9\.9\.9/);
  assert.match(result.stdout, /release: skipped public GHCR verification/);
  assert.match(result.stdout, /release: skipped desktop release asset verification/);
});

test("verify-only checks desktop release assets", () => {
  const cwd = fixtureRepo();
  writeFileSync(
    join(cwd, "bin/gh"),
    `#!/usr/bin/env sh
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  cat <<'ASSETS'
Symphony-Board-v9.9.9-macos-arm64-unsigned.zip
Symphony-Board-Standalone-v9.9.9-macos-arm64-unsigned.zip
SHA256SUMS-v9.9.9-macos-arm64.txt
ASSETS
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(cwd, "bin/gh"), 0o755);

  const result = runRelease(cwd, ["--verify-only", "--version", "v9.9.9", "--skip-public-verify"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: verified release asset: Symphony-Board-v9\.9\.9-macos-arm64-unsigned\.zip/);
  assert.match(
    result.stdout,
    /release: verified release asset: Symphony-Board-Standalone-v9\.9\.9-macos-arm64-unsigned\.zip/,
  );
});

// A release whose post-create wait is interrupted — the session dies, the
// terminal is closed, the operator hits Ctrl+C — leaves the GitHub Release
// published but unverified. `--execute` then refuses to run again (the release
// exists) and `--verify-only` reads GHCR immediately, so it fails while
// publish-image is still in flight. `--resume` is the recovery path: it never
// mutates, it re-attaches to the publish run for the released commit, waits for
// it, and then runs the same verification the interrupted run never reached.
function resumeGhStub(sha: string, version: string): string {
  return `#!/usr/bin/env sh
sub="$1 $2"
all="$*"
case "$sub" in
  "run list")
    printf '%s\\n' '[{"databaseId":42,"headSha":"${sha}","url":"https://example.test/run/42"}]'
    exit 0
    ;;
  "run view")
    printf '%s\\n' 'https://example.test/run/42'
    exit 0
    ;;
  "run watch")
    printf '%s\\n' 'run 42 completed'
    exit 0
    ;;
  "release view")
    case "$all" in
      *targetCommitish*)
        printf '%s\\n' '${sha}'
        exit 0
        ;;
      *assets*)
        cat <<'ASSETS'
Symphony-Board-v${version}-macos-arm64-unsigned.zip
Symphony-Board-Standalone-v${version}-macos-arm64-unsigned.zip
SHA256SUMS-v${version}-macos-arm64.txt
ASSETS
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
esac
exit 1
`;
}

function writeGhStub(cwd: string, body: string): void {
  writeFileSync(join(cwd, "bin/gh"), body);
  chmodSync(join(cwd, "bin/gh"), 0o755);
}

test("resume waits for the publish run of an already-created release and verifies it", () => {
  const cwd = fixtureRepo();
  writeGhStub(cwd, resumeGhStub("c0ffee1234567890c0ffee1234567890c0ffee12", "9.9.9"));

  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9", "--skip-public-verify"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: resuming GitHub Release v9\.9\.9/);
  assert.match(result.stdout, /release: publish workflow: https:\/\/example\.test\/run\/42/);
  assert.match(result.stdout, /release: verified release asset: Symphony-Board-v9\.9\.9-macos-arm64-unsigned\.zip/);
  assert.match(result.stdout, /release: complete/);
});

test("resume refuses when the release was never created", () => {
  const cwd = fixtureRepo();
  // The default fixture stub fails every gh call, so `release view` reports the
  // release as absent. Resume must not silently fall through to verification of
  // artifacts that cannot exist.
  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no GitHub Release to resume: v9\.9\.9/);
  assert.match(result.stderr, /--execute/);
});

test("resume does not re-run the publish workflow discovery against the wrong commit", () => {
  const cwd = fixtureRepo();
  // The release was cut from one commit; the local checkout has since moved on.
  // Resume must target the released commit, not HEAD, or it would wait forever
  // for a publish run that will never exist.
  writeGhStub(cwd, resumeGhStub("1111111111111111111111111111111111111111", "9.9.9"));

  const result = runRelease(cwd, [
    "--resume",
    "--version",
    "v9.9.9",
    "--skip-public-verify",
    "--skip-desktop-verify",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: resuming GitHub Release v9\.9\.9 at 1111111111111111111111111111111111111111/);
});

test("execute points at resume when the release already exists", () => {
  const cwd = fixtureRepo();
  // Exactly the interrupted-wait state: the release is published, so a rerun of
  // --execute is refused. The refusal has to name the recovery command, or the
  // operator is left reconstructing it by hand.
  writeGhStub(cwd, "#!/usr/bin/env sh\nif [ \"$1\" = \"release\" ] && [ \"$2\" = \"view\" ]; then exit 0; fi\nexit 1\n");

  const result = runRelease(cwd, ["--execute", "--skip-main-check", "--skip-clean-check"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub Release already exists: v1\.2\.3/);
  assert.match(result.stderr, /scripts\/release\.sh --resume --version v1\.2\.3/);
});
