import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommitFileTree, commitFileTreeSummary } from "../src/commit-file-tree.ts";

// The tree the changed-files block prints under its flat list. It is rebuilt
// from paths alone, so these cases pin the rendering rules (`git-scope commit`'s
// own, which are `tree`'s) rather than any provider behavior.

test("the tree reproduces the git-scope layout, connectors and summary", () => {
  const tree = buildCommitFileTree([
    "docs/devlog/2026-09.md",
    "modules/agent-console/host/README.md",
    "modules/agent-console/host/bin/agent_console_hermes.py",
    "modules/agent-console/scripts/test-agent-console-hermes.py",
  ]);
  assert.deepEqual(tree.lines, [
    ".",
    "├── docs",
    "│   └── devlog",
    "│       └── 2026-09.md",
    "└── modules",
    "    └── agent-console",
    "        ├── host",
    "        │   ├── README.md",
    "        │   └── bin",
    "        │       └── agent_console_hermes.py",
    "        └── scripts",
    "            └── test-agent-console-hermes.py",
  ]);
  // The root counts, which is what makes seven named directories read as eight.
  assert.equal(tree.directories, 8);
  assert.equal(tree.files, 4);
  assert.equal(commitFileTreeSummary(tree), "8 directories, 4 files");
});

test("ordering is plain lexicographic, so a file can precede a directory", () => {
  // `tree` does not group directories first: README.md sorts before bin/
  // because "R" < "b" in ASCII. Grouping them would silently diverge from the
  // output this block is copying.
  const tree = buildCommitFileTree(["host/README.md", "host/bin/run.sh"]);
  assert.deepEqual(tree.lines, [".", "└── host", "    ├── README.md", "    └── bin", "        └── run.sh"]);
});

test("a root-level file needs no directory level", () => {
  const tree = buildCommitFileTree(["README.md", "LICENSE"]);
  assert.deepEqual(tree.lines, [".", "├── LICENSE", "└── README.md"]);
  assert.equal(commitFileTreeSummary(tree), "1 directory, 2 files");
});

test("odd path shapes cannot produce a phantom level", () => {
  const tree = buildCommitFileTree(["./src/app.ts", "src//lib/util.ts", "", "   "]);
  assert.deepEqual(tree.lines, [".", "└── src", "    ├── app.ts", "    └── lib", "        └── util.ts"]);
  assert.equal(tree.files, 2);
});

test("no paths renders nothing rather than a bare root", () => {
  const tree = buildCommitFileTree([]);
  assert.deepEqual(tree, { lines: [], directories: 0, files: 0 });
});

test("a directory that is also a file path keeps both without losing the file count", () => {
  // Defensive: a provider that reports `a/b` and `a/b/c` in one commit (a path
  // that became a directory) must not silently drop a row.
  const tree = buildCommitFileTree(["a/b", "a/b/c"]);
  assert.deepEqual(tree.lines, [".", "└── a", "    └── b", "        └── c"]);
  assert.equal(tree.files, 1);
  assert.equal(tree.directories, 3);
});
