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
type ResumeStub = {
  // What `release view --json targetCommitish` reports: the RELEASED commit,
  // which is deliberately not the fixture checkout's HEAD.
  targetSha?: string;
  // The head SHA the stubbed publish run carries. Defaulting it to `targetSha`
  // would make the run matcher untestable, so callers that care pass a decoy.
  runHeadSha?: string;
  isPrerelease?: boolean;
  // `gh run watch --exit-status` propagates the run's conclusion; a failed
  // publish run has to stop resume rather than fall through to verification.
  watchExit?: number;
  version?: string;
};

function resumeGhStub(stub: ResumeStub = {}): string {
  const targetSha = stub.targetSha ?? "c0ffee1234567890c0ffee1234567890c0ffee12";
  const runHeadSha = stub.runHeadSha ?? targetSha;
  const version = stub.version ?? "9.9.9";
  const watchExit = stub.watchExit ?? 0;
  const isPrerelease = stub.isPrerelease ? "true" : "false";
  return `#!/usr/bin/env sh
sub="$1 $2"
all="$*"
case "$sub" in
  "run list")
    printf '%s\\n' '[{"databaseId":42,"headSha":"${runHeadSha}","url":"https://example.test/run/42"}]'
    exit 0
    ;;
  "run view")
    printf '%s\\n' 'https://example.test/run/42'
    exit 0
    ;;
  "run watch")
    printf '%s\\n' 'run 42 watched'
    exit ${watchExit}
    ;;
  "release view")
    case "$all" in
      *targetCommitish*)
        printf '%s\\n' '${targetSha} ${isPrerelease}'
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

// Every resume test that reaches the discovery loop passes this. Without it a
// regression that stops matching runs by head SHA does not fail — it polls for
// the full 120s default while node:test waits, so the suite looks hung instead
// of red.
const FAST_DISCOVERY = ["--timeout", "1"];

test("resume waits for the publish run of an already-created release and verifies it", () => {
  const cwd = fixtureRepo();
  writeGhStub(cwd, resumeGhStub());

  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9", "--skip-public-verify", ...FAST_DISCOVERY]);

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

test("resume reports the release as incomplete when its publish run failed", () => {
  const cwd = fixtureRepo();
  // The whole promise of resume is that a release is not finished until its
  // publish run succeeded. Without this case, dropping the exit status from the
  // wait leaves every other test green while resume reports `complete` over a
  // failed workflow.
  writeGhStub(cwd, resumeGhStub({ watchExit: 1 }));

  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9", "--skip-public-verify", ...FAST_DISCOVERY]);

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /release: complete/);
  assert.doesNotMatch(result.stdout, /release: verified release asset/);
});

test("resume resolves the released commit rather than the local HEAD", () => {
  const cwd = fixtureRepo();
  // The release was cut from one commit; the local checkout has since moved on.
  // Resume must target the released commit, or it would wait for a publish run
  // that will never exist.
  writeGhStub(cwd, resumeGhStub({ targetSha: "1111111111111111111111111111111111111111" }));

  const result = runRelease(cwd, [
    "--resume",
    "--version",
    "v9.9.9",
    "--skip-public-verify",
    "--skip-desktop-verify",
    ...FAST_DISCOVERY,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: resuming GitHub Release v9\.9\.9 at 1111111111111111111111111111111111111111/);
});

test("resume rejects a publish run whose head is not the released commit", () => {
  const cwd = fixtureRepo();
  // The decoy the previous test cannot provide: a run exists, but for a
  // different commit. Accepting the first run whatever its head SHA would let
  // resume verify one release against another's workflow.
  writeGhStub(
    cwd,
    resumeGhStub({
      targetSha: "1111111111111111111111111111111111111111",
      runHeadSha: "2222222222222222222222222222222222222222",
    }),
  );

  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9", ...FAST_DISCOVERY]);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /publish-image workflow did not appear within 1s for v9\.9\.9 at 1111111111111111111111111111111111111111/,
  );
});

test("resume refuses a release that names a branch instead of a commit", () => {
  const cwd = fixtureRepo();
  // A release cut through the GitHub UI stores a branch name in
  // targetCommitish. That can never match a run's head SHA, so resume has to
  // say so rather than idle out the discovery timeout.
  writeGhStub(cwd, resumeGhStub({ targetSha: "main" }));

  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9", ...FAST_DISCOVERY]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub Release v9\.9\.9 names main, not a commit/);
});

test("resume refuses a release with no resolvable commit", () => {
  const cwd = fixtureRepo();
  writeGhStub(
    cwd,
    `#!/usr/bin/env sh
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  case "$*" in
    *targetCommitish*) printf '%s\\n' ' false'; exit 0 ;;
    *) exit 0 ;;
  esac
fi
exit 1
`,
  );

  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9", ...FAST_DISCOVERY]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve the released commit for v9\.9\.9/);
});

test("resume takes prerelease from the release, not from a flag the operator must retype", () => {
  const cwd = fixtureRepo();
  // publish-image only moves `latest` for a non-prerelease. Resume's premise is
  // that the original invocation's flags are gone, so if it re-derived
  // prerelease from `--prerelease` it would check a `latest` belonging to some
  // earlier release and still report this one complete.
  writeGhStub(cwd, resumeGhStub({ isPrerelease: true }));

  const result = runRelease(cwd, ["--resume", "--version", "v9.9.9", "--skip-public-verify", ...FAST_DISCOVERY]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release: v9\.9\.9 is a prerelease; not verifying the latest tag/);
  assert.doesNotMatch(result.stdout, /release: latest=/);
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
