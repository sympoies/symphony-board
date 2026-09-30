import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, type CSSProperties } from "react";
import type { TimeRange } from "../model.ts";
import { churnByDay, dayAxisTicks, weekdayLabel } from "../rail-stats.ts";
import { formatAxisValue, niceAxisMax } from "../rank-scale.ts";

// Lines changed per day: additions above the baseline, deletions below it.
//
// A commit count treats a one-line fix and a vendored directory as the same
// thing. This is the other half of "how much work": the day with the most
// commits is often not the day with the most change, and a bar that hangs
// mostly below the line is a clean-up rather than new work.
//
// Both directions share one scale, so a deletion bar can be compared with an
// addition bar by eye. The counts are the ones each commit row already shows;
// a merge commit carries none (see DiffStat), so a merged branch is never
// counted twice here. How many commits the figure covers is stated once, on
// the overview's "lines changed" tile, rather than again under this plot.

// Compact, like the axis ticks: "+495.6k" rather than "+495,612".
function compact(value: number): string {
  return formatAxisValue(value);
}

// Past this many days a weekday name no longer identifies a bar.
const WEEKDAY_TICK_DAYS_MAX = 10;

export function CommitChurn({
  commits,
  timezone,
  range,
}: {
  commits: ActivityDTO[];
  timezone: string;
  range: TimeRange;
}) {
  const days = useMemo(() => churnByDay(commits, timezone, range.from, range.to), [commits, timezone, range.from, range.to]);
  if (days.length === 0) return null;

  const totals = days.reduce(
    (sum, day) => ({
      additions: sum.additions + day.additions,
      deletions: sum.deletions + day.deletions,
      counted: sum.counted + day.counted,
    }),
    { additions: 0, deletions: 0, counted: 0 },
  );
  const axisMax = niceAxisMax(Math.max(1, ...days.map((day) => Math.max(day.additions, day.deletions))));
  const weekdayTicks = days.length <= WEEKDAY_TICK_DAYS_MAX;
  const ticks = new Map(dayAxisTicks(days).map((tick) => [tick.index, tick.label]));

  return (
    <div className="rail-block commit-churn">
      <div className="rail-block-head">
        <span className="rail-block-title">Lines changed per day</span>
        {totals.counted > 0 ? (
          <span className="rail-block-meta commit-diffstat">
            <span className="commit-diffstat-add">+{compact(totals.additions)}</span>
            <span className="commit-diffstat-del">-{compact(totals.deletions)}</span>
          </span>
        ) : null}
      </div>
      {totals.counted === 0 ? (
        <div className="pane-empty">no line counts in range</div>
      ) : (
        <div
          className="stack-plot churn-plot"
          role="img"
          aria-label={`Lines changed per day, ${range.from} to ${range.to}: ${totals.additions.toLocaleString("en-US")} added, ${totals.deletions.toLocaleString("en-US")} removed`}
        >
          <div className="stack-yaxis" aria-hidden="true">
            <span>+{compact(axisMax)}</span>
            <span>0</span>
            <span>-{compact(axisMax)}</span>
          </div>
          <div className="churn-cols" data-density={days.length > 62 ? "dense" : days.length > 31 ? "tight" : undefined}>
            <i className="stack-grid stack-grid-top" aria-hidden="true" />
            <i className="stack-grid churn-grid-zero" aria-hidden="true" />
            <i className="stack-grid stack-grid-base" aria-hidden="true" />
            {days.map((day) => (
              <span key={day.date} className="churn-col">
                <span className="rail-daybar-tip">
                  {`${weekdayLabel(day.date)} ${day.date} · +${day.additions.toLocaleString("en-US")} -${day.deletions.toLocaleString("en-US")} · ${day.counted.toLocaleString("en-US")} of ${day.commits.toLocaleString("en-US")} commits counted`}
                </span>
                {day.additions > 0 ? (
                  <span className="churn-add" style={{ "--churn-h": `${(day.additions / axisMax) * 50}%` } as CSSProperties} />
                ) : null}
                {day.deletions > 0 ? (
                  <span className="churn-del" style={{ "--churn-h": `${(day.deletions / axisMax) * 50}%` } as CSSProperties} />
                ) : null}
              </span>
            ))}
          </div>
          <div className="rail-days-axis" aria-hidden="true">
            {days.map((day, index) => (
              <i key={day.date}>
                {ticks.has(index) ? <span>{weekdayTicks ? weekdayLabel(day.date) : ticks.get(index)}</span> : null}
              </i>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
