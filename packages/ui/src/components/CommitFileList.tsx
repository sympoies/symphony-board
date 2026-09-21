import type { CommitFileStats, CommitFileStatus } from "../contract.ts";
import type { CommitFileStatsState } from "../useCommitFileStats.ts";
import { buildCommitFileTree, commitFileTreeSummary } from "../commit-file-tree.ts";

// The selected commit's changed files, laid out like `git-scope commit`: the
// directory tree first, then one row per file as `[M] path   +40 −0`, then the
// commit total. The status letter carries the change kind that a bare path
// cannot (a deleted file whose counts are all deletions still reads differently
// from a rewrite), and the counts are right-aligned so the column scans as a
// column.
//
// It renders as a `rail-block` at the HEAD of the digest rail rather than inside
// the detail pane. A long commit message and a long file list stacked in one
// column pushed the files off the bottom of the screen exactly when they were
// worth reading; the rail is the column that already holds per-selection
// detail, and the files displace ranked facets that describe the whole range.
//
// Every non-ready state still renders a line rather than nothing: a server that
// cannot reach the provider, or does not serve the route at all, says so here.
export function CommitFileList({ state }: { state: CommitFileStatsState }) {
  if (state.kind === "idle") return null;
  return (
    <div className="rail-block commit-files">
      <div className="rail-block-head">
        <span className="rail-block-title">Changed files</span>
        {state.kind === "ready" ? <span className="rail-block-meta">{fileCountLabel(state.stats)}</span> : null}
      </div>
      {state.kind === "loading" ? <p className="commit-files-note muted">Loading changed files…</p> : null}
      {state.kind === "error" ? <p className="commit-files-note muted">No file breakdown: {state.message}</p> : null}
      {state.kind === "ready" ? <CommitFileRows stats={state.stats} /> : null}
    </div>
  );
}

const STATUS_LETTER: Record<CommitFileStatus, string> = {
  added: "A",
  modified: "M",
  removed: "D",
  renamed: "R",
};

function fileCountLabel(stats: CommitFileStats): string {
  const count = `${stats.files.length} ${stats.files.length === 1 ? "file" : "files"}`;
  return stats.truncated ? `first ${count}` : count;
}

// What the total actually covers, which only differs once the list is capped:
// GitHub still reports the whole commit, GitLab only the files listed here.
// Claiming "first N files" over a whole-commit number would be a wrong label,
// not a vague one.
function totalLabel(stats: CommitFileStats): string {
  if (!stats.truncated) return "Total";
  return stats.total_scope === "commit" ? "Total · whole commit" : "Total · listed files";
}

function CommitFileRows({ stats }: { stats: CommitFileStats }) {
  if (stats.files.length === 0) {
    return <p className="commit-files-note muted">The provider reported no changed files for this commit.</p>;
  }
  const tree = buildCommitFileTree(stats.files.map((file) => file.path));
  return (
    <>
      {/* The tree leads: it answers WHERE the commit landed — one subsystem or
          six — which the flat list below cannot show once its paths share a
          prefix. The list then answers what changed and by how much. */}
      {tree.lines.length > 0 ? (
        <div className="commit-files-tree">
          <pre className="commit-files-tree-body">{tree.lines.join("\n")}</pre>
          <div className="commit-files-tree-summary muted">{commitFileTreeSummary(tree)}</div>
        </div>
      ) : null}
      <ul className="commit-files-list">
        {stats.files.map((file) => (
          <li key={`${file.status}:${file.path}`} className="commit-files-row">
            <span className={`commit-files-status commit-files-status-${file.status}`} title={file.status}>
              {STATUS_LETTER[file.status]}
            </span>
            {/* Long paths matter at their END (the file name), so the middle of
                the row is what gives way — the list stays one line per file. */}
            <span className="commit-files-path" title={file.path}>
              {file.path}
            </span>
            <span className="commit-files-counts">
              <span className="commit-diffstat-add">+{file.additions.toLocaleString("en-US")}</span>
              <span className="commit-diffstat-del">−{file.deletions.toLocaleString("en-US")}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="commit-files-total">
        <span className="commit-files-total-label">{totalLabel(stats)}</span>
        <span className="commit-files-counts">
          <span className="commit-diffstat-add">+{stats.total.additions.toLocaleString("en-US")}</span>
          <span className="commit-diffstat-del">−{stats.total.deletions.toLocaleString("en-US")}</span>
        </span>
      </div>
      {stats.truncated ? (
        <p className="commit-files-note muted">The provider capped this list; open the commit to see every file.</p>
      ) : null}
    </>
  );
}
