import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `scripts/install-hooks.sh` is the package `prepare` script. Its whole reason
// to exist is a host that manages `core.hooksPath` globally: `lefthook install`
// refuses to run there, which fails `pnpm install`, which then fails every
// later `pnpm <script>` through pnpm's deps-status re-install.
//
// Every case below runs against a THROWAWAY global git config
// (`GIT_CONFIG_GLOBAL`), never the machine's own, so the suite can assert on
// the managed-hooks-path behavior without touching the host.

const SCRIPT = fileURLToPath(new URL("../scripts/install-hooks.sh", import.meta.url));
const LEFTHOOK = fileURLToPath(new URL("../node_modules/.bin/lefthook", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// A stand-in for a host dispatcher: it chains into the repository's own hook,
// which is exactly why lefthook's hooks only need to reach `.git/hooks`.
const DISPATCHER = `#!/bin/bash
echo "dispatcher ran"
common_dir="$(git rev-parse --git-common-dir 2>/dev/null)"
hook="$common_dir/hooks/pre-push"
if [ -x "$hook" ] && [ "$hook" != "$0" ]; then exec "$hook" "$@"; fi
exit 0
`;

interface Sandbox {
  dir: string;
  repo: string;
  globalHooks: string;
  gitconfig: string;
}

// The script resolves its target from its OWN location, like every other script
// here, so a sandbox gets its own copy rather than being passed as a cwd.
function placeScript(root: string): string {
  mkdirSync(join(root, "scripts"), { recursive: true });
  const copy = join(root, "scripts/install-hooks.sh");
  copyFileSync(SCRIPT, copy);
  chmodSync(copy, 0o755);
  return copy;
}

function sandbox(t: { after: (fn: () => void) => void }, opts: { managedHooksPath: boolean }): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "symphony-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repo = join(dir, "repo");
  const globalHooks = join(dir, "global-hooks");
  const gitconfig = join(dir, "gitconfig");
  mkdirSync(repo);
  mkdirSync(globalHooks);
  writeFileSync(join(globalHooks, "pre-push"), DISPATCHER);
  chmodSync(join(globalHooks, "pre-push"), 0o755);
  writeFileSync(gitconfig, "");

  const git = (...args: string[]): void => {
    const res = spawnSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig } });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr?.toString() ?? ""}`);
  };
  git("init", "-q", "-b", "main", ".");
  git("config", "--global", "user.email", "sandbox@example.com");
  git("config", "--global", "user.name", "sandbox");
  if (opts.managedHooksPath) git("config", "--global", "core.hooksPath", globalHooks);

  writeFileSync(join(repo, "lefthook.yml"), 'pre-push:\n  commands:\n    hello:\n      run: echo "lefthook ran"\n');
  placeScript(repo);
  return { dir, repo, globalHooks, gitconfig };
}

function runScript(box: Sandbox, root = box.repo) {
  return spawnSync("bash", [join(root, "scripts/install-hooks.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: box.gitconfig,
      // `prepare` runs with the package's bin directory on PATH; mirror that
      // rather than depending on a lefthook installed on the host.
      PATH: `${join(REPO_ROOT, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    },
  });
}

test("installs into the repository hooks dir when the host manages core.hooksPath", (t) => {
  const box = sandbox(t, { managedHooksPath: true });
  const res = runScript(box);
  assert.equal(res.status, 0, `script failed: ${res.stderr}`);
  assert.ok(existsSync(join(box.repo, ".git/hooks/pre-push")), "lefthook's hook must reach the repo hooks dir");

  // The two things the host owns and this script must not touch.
  assert.equal(
    readFileSync(join(box.globalHooks, "pre-push"), "utf8"),
    DISPATCHER,
    "the managed dispatcher must be left exactly as it was (`lefthook install --force` overwrites it)",
  );
  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: box.repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: box.gitconfig },
  });
  assert.equal(configured.stdout.trim(), box.globalHooks, "the managed path must still be in effect afterwards");
});

test("installing twice is idempotent", (t) => {
  const box = sandbox(t, { managedHooksPath: true });
  assert.equal(runScript(box).status, 0);
  const second = runScript(box);
  assert.equal(second.status, 0, `second run failed: ${second.stderr}`);
  assert.ok(existsSync(join(box.repo, ".git/hooks/pre-push")));
});

