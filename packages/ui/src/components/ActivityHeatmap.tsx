import { useMemo, useState, type CSSProperties } from "react";
import type { ActivityDTO } from "@symphony-board/contract";
import { buildActivityHeatmap, type TimeRange } from "../model.ts";

// The 12-month strip is split into BLOCKS stacked horizontal sub-grids (weeks as
// columns left→right, days as rows). Splitting the year keeps the calendar wider
// and shorter than one long row or one tall column, so it fills the sidebar rail.
// GitHub labels only the odd weekday rows so the column stays legible.
const WEEKDAY_LABELS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };
const BLOCKS = 2;
const LEVELS = [0, 1, 2, 3, 4] as const;

// One cell's hover label. A custom tooltip renders this instead of the native
// `title` attribute — `title` only appears after a dwell, dismisses on its own,
// and is easy to miss on 12px cells, so it felt all-or-nothing.
const cellTip = (cell: { date: string; count: number }) =>
  `${cell.date} · ${cell.count.toLocaleString()} ${cell.count === 1 ? "event" : "events"}`;

// A trailing-12-month activity calendar that fills the empty rail beside the
// Activity feed. Read-only: density comes purely from `occurred_at` over a fixed
// window, so the long-term rhythm stays put while filtering. The feed's selected
// range only tints the matching cells (a visual overlay) — it never reshapes the
// underlying data, so the rhythm stays comparable across different ranges.
export function ActivityHeatmap({
  activities,
  timezone,
  range,
}: {
  activities: ActivityDTO[];
  timezone: string;
  range: TimeRange;
}) {
  const hm = useMemo(() => buildActivityHeatmap(activities, Date.now(), timezone), [activities, timezone]);
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);

  if (hm.total === 0) return null;

  // Tint the cells inside the feed's selected range a distinct blue, layered over
  // the green density ramp, so the range picker and this overview read as linked.
  // `range.from`/`range.to` and `cell.date` are all fixed-width YYYY-MM-DD in the
  // contract timezone, so a plain string compare is a calendar-date compare. Only
  // the overlap with the rendered window lights up; a range fully outside it tints
  // nothing (its cells were never rendered) — no error, no out-of-range invention.
  const hasRange = Boolean(range.from) && Boolean(range.to) && range.from <= range.to;
  const inSelectedRange = (date: string) => hasRange && date >= range.from && date <= range.to;

  // Split the weeks into BLOCKS equal stacked sub-grids; re-base each block's
  // month labels to its own first column.
  const perBlock = Math.ceil(hm.weeks.length / BLOCKS);
  const blocks = Array.from({ length: BLOCKS }, (_, b) => {
    const start = b * perBlock;
    return {
      weeks: hm.weeks.slice(start, start + perBlock),
      months: hm.monthLabels
        .filter((m) => m.col >= start && m.col < start + perBlock)
        .map((m) => ({ col: m.col - start, label: m.label })),
    };
  }).filter((block) => block.weeks.length > 0);

  return (
    <aside className="activity-heatmap" aria-label="Activity over the last 12 months">
      <div className="hm-head">
        <h3>Activity rhythm</h3>
        <span className="muted">last 12 months</span>
        <span className="hm-total">{hm.total.toLocaleString()} events</span>
      </div>

      <div
        className="hm-calendar"
        role="img"
        aria-label={`Daily activity from ${hm.from} to ${hm.to}`}
        onMouseLeave={() => setTip(null)}
      >
        {blocks.map((block, bi) => (
          <div className="hm-block" key={bi}>
            <div className="hm-months" aria-hidden="true">
              {block.months.map((m) => (
                <span key={`${m.col}-${m.label}`} style={{ "--hm-col": m.col } as CSSProperties}>
                  {m.label}
                </span>
              ))}
            </div>
            <div className="hm-body">
              <div className="hm-weekdays" aria-hidden="true">
                {Array.from({ length: 7 }, (_, row) => (
                  <span key={row}>{WEEKDAY_LABELS[row] ?? ""}</span>
                ))}
              </div>
              <div className="hm-grid">
                {block.weeks.map((week, col) => (
                  <div className="hm-col" key={col}>
                    {week.map((cell, row) =>
                      cell ? (
                        <div
                          key={cell.date}
                          className="hm-cell"
                          data-level={cell.level}
                          data-in-range={inSelectedRange(cell.date) || undefined}
                          onMouseEnter={(e) => setTip({ label: cellTip(cell), x: e.clientX, y: e.clientY })}
                          onMouseMove={(e) => setTip({ label: cellTip(cell), x: e.clientX, y: e.clientY })}
                        />
                      ) : (
                        <div key={`empty-${bi}-${col}-${row}`} className="hm-cell hm-cell-empty" />
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
        <div className="hm-legend">
          <span>Less</span>
          {LEVELS.map((level) => (
            <span key={level} className="hm-cell" data-level={level} />
          ))}
          <span>More</span>
        </div>
      </div>

      <dl className="hm-stats">
        {hm.busiest ? (
          <div>
            <dt>Busiest day</dt>
            <dd>
              {hm.busiest.date} · {hm.busiest.count.toLocaleString()}
            </dd>
          </div>
        ) : null}
        {hm.byKind.slice(0, 5).map((k) => (
          <div key={k.kind}>
            <dt>{k.kind.replace(/_/g, " ")}</dt>
            <dd>{k.count.toLocaleString()}</dd>
          </div>
        ))}
      </dl>

      {tip ? (
        <div className="hm-tip" role="status" style={{ left: tip.x, top: tip.y } as CSSProperties}>
          {tip.label}
        </div>
      ) : null}
    </aside>
  );
}
