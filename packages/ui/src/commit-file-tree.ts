// The directory tree `git-scope commit` prints under its changed-file list,
// rebuilt from the paths the /api/commit-files response already carries:
//
//   .
//   ├── docs
//   │   └── devlog
//   │       └── 2026-09.md
//   └── src
//       └── server
//           └── commit-files.ts
//
//   4 directories, 2 files
//
// It answers a different question from the flat list beside it: the list says
// WHAT changed and by how much, the tree says WHERE the change landed — one
// subsystem, or six. A flat list of twelve paths that share a prefix hides that;
// the tree makes it the shape of the block.
//
// Pure and string-only so it can be unit-tested without a DOM, and so the
// component stays a renderer.

export interface CommitFileTree {
  // Rendered lines, root (".") first. Empty when there are no paths.
  lines: string[];
  // Directory count INCLUDING the root, matching `tree`'s own summary line
  // (which `git-scope` reproduces).
  directories: number;
  files: number;
}

interface TreeNode {
  // Child directories and files, keyed by segment name.
  children: Map<string, TreeNode>;
  isFile: boolean;
}

function emptyNode(): TreeNode {
  return { children: new Map(), isFile: false };
}

// Plain lexicographic order over the segment, the way `tree` sorts: no
// directories-first grouping, and uppercase sorts before lowercase, so
// `README.md` precedes `bin/` exactly as the CLI prints it.
function sortedEntries(node: TreeNode): Array<[string, TreeNode]> {
  return [...node.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function walk(node: TreeNode, prefix: string, out: string[], counts: { directories: number; files: number }): void {
  const entries = sortedEntries(node);
  entries.forEach(([name, child], index) => {
    const last = index === entries.length - 1;
    out.push(`${prefix}${last ? "└── " : "├── "}${name}`);
    if (child.isFile && child.children.size === 0) {
      counts.files++;
      return;
    }
    counts.directories++;
    walk(child, `${prefix}${last ? "    " : "│   "}`, out, counts);
  });
}

export function buildCommitFileTree(paths: readonly string[]): CommitFileTree {
  const root = emptyNode();
  let any = false;
  for (const raw of paths) {
    // Provider paths are repository-relative and forward-slashed; guard the
    // shapes anyway ("./x", "a//b", a trailing slash) so one odd row cannot
    // produce a phantom level.
    const segments = String(raw ?? "")
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0 && segment !== ".");
    if (segments.length === 0) continue;
    any = true;
    let node = root;
    segments.forEach((segment, index) => {
      let child = node.children.get(segment);
      if (!child) {
        child = emptyNode();
        node.children.set(segment, child);
      }
      if (index === segments.length - 1) child.isFile = true;
      node = child;
    });
  }
  if (!any) return { lines: [], directories: 0, files: 0 };

  const lines = ["."];
  // The root counts as a directory, which is what makes the CLI's summary read
  // "8 directories" for seven named ones.
  const counts = { directories: 1, files: 0 };
  walk(root, "", lines, counts);
  return { lines, directories: counts.directories, files: counts.files };
}

export function commitFileTreeSummary(tree: CommitFileTree): string {
  const directories = `${tree.directories} ${tree.directories === 1 ? "directory" : "directories"}`;
  const files = `${tree.files} ${tree.files === 1 ? "file" : "files"}`;
  return `${directories}, ${files}`;
}
