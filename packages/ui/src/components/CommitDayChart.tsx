import { RankEntityLabel } from "./ExternalLink.tsx";
import { actorDestinations, type EntityDestination } from "../entity-links.ts";
import { EMPTY_ACTOR_INDEX } from "../rail-stats.ts";
import type { ActivityDTO } from "@symphony-board/contract";
import { memo, useMemo, useState, type CSSProperties } from "react";
import { commitIsMerge, commitMessage, commitOnDefaultBranch } from "../model.ts";
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

// Commits per day for the pane tiers: the same days the plain strip draws,
// split by what the work WAS.
//
// The plain strip answers "how many" and nothing else, and on a wide panel its
// only way to use the room it was given was to draw the same seven numbers
// bigger. This keeps the plot at a designed height and spends the room on a
// second variable instead: each bar is stacked by commit type, by repository or
// by author, so a tall day also says whether it was a release, one repo, or one
// person -- or by how it landed: on the default branch or a side branch, as a
// merge or a plain commit.
//
// Four series and a fold, because the theme has four series hues and because a
// reader cannot hold more than that in a legend. The fold is a real series: a
// day's segments always add up to its total.

type StackBy = "type" | "repo" | "author" | "branch" | "merge";

const STACK_BY: readonly StackBy[] = ["type", "repo", "author", "branch", "merge"];
const STACK_SERIES_LIMIT = 4;
// Past this many days a total on every bar collides with its neighbours.
const CAP_LABEL_DAYS_MAX = 14;
// Past this many a weekday prefix no longer fits beside the date.
const WEEKDAY_TICK_DAYS_MAX = 10;

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
  if (by === "branch") {
    // Landed or still in flight. A row that names no default branch is neither,
    // and goes to the fold rather than being filed under "side branch".
    return (a) => {
      const on = commitOnDefaultBranch(a);
      if (on === null) return { key: STACK_FOLD_KEY, label: STACK_FOLD_KEY };
      return on ? { key: "default", label: "default branch" } : { key: "side", label: "side branch" };
    };
  }
  if (by === "merge") {
    return (a) => (commitIsMerge(a) ? { key: "merge", label: "merge" } : { key: "commit", label: "commit" });
  }
  return (a) => {
    const type = commitTypeOf(commitMessage(a));
    return { key: type, label: type };
  };
}

