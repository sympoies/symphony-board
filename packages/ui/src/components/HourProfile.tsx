import type { ActivityDTO } from "@symphony-board/contract";
import { useMemo, type CSSProperties } from "react";
import { countsByHour } from "../rail-stats.ts";
import { niceAxisMax, rankBarHeight } from "../rank-scale.ts";

// Hour-of-day profile, shared by the Activity rail and the Commits overview.
//
// All 24 bars always render, including empty ones: the silhouette of a working
// day — the overnight trough, the morning ramp — is the information, and
// dropping quiet hours would flatten it into a ranking.
//
// The two pages differ only in what they are counting, so the noun comes in as
// `countLabel` — the same injection CommitsRail already uses for RankChart.
// They also already share the .rail-hours stylesheet rules, so a copy per page
// would be two things that must be changed together and only look independent.
export function HourProfile({
  rows,
  timezone,
  countLabel,
}: {
  rows: ActivityDTO[];
  timezone: string;
  countLabel: (count: number) => string;
}) {
  const hours = useMemo(() => countsByHour(rows, timezone), [rows, timezone]);
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
        aria-label={`By hour of day; busiest hour ${formatHour(peak.hour)} with ${countLabel(peak.count)}`}
      >
        {hours.map((h) => (
          <span
            key={h.hour}
            className="rail-hourbar"
            style={{ "--rank-h": rankBarHeight(h.count, axisMax) } as CSSProperties}
            data-empty={h.count === 0 ? "true" : undefined}
          >
            <span className="rail-daybar-tip">{`${formatHour(h.hour)} · ${countLabel(h.count)}`}</span>
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

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