test("installs normally when no core.hooksPath is configured (CI and a plain clone)", (t) => {
  const box = sandbox(t, { managedHooksPath: false });
  const res = runScript(box);
  assert.equal(res.status, 0, `script failed: ${res.stderr}`);
  assert.ok(existsSync(join(box.repo, ".git/hooks/pre-push")));
});

test("the installed hook actually fires, through the host dispatcher, on a push", (t) => {
  const box = sandbox(t, { managedHooksPath: true });
  assert.equal(runScript(box).status, 0);

  const env = { ...process.env, GIT_CONFIG_GLOBAL: box.gitconfig, PATH: `${join(REPO_ROOT, "node_modules/.bin")}:${process.env.PATH ?? ""}` };
  const git = (args: string[]) => spawnSync("git", args, { cwd: box.repo, encoding: "utf8", env });
  const remote = join(box.dir, "remote.git");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", remote], { env }).status, 0);
  git(["remote", "add", "origin", remote]);
  writeFileSync(join(box.repo, "a.txt"), "hi\n");
  git(["add", "a.txt"]);
  assert.equal(git(["-c", "commit.gpgsign=false", "commit", "-qm", "chore: seed"]).status, 0);

  const push = git(["push", "origin", "HEAD:refs/heads/main"]);
  const output = `${push.stdout}${push.stderr}`;
  assert.equal(push.status, 0, `push failed: ${output}`);
  assert.match(output, /dispatcher ran/, "the host dispatcher still runs first");
  assert.match(output, /lefthook ran/, "and chains into the hook this script installed");
});

test("skips quietly outside a git work tree rather than failing the install", (t) => {
  const box = sandbox(t, { managedHooksPath: true });
  const outside = join(box.dir, "not-a-repo");
  mkdirSync(outside);
  placeScript(outside);
  const res = runScript(box, outside);
  assert.equal(res.status, 0, `script failed: ${res.stderr}`);
  assert.ok(!existsSync(join(outside, ".git")), "nothing is created where there is no checkout");
});

test("fails loudly on a repo-local core.hooksPath instead of skipping the gate", (t) => {
  // A local override is a deliberate choice this script cannot work around
  // (lefthook refuses whatever the key points at). Silently skipping is how the
  // pre-push gate disappears unnoticed, so this must be an error.
  const box = sandbox(t, { managedHooksPath: false });
  spawnSync("git", ["config", "--local", "core.hooksPath", join(box.dir, "elsewhere")], {
    cwd: box.repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: box.gitconfig },
  });
  const res = runScript(box);
  assert.notEqual(res.status, 0, "a local hooks path must not pass silently");
  assert.match(`${res.stdout}${res.stderr}`, /core\.hooksPath/, "the message must name what is in the way");
});

test("finds lefthook in node_modules/.bin when run by hand, not only through pnpm", (t) => {
  // `prepare` is invoked with the package bin directory on PATH; a hand run
  // (which scripts/README.md documents) is not.
  const box = sandbox(t, { managedHooksPath: true });
  const bin = join(box.repo, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  const marker = join(box.dir, "invoked");
  writeFileSync(join(bin, "lefthook"), `#!/bin/bash\necho "$*" > "${marker}"\n`);
  chmodSync(join(bin, "lefthook"), 0o755);

  const res = spawnSync("bash", [join(box.repo, "scripts/install-hooks.sh")], {
    cwd: box.repo,
    encoding: "utf8",
    // Deliberately WITHOUT the repo's node_modules/.bin on PATH.
    env: { ...process.env, GIT_CONFIG_GLOBAL: box.gitconfig, PATH: "/usr/bin:/bin" },
  });
  assert.equal(res.status, 0, `script failed: ${res.stderr}`);
  assert.equal(readFileSync(marker, "utf8").trim(), "install", "the local lefthook is the one that runs");
});

test("lefthook install is what the script actually runs", () => {
  // Guards the assumption the rest of this file rests on: the fix is a wrapper
  // around lefthook, not a reimplementation of it.
  assert.ok(existsSync(LEFTHOOK), "lefthook must be installed for the prepare script to run");
  assert.match(readFileSync(SCRIPT, "utf8"), /lefthook install/);
});
