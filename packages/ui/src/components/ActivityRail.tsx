import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, type CSSProperties } from "react";
import { RankChart } from "./RankChart.tsx";
import { ActorAvatar } from "./ActorAvatar.tsx";
import { countsByHour, rankActions, rankActors, rankKinds, rankRepos, shortRepoLabel } from "../rail-stats.ts";
import { niceAxisMax, rankBarHeight } from "../rank-scale.ts";

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

const RAIL_RANK_LIMIT = 6;

function eventCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "event" : "events"}`;
}

// Hour-of-day profile. All 24 bars always render, including empty ones: the
// silhouette of a working day — the overnight trough, the morning ramp — is the
// information, and dropping quiet hours would flatten it into a ranking.
function HourProfile({ activities, timezone }: { activities: ActivityDTO[]; timezone: string }) {
  const hours = useMemo(() => countsByHour(activities, timezone), [activities, timezone]);
  const total = hours.reduce((sum, h) => sum + h.count, 0);
  if (total === 0) return null;
  const axisMax = niceAxisMax(Math.max(1, ...hours.map((h) => h.count)));
  const peak = hours.reduce((best, h) => (h.count > best.count ? h : best), hours[0]!);
  return (
    <div className="rail-block">
      <div className="rail-block-head">
        <span className="rail-block-title">When</span>
        <span className="rail-block-meta">peak {formatHour(peak.hour)}</span>
      </div>
      <div
        className="rail-hours"
        role="img"
        aria-label={`Activity by hour of day; busiest hour ${formatHour(peak.hour)} with ${eventCountLabel(peak.count)}`}
      >
        {hours.map((h) => (
          <span
            key={h.hour}
            className="rail-hourbar"
            style={{ "--rank-h": rankBarHeight(h.count, axisMax) } as CSSProperties}
            data-empty={h.count === 0 ? "true" : undefined}
          >
            <span className="rail-daybar-tip">{`${formatHour(h.hour)} · ${eventCountLabel(h.count)}`}</span>
            <span className="rail-daybar-fill" />
          </span>
        ))}
      </div>
      <div className="rail-hours-axis" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function ActivityRail({
  activities,
  timezone,
  avatarOf,
}: {
  activities: ActivityDTO[];
  timezone: string;
  // Login -> avatar URL, from review-thread comments. Absent logins fall back to
  // initials, so the Who column keeps one shape whoever is in it.
  avatarOf?: ReadonlyMap<string, string>;
}) {
  const actorRanks = useMemo(() => rankActors(activities, RAIL_RANK_LIMIT), [activities]);
  const repoRanks = useMemo(() => rankRepos(activities, RAIL_RANK_LIMIT), [activities]);
  const actorTotal = useMemo(() => rankActors(activities, 0).length, [activities]);
  const repoTotal = useMemo(() => rankRepos(activities, 0).length, [activities]);
  const kindRanks = useMemo(() => rankKinds(activities, RAIL_RANK_LIMIT), [activities]);
  const actionRanks = useMemo(() => rankActions(activities, RAIL_RANK_LIMIT), [activities]);
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
            footer: <ActorAvatar login={rank.label} avatarUrl={avatarOf?.get(rank.label)} />,
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

      <HourProfile activities={activities} timezone={timezone} />

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
