import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, realpathSync, existsSync, chmodSync } from "node:fs";
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

// The suite itself runs under this repository's own pre-push hook, and git
// exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to the hooks it runs. A
// sandbox that inherits those resolves the CHECKOUT RUNNING THE SUITE instead
// of itself — which is how `git push` came to fail on a green `pnpm test`:
// the local-hooksPath case read the host's config, found none, and saw the
// script succeed where it had to fail. Every spawn below therefore starts from
// a git-free environment and names what it needs.
function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

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

// Every git call here names its repository through GIT_DIR / GIT_WORK_TREE, not
// just `cwd`. Discovery by walking up from a working directory is what lets a
// stray invocation commit into the checkout the suite is running in — a real
// enough hazard that this file makes it structurally impossible rather than
// relying on every call site passing the right `cwd`.
function gitEnv(box: Sandbox, repo = box.repo): NodeJS.ProcessEnv {
  return {
    ...hostEnv(),
    GIT_CONFIG_GLOBAL: box.gitconfig,
    GIT_DIR: join(repo, ".git"),
    GIT_WORK_TREE: repo,
    // `prepare` runs with the package's bin directory on PATH; mirror that
    // rather than depending on a lefthook installed on the host.
    PATH: `${join(REPO_ROOT, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
  };
}

function git(box: Sandbox, args: string[], repo = box.repo) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv(box, repo) });
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

  const box: Sandbox = { dir, repo, globalHooks, gitconfig };
  const run = (...args: string[]): void => {
    const res = git(box, args);
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
  };
  // GIT_DIR is already pointed at <repo>/.git, so `init` creates exactly that.
  run("init", "-q", "-b", "main");
  run("config", "--global", "user.email", "sandbox@example.com");
  run("config", "--global", "user.name", "sandbox");
  if (opts.managedHooksPath) run("config", "--global", "core.hooksPath", globalHooks);

  // The guard the rest of the file rests on: every sandbox really is its own
  // repository, so nothing below can reach the checkout running the suite.
  const toplevel = git(box, ["rev-parse", "--show-toplevel"]).stdout.trim();
  assert.equal(toplevel, realpathSync(repo), "the sandbox must be its own git repository");

  writeFileSync(join(repo, "lefthook.yml"), 'pre-push:\n  commands:\n    hello:\n      run: echo "lefthook ran"\n');
  placeScript(repo);
  return box;
}

// The script under test resolves its own repository, so it gets a plain
// environment — GIT_DIR would defeat the very lookup being exercised.
function runScript(box: Sandbox, root = box.repo) {
  return spawnSync("bash", [join(root, "scripts/install-hooks.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...hostEnv(),
      GIT_CONFIG_GLOBAL: box.gitconfig,
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
  const configured = git(box, ["config", "--get", "core.hooksPath"]);
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

  const remote = join(box.dir, "remote.git");
  // A bare init names its own target, so it is the one call with no work tree.
  assert.equal(
    spawnSync("git", ["init", "-q", "--bare", remote], { env: { ...hostEnv(), GIT_CONFIG_GLOBAL: box.gitconfig } }).status,
    0,
  );
  git(box, ["remote", "add", "origin", remote]);
  writeFileSync(join(box.repo, "seed.txt"), "hi\n");
  git(box, ["add", "seed.txt"]);
  assert.equal(git(box, ["-c", "commit.gpgsign=false", "commit", "-qm", "chore: seed"]).status, 0);

  const push = git(box, ["push", "origin", "HEAD:refs/heads/main"]);
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
  git(box, ["config", "--local", "core.hooksPath", join(box.dir, "elsewhere")]);
  const res = runScript(box);
  assert.notEqual(res.status, 0, "a local hooks path must not pass silently");
  assert.match(`${res.stdout}${res.stderr}`, /core\.hooksPath/, "the message must name what is in the way");
});

test("a sandbox ignores the GIT_* environment git exports to its own hooks", (t) => {
  // The suite runs inside this repository's pre-push hook, where GIT_DIR and
  // GIT_WORK_TREE point at the checkout being pushed. Inheriting them sent the
  // case above at the HOST repository, where there is no local core.hooksPath,
  // so the script exited 0 and the assertion that it must fail silently passed
  // the wrong way round. Poison the environment and pin the isolation.
  const poisoned = { GIT_DIR: join(REPO_ROOT, ".git"), GIT_WORK_TREE: REPO_ROOT, GIT_INDEX_FILE: join(REPO_ROOT, ".git/index") };
  const restore = Object.entries(poisoned).map(([key]) => [key, process.env[key]] as const);
  Object.assign(process.env, poisoned);
  t.after(() => {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const box = sandbox(t, { managedHooksPath: false });
  git(box, ["config", "--local", "core.hooksPath", join(box.dir, "elsewhere")]);
  const res = runScript(box);
  assert.notEqual(res.status, 0, "the sandbox's own local hooks path must still be what the script sees");
  assert.match(`${res.stdout}${res.stderr}`, /core\.hooksPath/);
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
    env: { ...hostEnv(), GIT_CONFIG_GLOBAL: box.gitconfig, PATH: "/usr/bin:/bin" },
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
