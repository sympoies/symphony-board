import { useMediaQuery } from "../useMediaQuery.ts";
import { RAIL_RANK_LIMIT, RAIL_RANK_LIMIT_ROWS, RAIL_ROWS_QUERY } from "../layout-tier.ts";
import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo } from "react";
import { RankChart } from "./RankChart.tsx";
import { EMPTY_ACTOR_INDEX, rankActors, rankBranches, rankCommitTypes, rankRepos, shortRepoLabel, type ActorIndex } from "../rail-stats.ts";
import type { CommitRepoOption } from "../model.ts";

// The Commits digest rail: the RANKED facets of the selected range, and a way
// into each of them. The range’s shape over time (per-day strip, hour profile,
// summary tiles) is the overview column beside it — see CommitsOverview.
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

// The limit is a tier, not a constant: see layout-tier.ts. A sidebar rail
// lays these charts out as rows, where an extra item costs 26px of height the
// column already has rather than 34px of width it does not.

function commitCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "commit" : "commits"}`;
}

export function CommitsRail({
  commits,
  repoSource,
  branchSource,
  authorSource,
  actorIndex = EMPTY_ACTOR_INDEX,
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
  // Contract actor directory as lookups: merges a person's facets into one row
  // and drops CI accounts, matching repo_metrics.top_actors. See rail-stats.
  actorIndex?: ActorIndex;
  selectedRepo: string | null;
  selectedSource: string | null;
  selectedAuthor: string | null;
  selectedBranch: string | null;
  onRepo: (repo: CommitRepoOption | null) => void;
  onAuthor: (author: string | null) => void;
  onBranch: (branch: string | null) => void;
}) {
  // Rows are cheap in a sidebar and expensive across a narrow column, so the
  // count follows the layout rather than being fixed. useMediaQuery re-renders
  // on the breakpoint, so resizing onto a second monitor re-evaluates it.
  const railRows = useMediaQuery(RAIL_ROWS_QUERY);
  const rankLimit = railRows ? RAIL_RANK_LIMIT_ROWS : RAIL_RANK_LIMIT;

  const repoRanks = useMemo(() => rankRepos(repoSource, rankLimit), [repoSource, rankLimit]);
  const authorRanks = useMemo(() => rankActors(authorSource, rankLimit, actorIndex), [authorSource, rankLimit, actorIndex]);
  const branchRanks = useMemo(() => rankBranches(branchSource, rankLimit), [branchSource, rankLimit]);
  // Commit types describe what is ON SCREEN rather than what could be selected —
  // it drives no filter, so unlike the three ranked facets it reads from the
  // visible rows.
  const typeRanks = useMemo(() => rankCommitTypes(commits, rankLimit), [commits, rankLimit]);
  const repoTotal = useMemo(() => rankRepos(repoSource, 0).length, [repoSource]);
  const authorTotal = useMemo(() => rankActors(authorSource, 0, actorIndex).length, [authorSource, actorIndex]);
  const branchTotal = useMemo(() => rankBranches(branchSource, 0).length, [branchSource]);
  const typeTotal = useMemo(() => rankCommitTypes(commits, 0).length, [commits]);
  const selectedRepoKey = selectedRepo && selectedSource ? `${selectedSource}|${selectedRepo}` : null;

  return (
    <aside className="commits-rail" aria-label="Commit range digest">
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
