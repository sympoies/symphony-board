import type { ActivityDTO, ActivityDailyDTO } from "@symphony-board/contract";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import {
  EMPTY_ACTOR_INDEX,
  churnByDay,
  commitSizeSummary,
  countsByDay,
  dayAxisTicks,
  rankActors,
  rankBranches,
  rankRepos,
  type ActorIndex,
  type DayBucket,
} from "../rail-stats.ts";
import { HourProfile } from "./HourProfile.tsx";
import { HeatmapCalendar, type HeatmapTip } from "./HeatmapCalendar.tsx";
import { CommitDayChart } from "./CommitDayChart.tsx";
import { CommitChurn } from "./CommitChurn.tsx";
import { CommitPunchCard } from "./CommitPunchCard.tsx";
import { LargestCommits } from "./LargestCommits.tsx";
import { buildActivityHeatmapFromDaily, heatmapStreaks, pluralize, previousPeriodCount, rangeIsCovered } from "../model.ts";
import { formatAxisValue, niceAxisMax, rankBarHeight } from "../rank-scale.ts";
import type { TimeRange } from "../model.ts";

// The Commits overview column: the SHAPE of the selected range over time.
//
// It exists because the Commits page grew to five digest blocks stacked in one
// rail, which on a wide panel reads as a tall thin ribbon beside a list that has
// height to spare. Splitting them the way Activity already splits feed /
// overview / rail gives each half a coherent job:
//
//   overview (here) — how much, when, and over how many days: the range summary,
//                     the trailing-year rhythm that gives it scale, the per-day
//                     strip, and the hour-of-day silhouette. Nothing here is a
//                     filter; it is all read-only context.
//   rail            — the four RANKED facets (repos / branches / types /
//                     authors), each row of which applies the filter it names.
//
// Everything derives from the same rows the list renders, so this can never
// disagree with the commits beside it and needs no fetch of its own.
//
// From the wide-panes tier (`wide`, COMMITS_PANES_MIN_WIDTH_PX) the column is a
// two-up grid with room for more than four panes, and what it does with spare
// height changes. Below the tier the two strips grow to fill the pane; on a
// tall, wide panel that turned seven day bars into seven 120x370px slabs that
// said nothing more than they did at 56px. Here the charts keep a designed
// height -- the per-day strip becomes a stacked chart, the hour strip a
// day-by-hour grid, and lines changed gets a pane of its own -- and the height
// left over goes to a list, Largest commits, which answers it with more rows.

function commitCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "commit" : "commits"}`;
}

// Chronological per-day bars. Deliberately NOT a RankChart: those sort by size,
// and the whole point of this strip is the shape of the range in order, gaps
// included. Moved here from the rail, where it was the one block that wanted
// width rather than rows.
// Takes the buckets rather than deriving them: the parent needs the same array
// for its summary tiles, and countsByDay costs an Intl-backed pass per row
// (~5us each on a non-UTC contract timezone), which at 25k rows is tens of
// milliseconds to pay twice on every filter change.
function DayBars({ days, range }: { days: readonly DayBucket[]; range: TimeRange }) {
  if (days.length === 0) return null;
  const max = Math.max(1, ...days.map((d) => d.count));
  const axisMax = niceAxisMax(max);
  const total = days.reduce((sum, d) => sum + d.count, 0);
  // The strip had no text of its own: no dates under the bars and nothing to
  // read their height against, so it could only be read by hovering each bar.
  // The axis names the days; the peak in the head is the scale, since the
  // tallest bar is that count.
  const ticks = new Map(dayAxisTicks(days).map((tick) => [tick.index, tick.label]));
  return (
    <div className="rail-block">
      <div className="rail-block-head">
        <span className="rail-block-title">Commits per day</span>
        <span className="rail-block-meta">
          {total > 0 ? `peak ${max.toLocaleString("en-US")} · ${commitCountLabel(total)}` : commitCountLabel(total)}
        </span>
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
      <div className="rail-days-axis" aria-hidden="true">
        {days.map((day, index) => (
          <i key={day.date}>{ticks.has(index) ? <span>{ticks.get(index)}</span> : null}</i>
        ))}
      </div>
    </div>
  );
}

// The trailing-12-month commit calendar.
//
// Every other block in this column describes the SELECTED range; this one is
// deliberately the whole history, because a week of bars says nothing about
// whether that week was busy. It reads `activity_daily`, which the producer
// buckets per kind per day, so charting commits alone costs nothing extra and
// needs no contract change — the emitted `activities[]` is windowed and could
// not reach back a year.
function CommitRhythm({
  activityDaily,
  range,
  onTip,
  facts = false,
}: {
  activityDaily: ActivityDailyDTO | null;
  range: TimeRange;
  onTip: (tip: HeatmapTip | null) => void;
  // The wide tier's summary of the year under the calendar. Activity states
  // these above its own calendar; this column's tiles are about the selected
  // range, so the year had no figures of its own here at all.
  facts?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heatmap = useMemo(
    () => (activityDaily ? buildActivityHeatmapFromDaily(activityDaily, "commit") : null),
    [activityDaily],
  );

  // Open on the most recent week rather than a year ago.
  //
  // Observed rather than timed, and observed on the CONTENT rather than the
  // scroller. This column is a ratio track, so nothing here is final at mount:
  // pinning once, or once more a frame later, left the calendar 10px short of
  // the last week. The scroller box never changed — its CONTENT did, as the
  // month labels settled — so watching the scroller saw nothing. The observer
  // re-pins whenever the grid actually grows, and stops as soon as the reader
  // scrolls, so it never fights someone looking at an earlier month.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;

    let follow = true;
    const pin = () => {
      if (follow) node.scrollLeft = node.scrollWidth;
    };
    // A programmatic pin fires scroll too, so only a position that is NOT the
    // end counts as the reader taking over.
    const onScroll = () => {
      if (Math.abs(node.scrollWidth - node.clientWidth - node.scrollLeft) > 2) follow = false;
    };

    pin();
    node.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(pin) : null;
    observer?.observe(node);
    // The calendar itself: the scroller keeps its width while the grid inside
    // it grows, and it is that growth which moves the end.
    if (node.firstElementChild) observer?.observe(node.firstElementChild);

    return () => {
      node.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [heatmap?.from, heatmap?.to, heatmap?.weeks.length]);
  // No commit history at all (or a pre-4.0.0 payload with no aggregate) means
  // there is no figure to draw, and an empty grid would read as "no commits
  // ever" rather than "not loaded".
  if (!heatmap || heatmap.total === 0) return null;

  const hasRange = Boolean(range.from) && Boolean(range.to) && range.from <= range.to;
  const streaks = facts ? heatmapStreaks(heatmap) : null;
  return (
    <div className="rail-block pane-span">
      <div className="rail-block-head">
        <span className="rail-block-title">Commit rhythm</span>
        <span className="rail-block-meta">{`last 12 months · ${heatmap.total.toLocaleString("en-US")} commits`}</span>
      </div>
      <div ref={scrollRef} className="hm-calendar-scroll">
        <HeatmapCalendar
          heatmap={heatmap}
          label={`Daily commits from ${heatmap.from} to ${heatmap.to}`}
          cellTip={(cell) => `${cell.date} · ${cell.count.toLocaleString("en-US")} ${pluralize(cell.count, "commit")}`}
          inSelectedRange={(date) => hasRange && date >= range.from && date <= range.to}
          onTip={onTip}
        />
      </div>
      {streaks ? (
        <dl className="hm-facts">
          <div>
            <dt>daily average</dt>
            <dd>{Math.round(heatmap.total / Math.max(1, heatmap.dayCount)).toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>active days</dt>
            <dd>
              {heatmap.activeDays.toLocaleString("en-US")} <small>{`of ${heatmap.dayCount}`}</small>
            </dd>
          </div>
          <div>
            <dt>current streak</dt>
            <dd>
              {streaks.current.toLocaleString("en-US")} <small>{pluralize(streaks.current, "day")}</small>
            </dd>
          </div>
          <div>
            <dt>longest streak</dt>
            <dd>
              {streaks.longest.toLocaleString("en-US")} <small>{pluralize(streaks.longest, "day")}</small>
            </dd>
          </div>
          {heatmap.busiest ? (
            <div>
              <dt>busiest day</dt>
              <dd>
                {heatmap.busiest.count.toLocaleString("en-US")} <small>{heatmap.busiest.date}</small>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

// How the range compares with the same number of days before it, as a chip
// beside the commit count. Null when there is nothing honest to say: the
// aggregate does not reach back that far, or the list is filtered -- the
// aggregate counts every commit, so a filtered count beside it would compare a
// part with a whole.
function PeriodDelta({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null) return null;
  if (previous === 0) {
    return current > 0 ? <span className="hm-delta" data-dir="up">new</span> : null;
  }
  const change = Math.round(((current - previous) / previous) * 100);
  const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return (
    <span className="hm-delta" data-dir={dir} title={`${previous.toLocaleString("en-US")} in the period before`}>
      {dir === "up" ? "▲" : dir === "down" ? "▼" : "="} {Math.abs(change).toLocaleString("en-US")}%
    </span>
  );
}

export function CommitsOverview({
  commits,
  activityDaily,
  timezone,
  range,
  actorIndex = EMPTY_ACTOR_INDEX,
  panelRef,
  wide = false,
  comparable = false,
  selectedKey = null,
  onSelectCommit,
}: {
  // The rows currently on screen — every block here describes exactly these,
  // EXCEPT the rhythm calendar below, which is deliberately the full history.
  commits: ActivityDTO[];
  // Per-day/per-kind counts over the whole canonical history (4.0.0+). The
  // emitted `activities[]` is windowed, so this is the only source wide enough
  // for a trailing-12-month figure. Absent on an older payload, where the
  // calendar simply does not render.
  activityDaily: ActivityDailyDTO | null;
  timezone: string;
  range: TimeRange;
  // So the authors tile counts PEOPLE the way the rail ranks them (identities
  // merged, bots dropped) rather than raw actor strings.
  actorIndex?: ActorIndex;
  panelRef?: Ref<HTMLElement>;
  // The wide-panes tier: see the note at the top of this file.
  wide?: boolean;
  // True when nothing narrows `commits`: no repo / branch / author / source
  // filter and nothing hidden in Settings (commitScopeIsWhole). Only then can
  // the count be set against activity_daily, which counts every commit.
  comparable?: boolean;
  // The commit shown in the detail pane, and the way to change it, for the
  // Largest commits rows.
  selectedKey?: string | null;
  onSelectCommit?: (commit: ActivityDTO) => void;
}) {
  const [tip, setTip] = useState<HeatmapTip | null>(null);
  const days = useMemo(
    () => countsByDay(commits, timezone, range.from, range.to),
    [commits, timezone, range.from, range.to],
  );
  // Counted over the visible rows rather than the facet sources: these are
  // read-only totals describing what is on screen, not a menu of somewhere else
  // to go (that is the rail's job, and it counts each facet with its OWN filter
  // lifted so the list you stand in still offers an exit).
  const repoCount = useMemo(() => rankRepos(commits, 0).length, [commits]);
  const authorCount = useMemo(() => rankActors(commits, 0, actorIndex).length, [commits, actorIndex]);
  const branchCount = useMemo(() => rankBranches(commits, 0).length, [commits]);

  const busiest = days.reduce<{ date: string; count: number } | null>(
    (best, day) => (day.count > 0 && (!best || day.count > best.count) ? day : best),
    null,
  );
  const activeDays = days.filter((d) => d.count > 0).length;

  // The wide tier's extra figures. Each is a pass over every row, so none of
  // them is computed for a layout that has no tile to put it in, and each is
  // computed once: the per-day churn feeds both its tile here and the Lines
  // changed pane below, which takes the array rather than deriving its own.
  const churnDays = useMemo(
    () => (wide ? churnByDay(commits, timezone, range.from, range.to) : null),
    [wide, commits, timezone, range.from, range.to],
  );
  const churn = useMemo(
    () =>
      churnDays
        ? churnDays.reduce(
            (sum, day) => ({ additions: sum.additions + day.additions, deletions: sum.deletions + day.deletions, counted: sum.counted + day.counted }),
            { additions: 0, deletions: 0, counted: 0 },
          )
        : null,
    [churnDays],
  );
  const sizes = useMemo(() => (wide ? commitSizeSummary(commits) : null), [wide, commits]);
  // The comparison is drawn only when it compares like with like: nothing
  // narrows the list (`comparable`), AND the rows on screen really are the
  // range the aggregate describes -- which a feed windowed shorter than the
  // range makes false without any filter being set. See rangeIsCovered.
  const previous =
    wide && comparable && rangeIsCovered(activityDaily, range.from, range.to, commits.length, "commit")
      ? previousPeriodCount(activityDaily, range.from, range.to, "commit")
      : null;

  const summary: { label: string; value: ReactNode; detail: string }[] = [
    {
      label: "commits",
      value: (
        <>
          {commits.length.toLocaleString("en-US")}
          <PeriodDelta current={commits.length} previous={previous} />
        </>
      ),
      detail:
        previous !== null
          ? `in range · ${previous.toLocaleString("en-US")} in the ${days.length} ${pluralize(days.length, "day")} before`
          : "in range",
    },
    ...(churn
      ? [
          {
            label: "lines changed",
            value:
              churn.counted > 0 ? (
                <>
                  <span className="commit-diffstat-add">+{formatAxisValue(churn.additions)}</span>{" "}
                  <span className="commit-diffstat-del">-{formatAxisValue(churn.deletions)}</span>
                </>
              ) : (
                "—"
              ),
            detail: `${churn.counted.toLocaleString("en-US")} of ${commits.length.toLocaleString("en-US")} commits counted`,
          },
        ]
      : []),
    ...(busiest ? [{ label: "busiest day", value: busiest.count.toLocaleString("en-US"), detail: busiest.date }] : []),
    ...(days.length > 0
      ? [{ label: "active days", value: activeDays.toLocaleString("en-US"), detail: `of ${days.length} days` }]
      : []),
    // These three say what the count is OVER rather than repeating their own
    // label: "Repos 30 repos" used the label as its own detail, so the line
    // carried nothing. The tiles above earn theirs by saying something the
    // number does not — which date was busiest, how many days the active ones
    // are out of.
    { label: "repos", value: repoCount.toLocaleString("en-US"), detail: "with commits" },
    { label: "authors", value: authorCount.toLocaleString("en-US"), detail: "with commits" },
    { label: "branches", value: branchCount.toLocaleString("en-US"), detail: "with commits" },
    ...(wide
      ? [
          {
            label: "median commit",
            value: sizes?.median != null ? sizes.median.toLocaleString("en-US") : "—",
            detail: sizes?.largest != null ? `lines · largest ${sizes.largest.toLocaleString("en-US")}` : "no line counts",
          },
        ]
      : []),
  ];

  return (
    <aside
      ref={panelRef}
      className={`commits-overview${wide ? " pane-scroll" : ""}`}
      data-panes={wide ? "wide" : undefined}
      aria-label="Commit range overview"
    >
      {/* A .rail-block like every other panel in this column and the rail beside
          it. Activity can leave its head and summary unwrapped because its whole
          overview is one .activity-heatmap card; this column is a stack of
          cards, so an unwrapped block sits bare on the page background while
          everything around it has a surface. */}
      <div className="rail-block pane-span">
        <div className="hm-overview-head">
          <h3>Commit overview</h3>
          <small>{`${range.from} to ${range.to}`}</small>
        </div>

        <dl className="hm-summary">
          {summary.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                {item.value}
                <small>{item.detail}</small>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* The rhythm reads SECOND, against the summary rather than after the two
          strips. Every tile above it is a count inside the selected range, and a
          count has no scale on its own: 1,810 commits is the week's whole story
          only next to the year it came out of. The two range-shaped strips that
          follow then say when inside the range those commits landed. */}
      <CommitRhythm activityDaily={activityDaily} range={range} onTip={setTip} facts={wide} />
      {wide ? (
        <>
          <CommitDayChart commits={commits} timezone={timezone} range={range} actorIndex={actorIndex} />
          {churnDays ? <CommitChurn days={churnDays} range={range} /> : null}
          <CommitPunchCard commits={commits} timezone={timezone} range={range} />
          <LargestCommits commits={commits} selectedKey={selectedKey} onSelect={onSelectCommit ?? (() => {})} />
        </>
      ) : (
        <>
          <DayBars days={days} range={range} />
          <HourProfile rows={commits} subject="Commits" timezone={timezone} countLabel={commitCountLabel} />
        </>
      )}

      {tip ? (
        <div className="hm-tip" role="status" style={{ left: tip.x, top: tip.y } as CSSProperties}>
          {tip.label}
        </div>
      ) : null}
    </aside>
  );
}
