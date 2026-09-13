import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, type CSSProperties } from "react";
import { RankChart } from "./RankChart.tsx";
import { countsByDay, rankActors, rankBranches, rankCommitTypes, rankRepos, shortRepoLabel } from "../rail-stats.ts";
import { niceAxisMax, rankBarHeight } from "../rank-scale.ts";
import type { CommitRepoOption, TimeRange } from "../model.ts";

// The Commits digest rail: what the selected range contains, and a way into it.
//
// It exists because the page header routinely reports something like "27 repos
// with commits · 303 branches" over more than a thousand rows, and until now the
// only way to narrow that was two dropdowns. The repo, branch and author lists
// are therefore navigation, not decoration — each row applies the filter it
// describes. Commit types is the one read-only panel: it says what KIND of work
// the range contains, which no filter expresses.
//
// Everything here is derived from rows the page already holds, so the rail can
// never disagree with the list beside it.

const RAIL_RANK_LIMIT = 6;

function commitCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "commit" : "commits"}`;
}

// Chronological per-day bars. Deliberately NOT a RankChart: those sort by size,
// and the whole point of this strip is the shape of the range in order, gaps
// included.
function DayBars({ commits, timezone, range }: { commits: ActivityDTO[]; timezone: string; range: TimeRange }) {
  const days = useMemo(
    () => countsByDay(commits, timezone, range.from, range.to),
    [commits, timezone, range.from, range.to],
  );
  if (days.length === 0) return null;
  const max = Math.max(1, ...days.map((d) => d.count));
  const axisMax = niceAxisMax(max);
  const total = days.reduce((sum, d) => sum + d.count, 0);
  return (
    <div className="rail-block">
      <div className="rail-block-head">
        <span className="rail-block-title">Commits per day</span>
        <span className="rail-block-meta">{commitCountLabel(total)}</span>
      </div>
      <div className="rail-daybars" role="img" aria-label={`Commits per day, ${range.from} to ${range.to}: ${commitCountLabel(total)}`}>
        {days.map((day) => (
          <span
            key={day.date}
            className="rail-daybar"
            style={{ "--rank-h": rankBarHeight(day.count, axisMax) } as CSSProperties}
            data-empty={day.count === 0 ? "true" : undefined}
          >
            <span className="rail-daybar-tip">{`${day.date} · ${commitCountLabel(day.count)}`}</span>
            <span className="rail-daybar-fill" />
          </span>
        ))}
      </div>
    </div>
  );
}

export function CommitsRail({
  commits,
  repoSource,
  branchSource,
  authorSource,
  timezone,
  range,
  selectedRepo,
  selectedSource,
  selectedAuthor,
  selectedBranch,
  onRepo,
  onAuthor,
  onBranch,
}: {
  // The rows currently on screen — what the per-day strip describes.
  commits: ActivityDTO[];
  // Facet sources: each ranked list is counted with every filter applied EXCEPT
  // its own, so the list you are standing in still offers somewhere else to go.
  repoSource: ActivityDTO[];
  authorSource: ActivityDTO[];
  branchSource: ActivityDTO[];
  timezone: string;
  range: TimeRange;
  selectedRepo: string | null;
  selectedSource: string | null;
  selectedAuthor: string | null;
  selectedBranch: string | null;
  onRepo: (repo: CommitRepoOption | null) => void;
  onAuthor: (author: string | null) => void;
  onBranch: (branch: string | null) => void;
}) {
  const repoRanks = useMemo(() => rankRepos(repoSource, RAIL_RANK_LIMIT), [repoSource]);
  const authorRanks = useMemo(() => rankActors(authorSource, RAIL_RANK_LIMIT), [authorSource]);
  const branchRanks = useMemo(() => rankBranches(branchSource, RAIL_RANK_LIMIT), [branchSource]);
  // Commit types describe what is ON SCREEN rather than what could be selected —
  // it drives no filter, so unlike the three ranked facets it reads from the
  // visible rows.
  const typeRanks = useMemo(() => rankCommitTypes(commits, RAIL_RANK_LIMIT), [commits]);
  const repoTotal = useMemo(() => rankRepos(repoSource, 0).length, [repoSource]);
  const authorTotal = useMemo(() => rankActors(authorSource, 0).length, [authorSource]);
  const branchTotal = useMemo(() => rankBranches(branchSource, 0).length, [branchSource]);
  const typeTotal = useMemo(() => rankCommitTypes(commits, 0).length, [commits]);
  const selectedRepoKey = selectedRepo && selectedSource ? `${selectedSource}|${selectedRepo}` : null;

  return (
    <aside className="commits-rail" aria-label="Commit range digest">
      <DayBars commits={commits} timezone={timezone} range={range} />

      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">Top repos</span>
          <span className="rail-block-meta">{repoTotal} total</span>
        </div>
        <RankChart
          className="live-rank-chart-repos rail-rank-chart"
          ariaLabel="Top repositories by commits in the selected range"
          empty="no repos in range"
          countLabel={commitCountLabel}
          items={repoRanks.map((rank) => {
            // The rank key is `${source_id}|${project_path}`; the source half is
            // what keeps a path mirrored on two providers addressable.
            const sep = rank.key.indexOf("|");
            const sourceId = rank.key.slice(0, sep);
            const projectPath = rank.key.slice(sep + 1);
            const on = rank.key === selectedRepoKey;
            return {
              key: rank.key,
              label: rank.label,
              count: rank.count,
              selected: on,
              onSelect: () => onRepo(on ? null : { source_id: sourceId, project_path: projectPath, count: rank.count }),
              footer: (
                <span className="live-rank-name" aria-hidden="true">
                  {shortRepoLabel(rank.label)}
                </span>
              ),
            };
          })}
        />
      </div>

      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">Top branches</span>
          <span className="rail-block-meta">{branchTotal} total</span>
        </div>
        <RankChart
          className="rail-rank-chart"
          ariaLabel="Branches with the most commits in the selected range"
          empty="no branch refs in range"
          countLabel={commitCountLabel}
          items={branchRanks.map((rank) => ({
            key: rank.key,
            label: rank.label,
            count: rank.count,
            selected: rank.label === selectedBranch,
            onSelect: () => onBranch(rank.label === selectedBranch ? null : rank.label),
            footer: (
              <span className="live-rank-name" aria-hidden="true">
                {shortRepoLabel(rank.label)}
              </span>
            ),
          }))}
        />
      </div>

      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">Commit types</span>
          <span className="rail-block-meta">{typeTotal} kinds</span>
        </div>
        <RankChart
          className="rail-rank-chart"
          ariaLabel="Conventional-commit types in the selected range"
          empty="no commits in range"
          countLabel={commitCountLabel}
          items={typeRanks.map((rank) => ({
            key: rank.key,
            label: rank.label,
            count: rank.count,
            footer: (
              <span className="live-rank-name" aria-hidden="true">
                {rank.label}
              </span>
            ),
          }))}
        />
      </div>

      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">Top authors</span>
          <span className="rail-block-meta">{authorTotal} total</span>
        </div>
        <RankChart
          className="rail-rank-chart"
          ariaLabel="Top commit authors in the selected range"
          empty="no authors in range"
          countLabel={commitCountLabel}
          items={authorRanks.map((rank) => ({
            key: rank.key,
            label: rank.label,
            count: rank.count,
            selected: rank.label === selectedAuthor,
            // The rail owns the toggle for BOTH lists, matching the repo row
            // above. Leaving it to the route setter would make `onAuthor` a
            // setter that secretly toggles, unlike `onRepo`.
            onSelect: () => onAuthor(rank.label === selectedAuthor ? null : rank.label),
            footer: (
              <span className="live-rank-name" aria-hidden="true">
                {rank.label}
              </span>
            ),
          }))}
        />
      </div>
    </aside>
  );
}
