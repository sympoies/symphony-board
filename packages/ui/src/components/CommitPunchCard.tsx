import type { ActivityDTO } from "@symphony-board/contract";
import { Fragment, memo, useMemo, useState, type CSSProperties } from "react";
import type { TimeRange } from "../model.ts";
import { punchCard } from "../rail-stats.ts";
import { formatHour } from "./HourProfile.tsx";
import type { HeatmapTip } from "./HeatmapCalendar.tsx";

// "When", for the pane tiers: commits by day AND hour.
//
// The hour strip this replaces folds every day of the range onto one row of 24
// bars, which says what time of day work lands and hides which days it landed
// on. On a wide panel the only thing that strip could do with more room was
// grow taller. A grid spends the same room on the second axis: one row per day
// (or per weekday, once the range is too long for a row each), so an evening
// push on Tuesday reads as one dark cell rather than as a slightly taller
// 21:00 bar.
//
// Five intensity steps on the accent hue, the same ramp the rhythm calendar
// uses for the selected range, so the two read as one family.

const HOUR_TICKS = new Set([0, 6, 12, 18, 23]);

// 0 for an empty hour, then four steps by share of the busiest cell.
function levelOf(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

// Memoized for the same reason as the other wide panes: nothing it draws
// depends on which commit is selected.
export const CommitPunchCard = memo(function CommitPunchCard({
  commits,
  timezone,
  range,
  noun = "commit",
}: {
  // Any rows: the Activity page draws its events with the same grid.
  commits: ActivityDTO[];
  timezone: string;
  range: TimeRange;
  // Singular, for the counts and labels.
  noun?: string;
}) {
  const plural = `${noun}s`;
  const commitCountLabel = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? noun : plural}`;
  const Plural = plural.charAt(0).toUpperCase() + plural.slice(1);
  const card = useMemo(() => punchCard(commits, timezone, range.from, range.to), [commits, timezone, range.from, range.to]);
  const [tip, setTip] = useState<HeatmapTip | null>(null);
  if (card.rows.length === 0) return null;

  const peak = card.peak;
  // A per-day row is named by its weekday and day of month ("Thu 24"): two
  // Thursdays can share a fortnight, and the month is the range's.
  const rowLabel = (key: string, weekday: string) => (card.byWeekday ? weekday : `${weekday} ${Number(key.slice(8))}`);

  return (
    <div className="rail-block commit-punch">
      <div className="rail-block-head">
        <span className="rail-block-title">When</span>
        <span className="rail-block-meta">
          {peak ? `peak ${rowLabel(peak.key, peak.weekday)} ${formatHour(peak.hour)} · ${commitCountLabel(peak.count)}` : `no ${plural} in range`}
        </span>
      </div>
      <div
        className="punch-grid"
        role="img"
        aria-label={
          peak
            ? `${Plural} by ${card.byWeekday ? "weekday" : "day"} and hour; busiest ${rowLabel(peak.key, peak.weekday)} at ${formatHour(peak.hour)} with ${commitCountLabel(peak.count)}`
            : `${Plural} by day and hour; none in range`
        }
        onMouseLeave={() => setTip(null)}
      >
        {card.rows.map((row) => (
          <Fragment key={row.key}>
            <span className="punch-row-label">{rowLabel(row.key, row.weekday)}</span>
            {row.hours.map((count, hour) => {
              const label = `${rowLabel(row.key, row.weekday)} ${formatHour(hour)} · ${commitCountLabel(count)}`;
              return (
                <span
                  key={hour}
                  className="punch-cell"
                  data-level={levelOf(count, card.max)}
                  onMouseEnter={(e) => setTip({ label, x: e.clientX, y: e.clientY })}
                  onMouseMove={(e) => setTip({ label, x: e.clientX, y: e.clientY })}
                />
              );
            })}
            <span className="punch-row-total">{row.total.toLocaleString("en-US")}</span>
          </Fragment>
        ))}
        <span aria-hidden="true" />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="punch-hour" aria-hidden="true">
            {HOUR_TICKS.has(hour) ? String(hour).padStart(2, "0") : ""}
          </span>
        ))}
        <span aria-hidden="true" />
      </div>
      {tip ? (
        <div className="hm-tip" role="status" style={{ left: tip.x, top: tip.y } as CSSProperties}>
          {tip.label}
        </div>
      ) : null}
    </div>
  );
});
