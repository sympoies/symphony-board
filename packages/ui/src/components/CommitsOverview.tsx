import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, type CSSProperties, type Ref } from "react";
import { EMPTY_ACTOR_INDEX, countsByDay, rankActors, rankBranches, rankRepos, type ActorIndex, type DayBucket } from "../rail-stats.ts";
import { HourProfile } from "./HourProfile.tsx";
import { niceAxisMax, rankBarHeight } from "../rank-scale.ts";
import type { TimeRange } from "../model.ts";

// The Commits overview column: the SHAPE of the selected range over time.
//
// It exists because the Commits page grew to five digest blocks stacked in one
// rail, which on a wide panel reads as a tall thin ribbon beside a list that has
// height to spare. Splitting them the way Activity already splits feed /
// overview / rail gives each half a coherent job:
//
//   overview (here) — how much, when, and over how many days: the range summary,
//                     the per-day strip, and the hour-of-day silhouette. Nothing
//                     here is a filter; it is all read-only context.
//   rail            — the four RANKED facets (repos / branches / types /
//                     authors), each row of which applies the filter it names.
//
// Everything derives from the same rows the list renders, so this can never
// disagree with the commits beside it and needs no fetch of its own.

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

export function CommitsOverview({
  commits,
  timezone,
  range,
  actorIndex = EMPTY_ACTOR_INDEX,
  panelRef,
}: {
  // The rows currently on screen — every block here describes exactly these.
  commits: ActivityDTO[];
  timezone: string;
  range: TimeRange;
  // So the authors tile counts PEOPLE the way the rail ranks them (identities
  // merged, bots dropped) rather than raw actor strings.
  actorIndex?: ActorIndex;
  panelRef?: Ref<HTMLElement>;
}) {
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

  const summary = [
    { label: "commits", value: commits.length.toLocaleString("en-US"), detail: "in range" },
    ...(busiest ? [{ label: "busiest day", value: busiest.count.toLocaleString("en-US"), detail: busiest.date }] : []),
    ...(days.length > 0
      ? [{ label: "active days", value: activeDays.toLocaleString("en-US"), detail: `of ${days.length} days` }]
      : []),
    { label: "repos", value: repoCount.toLocaleString("en-US"), detail: repoCount === 1 ? "repo" : "repos" },
    { label: "authors", value: authorCount.toLocaleString("en-US"), detail: authorCount === 1 ? "author" : "authors" },
    { label: "branches", value: branchCount.toLocaleString("en-US"), detail: branchCount === 1 ? "branch" : "branches" },
  ];

  return (
    <aside ref={panelRef} className="commits-overview" aria-label="Commit range overview">
      <div className="hm-overview-head">
        <h3>Commit overview</h3>
        <small>{`${range.from} to ${range.to}`}</small>
      </div>

      <dl className="hm-summary">
        {summary.map((item) => (
          <div key={`${item.label}-${item.detail}`}>
            <dt>{item.label}</dt>
            <dd>
              {item.value}
              <small>{item.detail}</small>
            </dd>
          </div>
        ))}
      </dl>

      <DayBars days={days} range={range} />
      <HourProfile rows={commits} subject="Commits" timezone={timezone} countLabel={commitCountLabel} />
    </aside>
  );
}