// Memoized: its props are the rows, the zone, the range and the actor index,
// none of which changes when a commit is selected -- and selection is the
// re-render this pane sees most. Without the boundary each one rebuilt every
// column and re-formatted every hover tip.
export const CommitDayChart = memo(function CommitDayChart({
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
  const options = useMemo(() => STACK_BY.map((by) => ({ id: by, keyOf: keyOfBy(by, actorIndex) })), [actorIndex]);
  return <StackedDayChart rows={commits} timezone={timezone} range={range} title="Commits per day" noun="commit" options={options} />;
});

// One way to split the per-day bars: an id for the switch, and the series a
// row belongs to under it.
export type StackOption = { id: string; keyOf: (a: ActivityDTO) => { key: string; label: string } };

// The per-day stacked chart, for any rows: the Commits page splits commits by
// type, repo, author, branch or merge; the Activity page splits events by kind,
// action, repo or actor. Same plot, same four series and a fold.
export const StackedDayChart = memo(function StackedDayChart({
  rows,
  timezone,
  range,
  title,
  noun,
  options,
}: {
  rows: ActivityDTO[];
  timezone: string;
  range: TimeRange;
  title: string;
  // Singular, for the counts: "commit" -> "3 commits".
  noun: string;
  options: readonly StackOption[];
}) {
  const [byId, setBy] = useState<string>(options[0]?.id ?? "");
  const option = options.find((o) => o.id === byId) ?? options[0];
  const by = option?.id ?? "";
  const countLabel = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? noun : `${noun}s`}`;
  const stack = useMemo(
    () => (option ? stackedDays(rows, timezone, range.from, range.to, option.keyOf, STACK_SERIES_LIMIT) : { days: [], series: [], max: 0 }),
    [rows, timezone, range.from, range.to, option],
  );
  const total = stack.days.reduce((sum, day) => sum + day.total, 0);
  const axisMax = niceAxisMax(Math.max(1, stack.max));
  const capLabels = stack.days.length <= CAP_LABEL_DAYS_MAX;
  const weekdayTicks = stack.days.length <= WEEKDAY_TICK_DAYS_MAX;
  const destinationIndex = useMemo(() => {
    const groups = new Map<string, Map<string, EntityDestination>>();
    for (const row of rows) {
      const key = option?.keyOf(row).key;
      if (!key || key === STACK_FOLD_KEY) continue;
      const candidates: EntityDestination[] = by === "repo" && row.project_path
        ? [{ sourceId: row.source_id, label: `${row.project_path} · ${row.source_id}`, entity: { kind: "repo", projectPath: row.project_path } }]
        : by === "actor" || by === "author" ? actorDestinations([row], row.actor ?? "", EMPTY_ACTOR_INDEX) : [];
      const group = groups.get(key) ?? new Map<string, EntityDestination>();
      for (const candidate of candidates) group.set(`${candidate.sourceId}|${candidate.label}|${candidate.entity.url ?? ""}`, candidate);
      groups.set(key, group);
    }
    return new Map([...groups].map(([key, group]) => [key, [...group.values()]]));
  }, [rows, option, by]);
  if (stack.days.length === 0) return null;
  const destinations = (key: string): EntityDestination[] => destinationIndex.get(key) ?? [];
  const ticks = new Map(dayAxisTicks(stack.days).map((tick) => [tick.index, tick.label]));
  // The slot a series paints with. The fold is always the neutral one, whatever
  // its rank, so "everything else" never borrows a hue that reads as a name.
  const slotOf = (index: number) => (stack.series[index]?.key === STACK_FOLD_KEY ? "fold" : String(index));

  return (
    <div className="rail-block pane-span commit-day-chart">
      <div className="rail-block-head">
        <span className="rail-block-title">{title}</span>
        <span className="pane-seg" role="group" aria-label={`Split ${title.toLowerCase()} by`}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="pane-seg-option"
              aria-pressed={by === o.id}
              onClick={() => setBy(o.id)}
            >
              {o.id}
            </button>
          ))}
        </span>
        <span className="rail-block-meta">
          {total > 0 ? `peak ${stack.max.toLocaleString("en-US")} · ${countLabel(total)}` : countLabel(total)}
        </span>
      </div>

      <ul className="stack-legend" aria-label={`${title} by ${by}`}>
        {stack.series.map((series, index) => (
          <li key={series.key} className="stack-legend-item">
            <span className="stack-swatch" data-series={slotOf(index)} aria-hidden="true" />
            <RankEntityLabel label={series.label} entities={destinations(series.key)} />
            <small>{series.count.toLocaleString("en-US")}</small>
          </li>
        ))}
      </ul>

      <div
        className="stack-plot"
        role="group"
        aria-label={`${title} by ${by}, ${range.from} to ${range.to}: ${countLabel(total)}, busiest day ${stack.max.toLocaleString("en-US")}`}
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
              .map((series, index) => ({ key: series.key, label: series.label, count: day.segments[index] ?? 0 }))
              .filter((part) => part.count > 0);
            return (
              <span key={day.date} tabIndex={0} className="stack-col" data-empty={day.total === 0 ? "true" : undefined}>
                <span className="rail-daybar-tip">
                  {`${weekdayLabel(day.date)} ${day.date} · ${countLabel(day.total)}`}
                  {parts.length > 1 ? parts.map(part => <span key={part.key}> · <RankEntityLabel label={part.label} entities={destinations(part.key)} /> {part.count.toLocaleString("en-US")}</span>) : null}
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
});
