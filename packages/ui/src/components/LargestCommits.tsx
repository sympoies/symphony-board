import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, type CSSProperties } from "react";
import { activityKey, commitMessage, relativeTime } from "../model.ts";
import { COMMITS_PANES_RANK_LIMIT } from "../layout-tier.ts";
import { largestCommits, shortRepoLabel } from "../rail-stats.ts";

// The commits that changed the most lines in the range, and a way into each.
//
// This is the pane that takes the overview column's spare height, on purpose:
// it is a list, so more room is more rows rather than a bigger drawing of the
// same numbers. It is also the one question the log beside it cannot answer by
// scrolling -- the log is in time order, and "which commits were the big ones"
// is not a time question.
//
// A row pins that commit in the detail pane, the same as clicking it in the
// log. Commits without line counts are not ranked as zero; they are absent.

export function LargestCommits({
  commits,
  selectedKey,
  onSelect,
}: {
  commits: ActivityDTO[];
  selectedKey: string | null;
  onSelect: (commit: ActivityDTO) => void;
}) {
  // Sorted once per row set. The slice is what renders; the full length is the
  // "of N" in the head, which is how many commits carried counts at all.
  const ranked = useMemo(() => largestCommits(commits, 0), [commits]);
  const top = ranked.slice(0, COMMITS_PANES_RANK_LIMIT);
  const scale = top[0]?.lines ?? 0;

  return (
    <div className="rail-block pane-span pane-fill largest-commits">
      <div className="rail-block-head">
        <span className="rail-block-title">Largest commits</span>
        <span className="rail-block-meta">
          {ranked.length > 0
            ? `by lines changed · top ${top.length.toLocaleString("en-US")} of ${ranked.length.toLocaleString("en-US")}`
            : "by lines changed"}
        </span>
      </div>
      {top.length === 0 ? (
        <div className="pane-empty">no line counts in range</div>
      ) : (
        <ol className="pane-rows pane-scroll" aria-label="Largest commits by lines changed">
          {top.map((sized, index) => {
            const key = activityKey(sized.commit);
            const actor = sized.commit.actor ? `@${sized.commit.actor}` : "unknown author";
            return (
              <li key={key}>
                <button
                  type="button"
                  className="pane-row pane-row-commit"
                  aria-pressed={key === selectedKey}
                  onClick={() => onSelect(sized.commit)}
                >
                  <span className="pane-row-rank" aria-hidden="true">{index + 1}</span>
                  <span className="pane-row-main">
                    <b>{commitMessage(sized.commit)}</b>
                    <small>
                      {sized.commit.project_path ? `${shortRepoLabel(sized.commit.project_path)} · ` : ""}
                      {actor} · {relativeTime(sized.commit.occurred_at)}
                    </small>
                  </span>
                  <span className="pane-row-bar" aria-hidden="true">
                    <i className="pane-row-bar-add" style={{ "--pane-w": scale > 0 ? `${(sized.additions / scale) * 100}%` : "0%" } as CSSProperties} />
                    <i className="pane-row-bar-del" style={{ "--pane-w": scale > 0 ? `${(sized.deletions / scale) * 100}%` : "0%" } as CSSProperties} />
                  </span>
                  <span className="commit-diffstat">
                    <span className="commit-diffstat-add">+{sized.additions.toLocaleString("en-US")}</span>
                    <span className="commit-diffstat-del">-{sized.deletions.toLocaleString("en-US")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
