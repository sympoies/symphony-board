import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo } from "react";
import { RankChart } from "./RankChart.tsx";
import { ActorAvatar } from "./ActorAvatar.tsx";
import { RankHead, Sparkline, share } from "./RankParts.tsx";
import {
  EMPTY_ACTOR_INDEX,
  actorDetails,
  branchDetails,
  rankActions,
  rankActors,
  rankBranches,
  rankKinds,
  rankRepos,
  repoActivityDetails,
  shortRepoLabel,
  type ActorIndex,
} from "../rail-stats.ts";
import { displayKind, pluralize, relativeTime, type TimeRange } from "../model.ts";
import { COMMITS_PANES_AUTHOR_LIMIT, COMMITS_PANES_KIND_LIMIT, COMMITS_PANES_RANK_LIMIT, RAIL_RANK_LIMIT_ROWS, type CommitsPanes } from "../layout-tier.ts";
import type { ActivityFacets } from "../nav.ts";

// The Activity rail in the pane tiers: who, where, and what the range was.
//
// Each ranking becomes a table, the way the Commits rail's do: a person's
// share of the range, how many repositories and how many of its days, and a
// per-day sparkline; a repository's share, active days and sparkline (its
// people and last event are in the row's accessible name). Where, What and How rows toggle the facets the page's chips
// already carry, so a row is a way into the feed, not only a number.
//
// It takes the Commits rail's five slots so the two pages share one layout:
// Who across the top, Where and Branches as the two lists that take the spare
// height (and scroll inside their pane), What and How under them.

function eventCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "event" : "events"}`;
}

export function ActivityPanesRail({
  activities,
  timezone,
  range,
  panes,
  actorIndex = EMPTY_ACTOR_INDEX,
  avatarOf,
  facets,
  onFacet,
}: {
  activities: ActivityDTO[];
  timezone: string;
  range: TimeRange;
  panes: CommitsPanes;
  actorIndex?: ActorIndex;
  avatarOf?: ReadonlyMap<string, string>;
  // The page's route-backed facets, so a row shows whether it is applied.
  facets: ActivityFacets;
  onFacet?: (dim: "repos" | "kinds" | "actions", value: string) => void;
}) {
  // The wide tier's lists scroll inside their pane, so they hold everything
  // worth scrolling to; the laptop tier's column scrolls as a whole, so each
  // list stops at a sidebar's row count.
  const wide = panes === "wide";
  const listLimit = wide ? COMMITS_PANES_RANK_LIMIT : RAIL_RANK_LIMIT_ROWS;
  const whoLimit = wide ? COMMITS_PANES_AUTHOR_LIMIT : RAIL_RANK_LIMIT_ROWS;
  const kindLimit = wide ? COMMITS_PANES_KIND_LIMIT : RAIL_RANK_LIMIT_ROWS;
  const total = activities.length;

  const people = useMemo(() => rankActors(activities, 0, actorIndex), [activities, actorIndex]);
  const peopleFacts = useMemo(() => actorDetails(activities, actorIndex, timezone, range.from, range.to), [activities, actorIndex, timezone, range.from, range.to]);
  const repos = useMemo(() => rankRepos(activities, 0), [activities]);
  const repoFacts = useMemo(() => repoActivityDetails(activities, actorIndex, timezone, range.from, range.to), [activities, actorIndex, timezone, range.from, range.to]);
  const branches = useMemo(() => rankBranches(activities, 0), [activities]);
  const branchFacts = useMemo(() => branchDetails(activities), [activities]);
  const kinds = useMemo(() => rankKinds(activities, 0), [activities]);
  const actions = useMemo(() => rankActions(activities, 0), [activities]);
  const dayCount = useMemo(() => peopleFacts.values().next().value?.perDay.length ?? 0, [peopleFacts]);

  return (
    <aside className="commits-rail pane-scroll activity-panes-rail" data-panes={panes} aria-label="Who, where, what and how">
      <div className="rail-block pane-span">
        <div className="rail-block-head">
          <span className="rail-block-title">Who</span>
          <span className="rail-block-meta">{`${people.length.toLocaleString("en-US")} ${pluralize(people.length, "person", "people")}`}</span>
        </div>
        {people.length > 0 ? (
          <RankHead
            cols="rank-cols-people"
            label="person"
            countLabel="events"
            extras={[{ label: "share" }, { label: "repos" }, { label: "days" }, { label: "per day", start: true }]}
          />
        ) : null}
        <RankChart
          className="rail-rank-chart rank-cols-people"
          ariaLabel="Most active people in the selected range"
          empty="no attributed activity"
          countLabel={eventCountLabel}
          scale="max"
          items={people.slice(0, whoLimit).map((rank) => {
            const facts = peopleFacts.get(rank.key);
            return {
              key: rank.key,
              label: rank.label,
              count: rank.count,
              extra: facts ? (
                <>
                  <span>{share(rank.count, total)}</span>
                  <span>{facts.repos}</span>
                  <span>{`${facts.activeDays}/${dayCount}`}</span>
                  <Sparkline perDay={facts.perDay} />
                </>
              ) : undefined,
              detail: facts
                ? `${share(rank.count, total)} of the range, ${facts.repos} ${pluralize(facts.repos, "repo")}, active ${facts.activeDays} of ${dayCount} ${pluralize(dayCount, "day")}`
                : undefined,
              footer: (
                <span className="activity-rank-actor">
                  <ActorAvatar login={rank.label} avatarUrl={avatarOf?.get(rank.label)} titled={false} />
                  <span className="activity-rank-actor-name" aria-hidden="true">{rank.label}</span>
                </span>
              ),
            };
          })}
        />
      </div>

      <div className="rail-block pane-fill">
        <div className="rail-block-head">
          <span className="rail-block-title">Where</span>
          <span className="rail-block-meta">{`${repos.length.toLocaleString("en-US")} ${pluralize(repos.length, "repo")}`}</span>
        </div>
        {repos.length > 0 ? (
          <RankHead
            cols="rank-cols-places"
            label="repo"
            countLabel="events"
            extras={[{ label: "share" }, { label: "days" }, { label: "per day", start: true }]}
          />
        ) : null}
        <RankChart
          className="live-rank-chart-repos rail-rank-chart rank-cols-places pane-scroll"
          ariaLabel="Most active repositories in the selected range"
          empty="no repos in range"
          countLabel={eventCountLabel}
          scale="max"
          items={repos.slice(0, listLimit).map((rank) => {
            const path = rank.key.slice(rank.key.indexOf("|") + 1);
            const facts = repoFacts.get(rank.key);
            return {
              key: rank.key,
              label: rank.label,
              count: rank.count,
              selected: facets.repos.has(path),
              extra: facts ? (
                <>
                  <span>{share(rank.count, total)}</span>
                  <span>{`${facts.activeDays}/${facts.perDay.length}`}</span>
                  <Sparkline perDay={facts.perDay} />
                </>
              ) : undefined,
              detail: facts
                ? `${share(rank.count, total)} of the range, ${facts.authors} ${pluralize(facts.authors, "person", "people")}, active ${facts.activeDays} of ${facts.perDay.length} ${pluralize(facts.perDay.length, "day")}, last event ${relativeTime(facts.lastAt)}`
                : undefined,
              onSelect: onFacet ? () => onFacet("repos", path) : undefined,
              footer: (
                <span className="live-rank-name" aria-hidden="true">
                  {shortRepoLabel(rank.label)}
                </span>
              ),
            };
          })}
        />
      </div>

      <div className="rail-block pane-fill">
        <div className="rail-block-head">
          <span className="rail-block-title">Branches</span>
          <span className="rail-block-meta">{`${branches.length.toLocaleString("en-US")} with pushes or commits`}</span>
        </div>
        {branches.length > 0 ? <RankHead cols="rank-cols-branches" label="branch" countLabel="events" extras={[{ label: "repos" }]} /> : null}
        <RankChart
          className="live-rank-chart-labels rail-rank-chart rank-cols-branches pane-scroll"
          ariaLabel="Branches with the most pushes and commits in the selected range"
          empty="no branch refs in range"
          countLabel={eventCountLabel}
          scale="max"
          items={branches.slice(0, listLimit).map((rank) => {
            const facts = branchFacts.get(rank.key);
            return {
              key: rank.key,
              label: rank.label,
              count: rank.count,
              extra: facts ? <span>{facts.repos}</span> : undefined,
              detail: facts ? `${facts.isDefault ? "default branch, " : ""}in ${facts.repos} ${pluralize(facts.repos, "repo")}` : undefined,
              footer: (
                <span className="live-rank-name" aria-hidden="true">
                  {rank.label}
                  {facts?.isDefault ? <small className="rank-default-tag">default</small> : null}
                </span>
              ),
            };
          })}
        />
      </div>

      <FacetBlock title="What" label="kind" ariaLabel="Activity kinds in the selected range" ranks={kinds.slice(0, kindLimit)} totalKinds={kinds.length} unit={["kind", "kinds"]} total={total} selected={facets.kinds} onSelect={onFacet ? (value) => onFacet("kinds", value) : undefined} labelOf={(key) => displayKind(key) ?? key} />
      <FacetBlock title="How" label="action" ariaLabel="Activity actions in the selected range" ranks={actions.slice(0, kindLimit)} totalKinds={actions.length} unit={["action", "actions"]} total={total} selected={facets.actions} onSelect={onFacet ? (value) => onFacet("actions", value) : undefined} labelOf={(key) => key.replace(/_/g, " ")} />
    </aside>
  );
}

function FacetBlock({
  title,
  label,
  ariaLabel,
  ranks,
  totalKinds,
  unit,
  total,
  selected,
  onSelect,
  labelOf,
}: {
  title: string;
  label: string;
  ariaLabel: string;
  ranks: { key: string; label: string; count: number }[];
  totalKinds: number;
  unit: [string, string];
  total: number;
  selected: ReadonlySet<string>;
  onSelect?: (value: string) => void;
  labelOf: (key: string) => string;
}) {
  return (
    <div className="rail-block">
      <div className="rail-block-head">
        <span className="rail-block-title">{title}</span>
        <span className="rail-block-meta">{`${totalKinds} ${totalKinds === 1 ? unit[0] : unit[1]}`}</span>
      </div>
      {ranks.length > 0 ? <RankHead cols="rank-cols-share" label={label} countLabel="events" extras={[{ label: "share" }]} /> : null}
      <RankChart
        className="live-rank-chart-labels rail-rank-chart rank-cols-share"
        ariaLabel={ariaLabel}
        empty="no activity in range"
        countLabel={eventCountLabel}
        scale="max"
        items={ranks.map((rank) => ({
          key: rank.key,
          label: labelOf(rank.key),
          count: rank.count,
          selected: selected.has(rank.key),
          extra: <span>{share(rank.count, total)}</span>,
          detail: `${share(rank.count, total)} of the range`,
          onSelect: onSelect ? () => onSelect(rank.key) : undefined,
          footer: (
            <span className="live-rank-name" aria-hidden="true">
              {labelOf(rank.key)}
            </span>
          ),
        }))}
      />
    </div>
  );
}
