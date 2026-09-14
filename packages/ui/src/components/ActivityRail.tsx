import { useMediaQuery } from "../useMediaQuery.ts";
import { RAIL_RANK_LIMIT, RAIL_RANK_LIMIT_ROWS, RAIL_ROWS_QUERY } from "../layout-tier.ts";
import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, type CSSProperties } from "react";
import { RankChart } from "./RankChart.tsx";
import { HourProfile } from "./HourProfile.tsx";
import { ActorAvatar } from "./ActorAvatar.tsx";
import { EMPTY_ACTOR_INDEX, rankActions, rankActors, rankKinds, rankRepos, shortRepoLabel, type ActorIndex } from "../rail-stats.ts";

// The Activity "who / where / when / what / how" rail.
//
// The overview panel beside it already answers how much and on which DAY (the
// trailing-12-month rhythm heatmap, the range summary, the per-day trend). These
// blocks are the dimensions it does not carry:
//
//   Who   — the feed shows an actor per row, but nothing totals them.
//   Where — same, for repositories.
//   When  — the heatmap's finest grain is a day of the week. Nothing anywhere
//           shows time of day, which for a board about working rhythm is the
//           gap worth filling.
//   What  — the kind vocabulary the filter chips already use, with counts.
//   How   — the same for actions.
//
// All of them derive from the same range-filtered `activities` the feed renders,
// so the rail needs no fetch and cannot disagree with the feed.

// The limit is a tier, not a constant: see layout-tier.ts. A sidebar rail
// lays these charts out as rows, where an extra item costs 26px of height the
// column already has rather than 34px of width it does not.

function eventCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "event" : "events"}`;
}

export function ActivityRail({
  activities,
  timezone,
  avatarOf,
  actorIndex = EMPTY_ACTOR_INDEX,
}: {
  activities: ActivityDTO[];
  timezone: string;
  // Login -> avatar URL, from review-thread comments. Absent logins fall back to
  // initials, so the Who column keeps one shape whoever is in it.
  avatarOf?: ReadonlyMap<string, string>;
  // Contract actor directory as lookups, so Who merges a person's facets into
  // one row and drops CI accounts — the same resolution repo_metrics.top_actors
  // applies. See rail-stats.
  actorIndex?: ActorIndex;
}) {
  // Rows are cheap in a sidebar and expensive across a narrow column, so the
  // count follows the layout rather than being fixed. useMediaQuery re-renders
  // on the breakpoint, so resizing onto a second monitor re-evaluates it.
  const railRows = useMediaQuery(RAIL_ROWS_QUERY);
  const rankLimit = railRows ? RAIL_RANK_LIMIT_ROWS : RAIL_RANK_LIMIT;

  const actorRanks = useMemo(() => rankActors(activities, rankLimit, actorIndex), [activities, rankLimit, actorIndex]);
  const repoRanks = useMemo(() => rankRepos(activities, rankLimit), [activities, rankLimit]);
  const actorTotal = useMemo(() => rankActors(activities, 0, actorIndex).length, [activities, actorIndex]);
  const repoTotal = useMemo(() => rankRepos(activities, 0).length, [activities]);
  const kindRanks = useMemo(() => rankKinds(activities, rankLimit), [activities, rankLimit]);
  const actionRanks = useMemo(() => rankActions(activities, rankLimit), [activities, rankLimit]);
  const kindTotal = useMemo(() => rankKinds(activities, 0).length, [activities]);
  const actionTotal = useMemo(() => rankActions(activities, 0).length, [activities]);

  return (
    <aside className="activity-rail" aria-label="Who, where, when, what and how">
      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">Who</span>
          <span className="rail-block-meta">{actorTotal} total</span>
        </div>
        <RankChart
          className="rail-rank-chart"
          ariaLabel="Most active people in the selected range"
          empty="no attributed activity"
          countLabel={eventCountLabel}
          items={actorRanks.map((rank) => ({
            key: rank.key,
            label: rank.label,
            count: rank.count,
            // A face rather than a clipped login, matching the Live tab's buffer
            // card. The account name is on hover, which is the only way it fits.
            footer: <ActorAvatar login={rank.label} avatarUrl={avatarOf?.get(rank.label)} titled={false} />,
          }))}
        />
      </div>

      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">Where</span>
          <span className="rail-block-meta">{repoTotal} total</span>
        </div>
        <RankChart
          className="live-rank-chart-repos rail-rank-chart"
          ariaLabel="Most active repositories in the selected range"
          empty="no repos in range"
          countLabel={eventCountLabel}
          items={repoRanks.map((rank) => ({
            key: rank.key,
            label: rank.label,
            count: rank.count,
            footer: (
              <span className="live-rank-name" aria-hidden="true">
                {shortRepoLabel(rank.label)}
              </span>
            ),
          }))}
        />
      </div>

      <HourProfile rows={activities} subject="Activity" timezone={timezone} countLabel={eventCountLabel} />

      {/* What / How put counts on the same vocabulary as the filter chips above
          the feed. The chips have always been able to narrow by kind and action
          without ever saying how much of the range each one covers. */}
      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">What</span>
          <span className="rail-block-meta">{kindTotal} kinds</span>
        </div>
        <RankChart
          className="rail-rank-chart"
          ariaLabel="Activity kinds in the selected range"
          empty="no activity in range"
          countLabel={eventCountLabel}
          items={kindRanks.map((rank) => ({
            key: rank.key,
            label: railKindLabel(rank.label),
            count: rank.count,
            footer: (
              <span className="live-rank-name" aria-hidden="true">
                {railKindLabel(rank.label)}
              </span>
            ),
          }))}
        />
      </div>

      <div className="rail-block">
        <div className="rail-block-head">
          <span className="rail-block-title">How</span>
          <span className="rail-block-meta">{actionTotal} actions</span>
        </div>
        <RankChart
          className="rail-rank-chart"
          ariaLabel="Activity actions in the selected range"
          empty="no activity in range"
          countLabel={eventCountLabel}
          items={actionRanks.map((rank) => ({
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
    </aside>
  );
}

// `change_request` is the contract's provider-neutral name and is far too long for
// a rank footer; the feed's own chips already read it as two words.
function railKindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}
