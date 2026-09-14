import { type CSSProperties } from "react";
import type { ActivityHeatmap, HeatmapCell } from "../model.ts";

const WEEKDAY_LABELS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };
const LEVELS = [0, 1, 2, 3, 4] as const;

export type HeatmapTip = { label: string; x: number; y: number };

// The trailing-12-month calendar grid, shared by the Activity overview and the
// Commits overview.
//
// Extracted rather than copied: the two pages chart different things but draw
// the same figure, down to the `.hm-*` rules the stylesheet already applies to
// both, so a copy would be two things that must change together while looking
// independent. What differs between them is the noun in each cell's tooltip and
// the aria-label, which arrive as props.
//
// The scroll container is the caller's, because only the caller knows when the
// data it is built from changed and the view should jump back to the latest
// week.
export function HeatmapCalendar({
  heatmap,
  label,
  cellTip,
  inSelectedRange,
  onTip,
}: {
  heatmap: ActivityHeatmap;
  // Describes the whole figure for a screen reader, e.g. "Daily commits from x to y".
  label: string;
  cellTip: (cell: HeatmapCell) => string;
  // Marks the cells inside the page's selected range; the Commits overview and
  // the Activity overview both dim everything outside it.
  inSelectedRange: (date: string) => boolean;
  onTip: (tip: HeatmapTip | null) => void;
}) {
  return (
    <div className="hm-calendar" role="img" aria-label={label} onMouseLeave={() => onTip(null)}>
      <div className="hm-months" aria-hidden="true">
        {heatmap.monthLabels.map((m) => (
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
          {heatmap.weeks.map((week, col) => (
            <div className="hm-col" key={col}>
              {week.map((cell, row) =>
                cell ? (
                  <div
                    key={cell.date}
                    className="hm-cell"
                    data-level={cell.level}
                    data-in-range={inSelectedRange(cell.date) || undefined}
                    onMouseEnter={(e) => onTip({ label: cellTip(cell), x: e.clientX, y: e.clientY })}
                    onMouseMove={(e) => onTip({ label: cellTip(cell), x: e.clientX, y: e.clientY })}
                  />
                ) : (
                  <div key={`empty-${col}-${row}`} className="hm-cell hm-cell-empty" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="hm-legend">
        <span>Less</span>
        {LEVELS.map((level) => (
          <span key={level} className="hm-cell" data-level={level} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
