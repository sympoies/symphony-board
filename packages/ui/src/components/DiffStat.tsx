import type { CommitStats } from "../model.ts";

// A commit's line counts, as `+N -M`.
//
// Renders NOTHING when the counts are absent, which is the whole reason this is
// a component rather than two spans at each call site. Absent means the
// producer could not read them, or the commit is a merge — whose counts are
// measured against the first parent and would double-count the merged branch
// (see docs/CONTRACT.md). A commit that genuinely changed nothing is `+0 -0`,
// so substituting zeros for "unknown" would state something false.
export function DiffStat({ stats }: { stats: CommitStats | null }) {
  if (!stats) return null;
  const added = stats.additions.toLocaleString("en-US");
  const removed = stats.deletions.toLocaleString("en-US");
  return (
    <span className="commit-diffstat" title={`${added} added, ${removed} removed`}>
      <span className="commit-diffstat-add">+{added}</span>
      <span className="commit-diffstat-del">-{removed}</span>
    </span>
  );
}
