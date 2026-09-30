import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, useState, type CSSProperties } from "react";
import { commitMessage } from "../model.ts";
import type { TimeRange } from "../model.ts";
import {
  STACK_FOLD_KEY,
  commitTypeOf,
  dayAxisTicks,
  shortRepoLabel,
  stackedDays,
  weekdayLabel,
  type ActorIndex,
} from "../rail-stats.ts";
import { formatAxisValue, niceAxisMax } from "../rank-scale.ts";

// Commits per day for the wide-panes tier: the same days the plain strip draws,
// split by what the work WAS.
//
// The plain strip answers "how many" and nothing else, and on a wide panel its
// only way to use the room it was given was to draw the same seven numbers
// bigger. This keeps the plot at a designed height and spends the room on a
// second variable instead: each bar is stacked by commit type, by repository or
// by author, so a tall day also says whether it was a release, one repo, or one
// person.
//
// Four series and a fold, because the theme has four series hues and because a
// reader cannot hold more than that in a legend. The fold is a real series: a
// day's segments always add up to its total.

type StackBy = "type" | "repo" | "author";

const STACK_BY: readonly StackBy[] = ["type", "repo", "author"];
const STACK_SERIES_LIMIT = 4;
// Past this many days a total on every bar collides with its neighbours.
const CAP_LABEL_DAYS_MAX = 14;
// Past this many a weekday prefix no longer fits beside the date.
const WEEKDAY_TICK_DAYS_MAX = 10;

function commitCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "commit" : "commits"}`;
}

function keyOfBy(by: StackBy, actorIndex: ActorIndex): (a: ActivityDTO) => { key: string; label: string } {
  if (by === "repo") {
    return (a) => {
      const path = a.project_path?.trim();
      // A commit with no repository is rare and nameless; it belongs in the fold.
      return path ? { key: `${a.source_id}|${path}`, label: shortRepoLabel(path) } : { key: STACK_FOLD_KEY, label: STACK_FOLD_KEY };
    };
  }
  if (by === "author") {
    return (a) => {
      const actor = a.actor?.trim();
      if (!actor) return { key: STACK_FOLD_KEY, label: STACK_FOLD_KEY };
      const name = actorIndex.canonical.get(actor) ?? actor;
      return { key: name, label: name };
    };
  }
  return (a) => {
    const type = commitTypeOf(commitMessage(a));
    return { key: type, label: type };
  };
}

export function CommitDayChart({
  commits,
  timezone,
  range,
  actorIndex,
}: {
  commits: ActivityDTO[];
  timezone: string;
  range: TimeRange;
  actorIndex: ActorIndex;
}) {
  const [by, setBy] = useState<StackBy>("type");
  const stack = useMemo(
    () => stackedDays(commits, timezone, range.from, range.to, keyOfBy(by, actorIndex), STACK_SERIES_LIMIT),
    [commits, timezone, range.from, range.to, by, actorIndex],
  );
  if (stack.days.length === 0) return null;

  const total = stack.days.reduce((sum, day) => sum + day.total, 0);
  const axisMax = niceAxisMax(Math.max(1, stack.max));
  const capLabels = stack.days.length <= CAP_LABEL_DAYS_MAX;
  const weekdayTicks = stack.days.length <= WEEKDAY_TICK_DAYS_MAX;
  const ticks = new Map(dayAxisTicks(stack.days).map((tick) => [tick.index, tick.label]));
  // The slot a series paints with. The fold is always the neutral one, whatever
  // its rank, so "everything else" never borrows a hue that reads as a name.
  const slotOf = (index: number) => (stack.series[index]?.key === STACK_FOLD_KEY ? "fold" : String(index));

  return (
    <div className="rail-block pane-span commit-day-chart">
      <div className="rail-block-head">
        <span className="rail-block-title">Commits per day</span>
        <span className="pane-seg" role="group" aria-label="Split commits per day by">
          {STACK_BY.map((option) => (
            <button
              key={option}
              type="button"
              className="pane-seg-option"
              aria-pressed={by === option}
              onClick={() => setBy(option)}
            >
              {option}
            </button>
          ))}
        </span>
        <span className="rail-block-meta">
          {total > 0 ? `peak ${stack.max.toLocaleString("en-US")} · ${commitCountLabel(total)}` : commitCountLabel(total)}
        </span>
      </div>

      <ul className="stack-legend" aria-label={`Commits by ${by}`}>
        {stack.series.map((series, index) => (
          <li key={series.key} className="stack-legend-item">
            <span className="stack-swatch" data-series={slotOf(index)} aria-hidden="true" />
            {series.label}
            <small>{series.count.toLocaleString("en-US")}</small>
          </li>
        ))}
      </ul>

      <div
        className="stack-plot"
        role="img"
        aria-label={`Commits per day by ${by}, ${range.from} to ${range.to}: ${commitCountLabel(total)}, busiest day ${stack.max.toLocaleString("en-US")}`}
      >
        <div className="stack-yaxis" aria-hidden="true">
          <span>{formatAxisValue(axisMax)}</span>
          <span>{formatAxisValue(axisMax / 2)}</span>
          <span>0</span>
        </div>
        <div className="stack-cols" data-density={stack.days.length > 62 ? "dense" : stack.days.length > 31 ? "tight" : undefined}>
          <i className="stack-grid stack-grid-top" aria-hidden="true" />
          <i className="stack-grid stack-grid-mid" aria-hidden="true" />
          <i className="stack-grid stack-grid-base" aria-hidden="true" />
          {stack.days.map((day) => {
            const top = day.segments.reduce((last, count, index) => (count > 0 ? index : last), -1);
            const parts = stack.series
              .map((series, index) => ({ label: series.label, count: day.segments[index] ?? 0 }))
              .filter((part) => part.count > 0)
              .map((part) => `${part.label} ${part.count.toLocaleString("en-US")}`);
            return (
              <span key={day.date} className="stack-col" data-empty={day.total === 0 ? "true" : undefined}>
                <span className="rail-daybar-tip">
                  {`${weekdayLabel(day.date)} ${day.date} · ${commitCountLabel(day.total)}${parts.length > 1 ? ` · ${parts.join(" · ")}` : ""}`}
                </span>
                <span className="stack-bar" style={{ "--stack-h": `${(day.total / axisMax) * 100}%` } as CSSProperties}>
                  {capLabels && day.total > 0 ? <span className="stack-cap">{day.total.toLocaleString("en-US")}</span> : null}
                  {day.segments.map((count, index) =>
                    count > 0 ? (
                      <span
                        key={stack.series[index]!.key}
                        className="stack-seg"
                        data-series={slotOf(index)}
                        data-top={index === top ? "true" : undefined}
                        style={{ "--stack-n": count } as CSSProperties}
                      />
                    ) : null,
                  )}
                </span>
              </span>
            );
          })}
        </div>
        <div className="rail-days-axis" aria-hidden="true">
          {stack.days.map((day, index) => (
            <i key={day.date}>
              {ticks.has(index) ? (
                <span>
                  {weekdayTicks ? <b>{weekdayLabel(day.date)}</b> : null}
                  {weekdayTicks ? " " : null}
                  {ticks.get(index)}
                </span>
              ) : null}
            </i>
          ))}
        </div>
      </div>
    </div>
  );
}
