import { EntityLink, RankEntityLabel } from "./ExternalLink.tsx";
import { actorDestinations, branchDestinations } from "../entity-links.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import {
  COMMITS_PANES_AUTHOR_LIMIT,
  COMMITS_PANES_KIND_LIMIT,
  COMMITS_PANES_RANK_LIMIT,
  RAIL_RANK_LIMIT,
  RAIL_RANK_LIMIT_ROWS,
  RAIL_ROWS_QUERY,
  type CommitsPanes,
} from "../layout-tier.ts";
import type { ActivityDTO, CommitFileStatsDTO } from "@symphony-board/contract";
import { useMemo, useState, type ReactNode } from "react";
import { RankChart } from "./RankChart.tsx";
import {
  EMPTY_ACTOR_INDEX,
  actorDetails,
  branchDetails,
  commitLanding,
  defaultBranchesFirst,
  hotPaths,
  rankActors,
  rankBranches,
  rankCommitScopes,
  rankCommitTypes,
  rankRepos,
  repoDetails,
  shortPathLabel,
  shortRepoLabel,
  type ActorIndex,
  type HotPath,
} from "../rail-stats.ts";
import { pluralize, relativeTime, type CommitRepoOption, type TimeRange } from "../model.ts";
import { formatAxisValue } from "../rank-scale.ts";
import type { CommitFileStatsState } from "../useCommitFileStats.ts";
import { CommitFileList } from "./CommitFileList.tsx";
import { RankHead, Sparkline, ageLabel, share } from "./RankParts.tsx";
import { ActorAvatar } from "./ActorAvatar.tsx";

// The Commits digest rail: the RANKED facets of the selected range, and a way
// into each of them. The range’s shape over time (per-day strip, hour profile,
// summary tiles) is the overview column beside it — see CommitsOverview.
//
// It exists because the page header routinely reports something like "27 repos
// with commits · 303 branches" over more than a thousand rows, and until now the
// only way to narrow that was two dropdowns. The repo, branch and author lists
// are therefore navigation, not decoration — each row applies the filter it
// describes. The read-only panels are Commit types and, in the pane tiers,
// Commit scopes: they say what KIND of work the range contains and which parts
// of the codebase it named, which no filter expresses. The scopes share their
// pane with Hot files and Hot directories (the producer's file aggregate),
// whose rows do narrow the page — to the commits that touched that path.
//
// Everything here is derived from rows the page already holds, so the rail can
// never disagree with the list beside it.
//
// In the pane tiers (`panes`, from COMMITS_STACK_MIN_WIDTH_PX) each ranking
// stops being a bar and a number, and from the wide-panes tier
// (COMMITS_PANES_MIN_WIDTH_PX) the rail is also a two-up grid. A row has room
// for the facts that make the number mean something -- an author's share, line
// counts, how many repositories and how many of the range's days; a repo's
// people and its last commit. Top repos and Top branches hold up to fifty rows
// and scroll inside their pane instead of stopping at eight; Top authors does
// not scroll, so it stops at ten. The last pane says where the work landed:
// files, directories, or scopes.
//
// The laptop tier (`panes === "stack"`, COMMITS_STACK_MIN_WIDTH_PX) draws the
// same rows and panes in one stack that scrolls as a whole, so every list in
// it stops at a sidebar's eight rows and none scrolls on its own.

// The limit is a tier, not a constant: see layout-tier.ts. A sidebar rail
// lays these charts out as rows, where an extra item costs 26px of height the
// column already has rather than 34px of width it does not.

function commitCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "commit" : "commits"}`;
}

export function CommitsRail({
  avatarOf,
  changedFiles,
  showOnlyChangedFiles = false,
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
  panes = null,
  timezone,
  range,
  fileAggregate = null,
  fileRepoKeys = null,
  selectedPathKey = null,
  onPath,
}: {
  // The contract's per-repository file aggregate (4.9.0), the repositories
  // with rows on screen, and the path the list is narrowed to. `fileAggregate` is
  // null where the aggregate cannot describe the rows on screen — the payload
  // has none, or the rows are a subset the pre-computed counts cannot be
  // re-ranked for (an author or branch filter, a client-side sub-range) — and
  // the pane then shows commit scopes, as it did before.
  fileAggregate?: CommitFileStatsDTO | null;
  fileRepoKeys?: ReadonlySet<string> | null;
  selectedPathKey?: string | null;
  onPath?: (path: HotPath | null) => void;
  // The pane tier, from the laptop tier up: see the note at the top of this
  // file. Null is the plain digest.
  panes?: CommitsPanes | null;
  // For the per-author day series, which buckets in the viewer's zone across
  // the selected range exactly as the overview's per-day chart does.
  timezone: string;
  range: TimeRange;
  avatarOf?: ReadonlyMap<string, string>;
  // Desktop uses the Settings toggle; a phone tap opens this as its second pane.
  changedFiles?: CommitFileStatsState;
  showOnlyChangedFiles?: boolean;
  // The rows currently on screen. The read-only panels here (commit types, and
  // scopes in the pane tiers) describe what is visible rather than what could be
  // selected, so they read these instead of a facet source.
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
  // Both pane tiers draw the same panes; the laptop tier stacks them in one
  // column instead of two. `panes === "wide"` is the two-up tier only.
  const hasPanes = panes !== null;
  // In the wide tier the two lists that scroll inside their pane hold
  // everything worth scrolling to. The panes that do not scroll are bounded,
  // because their rows come out of the height those lists grow in. The laptop
  // tier's column scrolls as a whole, so no list in it scrolls on its own and
  // each stops at a sidebar's row count.
  const rankLimit = panes === "wide" ? COMMITS_PANES_RANK_LIMIT : railRows || panes === "stack" ? RAIL_RANK_LIMIT_ROWS : RAIL_RANK_LIMIT;
  const kindLimit = panes === "wide" ? COMMITS_PANES_KIND_LIMIT : rankLimit;
  const authorLimit = panes === "wide" ? COMMITS_PANES_AUTHOR_LIMIT : rankLimit;

  const repoRanks = useMemo(() => rankRepos(repoSource, rankLimit), [repoSource, rankLimit]);
  const authorRanks = useMemo(() => rankActors(authorSource, authorLimit, actorIndex), [authorSource, authorLimit, actorIndex]);
  const branchRanks = useMemo(() => rankBranches(branchSource, rankLimit), [branchSource, rankLimit]);
  // Commit types describe what is ON SCREEN rather than what could be selected —
  // it drives no filter, so unlike the three ranked facets it reads from the
  // visible rows.
  const typeRanks = useMemo(() => rankCommitTypes(commits, kindLimit), [commits, kindLimit]);
  // Scopes are the pane tiers' second read-only vocabulary, and like the types
  // they describe the rows on screen. Ranked once: the head states how many
  // there are in all, and the pane shows the first of them.
  const allScopes = useMemo(() => (hasPanes ? rankCommitScopes(commits, 0) : []), [hasPanes, commits]);
  const scopeRanks = allScopes.slice(0, kindLimit);
  const scopeTotal = allScopes.length;
  // The facts beside each row. Each is counted over the same facet source as
  // the row it sits in, so a row's count and its facts describe the same
  // commits; none is computed for a layout with nowhere to draw it.
  const authorFacts = useMemo(
    () => (hasPanes ? actorDetails(authorSource, actorIndex, timezone, range.from, range.to) : null),
    [hasPanes, authorSource, actorIndex, timezone, range.from, range.to],
  );
  const repoFacts = useMemo(() => (hasPanes ? repoDetails(repoSource, actorIndex) : null), [hasPanes, repoSource, actorIndex]);
  const branchFacts = useMemo(() => (hasPanes ? branchDetails(branchSource) : null), [hasPanes, branchSource]);
  const repoTotal = useMemo(() => rankRepos(repoSource, 0).length, [repoSource]);
  const authorTotal = useMemo(() => rankActors(authorSource, 0, actorIndex).length, [authorSource, actorIndex]);
  const branchTotal = useMemo(() => rankBranches(branchSource, 0).length, [branchSource]);
  const typeTotal = useMemo(() => rankCommitTypes(commits, 0).length, [commits]);
  const selectedRepoKey = selectedRepo && selectedSource ? `${selectedSource}|${selectedRepo}` : null;
  // Where the range's work landed: the files it changed, the directories, or
  // the scopes its subjects named. One pane, because the three answer the same
  // question from the diff and from the message, and because the column has no
  // height for three.
  const [where, setWhere] = useState<"files" | "dirs" | "scopes">("files");
  const whereShown = fileAggregate ? where : "scopes";
  const hot = useMemo(
    () => (hasPanes && whereShown !== "scopes" ? hotPaths(fileAggregate, fileRepoKeys, whereShown, kindLimit) : null),
    [hasPanes, whereShown, fileAggregate, fileRepoKeys, kindLimit],
  );
  // The share of the range's commits that landed on a default branch, out of
  // the rows that name one (contract 4.8.1). A producer that does not say
  // leaves `known` at zero, and the head falls back to the busiest branch --
  // which is a fact about these rows, where a name like `main` is not evidence.
  const leadBranch = branchRanks[0];
  const landing = useMemo(() => (hasPanes ? commitLanding(branchSource) : null), [hasPanes, branchSource]);
  const branchLead =
    landing && landing.known > 0
      ? `${share(landing.onDefault, landing.known)} on the default branch`
      : leadBranch
        ? `${share(leadBranch.count, branchSource.length)} on ${leadBranch.label}`
        : null;
  // Default branches lead the table of facts (see defaultBranchesFirst).
  const branchRows = useMemo(() => (branchFacts ? defaultBranchesFirst(branchRanks, branchFacts) : branchRanks), [branchRanks, branchFacts]);

  // Every hook is above this line: the phone's Files pane returns early, and a
  // hook below it would run on one render and not the next.
  if (showOnlyChangedFiles) {
    return (
      <aside className="commits-rail" aria-label="Changed files">
        {changedFiles ? <CommitFileList state={changedFiles} /> : null}
      </aside>
    );
  }

  const authorTotalCommits = authorSource.length;
  const authorsBlock = (
    <div className="rail-block pane-span">
      <div className="rail-block-head">
        <span className="rail-block-title">Top authors</span>
        <span className="rail-block-meta">{authorTotal} total</span>
      </div>
      {hasPanes && authorRanks.length > 0 ? (
        // The laptop tier's stylesheet hides the second and third facts
        // (lines, repos) BY POSITION, here and in the row below: reordering
        // either list means changing the nth-child rules in styles.css.
        <RankHead
          cols="rank-cols-authors"
          label="author"
          extras={[{ label: "share" }, { label: "lines" }, { label: "repos" }, { label: "days" }, { label: "per day", start: true }]}
        />
      ) : null}
      <RankChart
        className={`rail-rank-chart${hasPanes ? " rank-cols-authors" : ""}`}
        ariaLabel="Top commit authors in the selected range"
        empty="no authors in range"
        countLabel={commitCountLabel}
        scale={hasPanes ? "max" : "axis"}
        items={authorRanks.map((rank) => {
          const facts = authorFacts?.get(rank.key);
          const dayCount = facts?.perDay.length ?? 0;
          // Same order as the head above; see the note there.
          const extra: ReactNode = facts ? (
            <>
              <span>{share(rank.count, authorTotalCommits)}</span>
              <span className="commit-diffstat">
                {facts.counted > 0 ? (
                  <>
                    <span className="commit-diffstat-add">+{formatAxisValue(facts.additions)}</span>
                    <span className="commit-diffstat-del">-{formatAxisValue(facts.deletions)}</span>
                  </>
                ) : (
                  "—"
                )}
              </span>
              <span>{facts.repos}</span>
              <span>{`${facts.activeDays}/${dayCount}`}</span>
              <Sparkline perDay={facts.perDay} />
            </>
          ) : undefined;
          return {
            key: rank.key,
            label: rank.label,
            count: rank.count,
            selected: rank.label === selectedAuthor,
            extra,
            // Every fact the row can show, so the ones a narrow tier hides
            // are still stated.
            detail: facts
              ? `${share(rank.count, authorTotalCommits)} of the range, ${facts.counted > 0 ? `+${facts.additions.toLocaleString("en-US")} -${facts.deletions.toLocaleString("en-US")} lines, ` : ""}${facts.repos} ${pluralize(facts.repos, "repo")}, active ${facts.activeDays} of ${dayCount} ${pluralize(dayCount, "day")}`
              : undefined,
            // The rail owns the toggle for BOTH lists, matching the repo row
            // below. Leaving it to the route setter would make `onAuthor` a
            // setter that secretly toggles, unlike `onRepo`.
            onSelect: () => onAuthor(rank.label === selectedAuthor ? null : rank.label),
            nameTip: <RankEntityLabel label={rank.label} entities={actorDestinations(authorSource, rank.label, actorIndex)} />,
            footer: (
              <RankEntityLabel className="rank-actor-link" label={rank.label} entities={actorDestinations(authorSource, rank.label, actorIndex)}><span className="activity-rank-actor">
                <ActorAvatar login={rank.label} avatarUrl={avatarOf?.get(rank.label)} titled={false} />
                <span className="activity-rank-actor-name">{rank.label}</span>
              </span></RankEntityLabel>
            ),
          };
        })}
      />
    </div>
  );

  const reposBlock = (
    <div className="rail-block pane-fill">
      <div className="rail-block-head">
        <span className="rail-block-title">Top repos</span>
        <span className="rail-block-meta">{repoTotal} total</span>
      </div>
      {hasPanes && repoRanks.length > 0 ? (
        <RankHead cols="rank-cols-repos" label="repo" extras={[{ label: "authors" }, { label: "last" }]} />
      ) : null}
      <RankChart
        className={`live-rank-chart-repos rail-rank-chart${hasPanes ? " rank-cols-repos pane-scroll" : ""}`}
        ariaLabel="Top repositories by commits in the selected range"
        empty="no repos in range"
        countLabel={commitCountLabel}
        scale={hasPanes ? "max" : "axis"}
        items={repoRanks.map((rank) => {
          // The rank key is `${source_id}|${project_path}`; the source half is
          // what keeps a path mirrored on two providers addressable.
          const sep = rank.key.indexOf("|");
          const sourceId = rank.key.slice(0, sep);
          const projectPath = rank.key.slice(sep + 1);
          const on = rank.key === selectedRepoKey;
          const facts = repoFacts?.get(rank.key);
          return {
            key: rank.key,
            label: rank.label,
            count: rank.count,
            selected: on,
            extra: facts ? (
              <>
                <span>{facts.authors}</span>
                <span>{ageLabel(facts.lastAt)}</span>
              </>
            ) : undefined,
            detail: facts
              ? `${facts.authors} ${pluralize(facts.authors, "author")}, last commit ${relativeTime(facts.lastAt)}`
              : undefined,
            onSelect: () => onRepo(on ? null : { source_id: sourceId, project_path: projectPath, count: rank.count }),
            nameTip: <EntityLink sourceId={sourceId} entity={{ kind: "repo", projectPath: projectPath }}>{rank.label}</EntityLink>,
            footer: (
              <EntityLink className="live-rank-name" sourceId={sourceId} entity={{ kind: "repo", projectPath: projectPath }}>{shortRepoLabel(rank.label)}</EntityLink>
            ),
          };
        })}
      />
    </div>
  );

  const typesBlock = (
    <div className="rail-block">
      <div className="rail-block-head">
        <span className="rail-block-title">Commit types</span>
        <span className="rail-block-meta">{typeTotal} {pluralize(typeTotal, "kind")}</span>
      </div>
      {hasPanes && typeRanks.length > 0 ? <RankHead cols="rank-cols-share" label="type" extras={[{ label: "share" }]} /> : null}
      <RankChart
        className={`live-rank-chart-labels rail-rank-chart${hasPanes ? " rank-cols-share" : ""}`}
        ariaLabel="Conventional-commit types in the selected range"
        empty="no commits in range"
        countLabel={commitCountLabel}
        scale={hasPanes ? "max" : "axis"}
        items={typeRanks.map((rank) => ({
          key: rank.key,
          label: rank.label,
          count: rank.count,
          extra: hasPanes ? <span>{share(rank.count, commits.length)}</span> : undefined,
          detail: hasPanes ? `${share(rank.count, commits.length)} of the range` : undefined,
          footer: (
            <span className="live-rank-name" aria-hidden="true">
              {rank.label}
            </span>
          ),
        }))}
      />
    </div>
  );

  const branchesBlock = (
    <div className="rail-block pane-fill">
      <div className="rail-block-head">
        <span className="rail-block-title">Top branches</span>
        <span className="rail-block-meta">{hasPanes && branchLead ? `${branchLead} · ${branchTotal} total` : `${branchTotal} total`}</span>
      </div>
      {hasPanes && branchRanks.length > 0 ? (
        <RankHead cols="rank-cols-branches" label="branch" extras={[{ label: "repos" }]} />
      ) : null}
      <RankChart
        className={`live-rank-chart-labels rail-rank-chart${hasPanes ? " rank-cols-branches pane-scroll" : ""}`}
        ariaLabel="Branches with the most commits in the selected range"
        empty="no branch refs in range"
        countLabel={commitCountLabel}
        scale={hasPanes ? "max" : "axis"}
        items={branchRows.map((rank) => {
          const facts = branchFacts?.get(rank.key);
          return {
            key: rank.key,
            label: rank.label,
            count: rank.count,
            selected: rank.label === selectedBranch,
            extra: facts ? <span>{facts.repos}</span> : undefined,
            detail: facts
              ? `${facts.isDefault ? "default branch, " : ""}in ${facts.repos} ${pluralize(facts.repos, "repo")}`
              : undefined,
            onSelect: () => onBranch(rank.label === selectedBranch ? null : rank.label),
            nameTip: <RankEntityLabel label={rank.label} entities={branchDestinations(branchSource, rank.label)} />,
            footer: (
              <RankEntityLabel label={rank.label} entities={branchDestinations(branchSource, rank.label)}>
                {/* A bar's footer has room for the last path segment only. A row
                    has room for the name, and `fix/x` and `docs/x` are two
                    different branches. */}
                {hasPanes ? rank.label : shortRepoLabel(rank.label)}
                {facts?.isDefault ? <small className="rank-default-tag">default</small> : null}
              </RankEntityLabel>
            ),
          };
        })}
      />
    </div>
  );

  // Which parts of the codebase the range's work touched.
  //
  // Scopes are read off the same `type(scope):` subject the types come from:
  // what the rows SAY they are about. Files and directories come from the
  // contract's file aggregate: what the rows changed. The scopes are read-only;
  // a file or directory row narrows the list to the commits that touched it,
  // since the aggregate names them.
  const multiRepo = (hot?.repos ?? 0) > 1;
  const filesCols = multiRepo ? "rank-cols-files-multi" : "rank-cols-files";
  const whereTitle = whereShown === "files" ? "Hot files" : whereShown === "dirs" ? "Hot directories" : "Commit scopes";
  const whereMeta =
    whereShown === "scopes" || !hot
      ? `${scopeTotal} ${pluralize(scopeTotal, "scope")}`
      : // Coverage, stated where the ranking is: file data arrives from a bounded
        // pass that catches up over sweeps, so the ranking may describe fewer
        // commits than the range holds.
        `${hot.scanned.toLocaleString("en-US")} of ${hot.commits.toLocaleString("en-US")} scanned`;
  const whereBlock = (
    <div className="rail-block commit-where">
      <div className="rail-block-head">
        <span className="rail-block-title">{whereTitle}</span>
        {fileAggregate ? (
          <span className="pane-seg" role="group" aria-label="Show where the work landed by">
            {(["files", "dirs", "scopes"] as const).map((option) => (
              <button key={option} type="button" className="pane-seg-option" aria-pressed={whereShown === option} onClick={() => setWhere(option)}>
                {option}
              </button>
            ))}
          </span>
        ) : null}
        <span
          className="rail-block-meta"
          title={
            hot
              ? `File data for ${hot.scanned.toLocaleString("en-US")} of ${hot.commits.toLocaleString("en-US")} non-merge commits${hot.truncated > 0 ? `; ${hot.truncated} file ${pluralize(hot.truncated, "list")} capped by the provider` : ""}`
              : undefined
          }
        >
          {whereMeta}
        </span>
      </div>
      {whereShown === "scopes" || !hot ? (
        <>
          {scopeRanks.length > 0 ? <RankHead cols="rank-cols-share" label="scope" extras={[{ label: "share" }]} /> : null}
          <RankChart
            className="live-rank-chart-labels rail-rank-chart rank-cols-share"
            ariaLabel="Conventional-commit scopes in the selected range"
            empty="no scoped commits in range"
            countLabel={commitCountLabel}
            scale="max"
            items={scopeRanks.map((rank) => ({
              key: rank.key,
              label: rank.label,
              count: rank.count,
              extra: <span>{share(rank.count, commits.length)}</span>,
              detail: `${share(rank.count, commits.length)} of the range`,
              footer: (
                <span className="live-rank-name" aria-hidden="true">
                  {rank.label}
                </span>
              ),
            }))}
          />
        </>
      ) : (
        <>
          {hot.rows.length > 0 ? (
            <RankHead
              cols={filesCols}
              label={whereShown === "files" ? "file" : "directory"}
              extras={multiRepo ? [{ label: "lines" }] : [{ label: "lines" }, { label: "authors" }]}
            />
          ) : null}
          <RankChart
            className={`live-rank-chart-labels rail-rank-chart ${filesCols}`}
            ariaLabel={whereShown === "files" ? "Files changed by the most commits in the selected range" : "Directories changed by the most commits in the selected range"}
            // Two different empties: the pass has not reached these commits
            // yet, or it has and they changed nothing it can list.
            empty={hot.scanned === 0 ? "file data is still being collected for this range" : "no changed files in range"}
            countLabel={commitCountLabel}
            scale="max"
            items={hot.rows.map((row) => {
              const on = row.key === selectedPathKey;
              // The repository is part of the name only when more than one is
              // on screen: `src/app.ts` is a different file in each.
              const label = multiRepo ? `${row.path} · ${row.projectPath}` : row.path;
              return {
                key: row.key,
                label,
                count: row.commits,
                selected: on,
                extra: (
                  <>
                    <span className="commit-diffstat">
                      <span className="commit-diffstat-add">+{formatAxisValue(row.additions)}</span>
                      <span className="commit-diffstat-del">-{formatAxisValue(row.deletions)}</span>
                    </span>
                    {multiRepo ? null : <span>{row.authors}</span>}
                  </>
                ),
                detail: `${row.additions.toLocaleString("en-US")} added, ${row.deletions.toLocaleString("en-US")} removed, ${row.authors} ${pluralize(row.authors, "author")}`,
                onSelect: onPath ? () => onPath(on ? null : row) : undefined,
                nameTip: <EntityLink sourceId={row.sourceId} entity={{ kind: "commit", projectPath: row.projectPath, sha: row.shas[0] }}>{row.path} · {row.projectPath}</EntityLink>,
                footer: (
                  <span className="live-rank-name">
                    {/* The path first: when the line runs out it is the
                        repository that is cut, and the file is still named. */}
                    <EntityLink sourceId={row.sourceId} entity={{ kind: "commit", projectPath: row.projectPath, sha: row.shas[0] }}>{shortPathLabel(row.path)}</EntityLink>
                    {multiRepo ? <span className="rank-path-repo"> · <EntityLink sourceId={row.sourceId} entity={{ kind: "repo", projectPath: row.projectPath }}>{shortRepoLabel(row.projectPath)}</EntityLink></span> : null}
                  </span>
                ),
              };
            })}
          />
        </>
      )}
    </div>
  );

  return (
    <aside
      className={`commits-rail${hasPanes ? " pane-scroll" : ""}`}
      data-panes={panes ?? undefined}
      aria-label="Commit range digest"
    >
      {changedFiles ? <CommitFileList state={changedFiles} /> : null}

      {/* Authors lead: "who has been working" is the question this page is
          opened with, and the repo/branch answers are also reachable from the
          toolbar above, while this list is the only ranking of people. */}
      {authorsBlock}
      {reposBlock}
      {hasPanes ? (
        // In the two-up grid the pairs read across: the two lists that filter
        // (and scroll) share a row, then the two read-only vocabularies. The
        // laptop tier's stack reads them in the same order.
        <>
          {branchesBlock}
          {typesBlock}
          {whereBlock}
        </>
      ) : (
        // One stack. Branches last: the longest list, the least often the
        // question, and the one the toolbar's own select already answers.
        <>
          {typesBlock}
          {branchesBlock}
        </>
      )}
    </aside>
  );
}
