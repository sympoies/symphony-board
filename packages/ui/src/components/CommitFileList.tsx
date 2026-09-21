import type { CommitFileStats, CommitFileStatus } from "../contract.ts";
import type { CommitFileStatsState } from "./CommitDetail.tsx";

// The opened commit's changed files, laid out like `git-scope commit`: one row
// per file as `[M] path   +40 −0`, then the commit total under them. The status
// letter carries the change kind that a bare path cannot (a deleted file whose
// counts are all deletions still reads differently from a rewrite), and the
// counts are right-aligned so the column scans as a column.
//
// Every non-ready state renders a line rather than nothing: the viewer turned
// this on deliberately, so "why is there no list" has to be answerable in place
// — a server that cannot reach the provider, or does not serve the route at
// all, says so here.
export function CommitFileList({ state }: { state: CommitFileStatsState }) {
  if (state.kind === "idle") return null;
  return (
    <section className="commit-files" aria-label="Changed files">
      <div className="commit-files-head">Changed files</div>
      {state.kind === "loading" ? <p className="commit-files-note muted">Loading changed files…</p> : null}
      {state.kind === "error" ? <p className="commit-files-note muted">No file breakdown: {state.message}</p> : null}
      {state.kind === "ready" ? <CommitFileRows stats={state.stats} /> : null}
    </section>
  );
}

const STATUS_LETTER: Record<CommitFileStatus, string> = {
  added: "A",
  modified: "M",
  removed: "D",
  renamed: "R",
};

function CommitFileRows({ stats }: { stats: CommitFileStats }) {
  if (stats.files.length === 0) {
    return <p className="commit-files-note muted">The provider reported no changed files for this commit.</p>;
  }
  return (
    <>
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
        <span className="commit-files-total-label">
          {stats.truncated ? `Total (first ${stats.files.length} files)` : `Total · ${stats.files.length} ${stats.files.length === 1 ? "file" : "files"}`}
        </span>
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
