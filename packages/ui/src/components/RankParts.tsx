import { memo, type CSSProperties } from "react";
import { COMMITS_PANES_SPARK_BARS } from "../layout-tier.ts";
import { relativeTime } from "../model.ts";
import { sparkBuckets } from "../rail-stats.ts";

// The parts of a ranked row with facts, shared by the Commits and Activity
// rails in the pane tiers.

// A row's share of the visible range, as a whole percent. Under half a percent
// reads "<1%" rather than "0%": the row is there because it counts something.
export function share(count: number, total: number): string {
  if (total <= 0) return "—";
  const pct = Math.round((count / total) * 100);
  return pct === 0 && count > 0 ? "<1%" : `${pct}%`;
}

// An author's commits across the range, as a row of bars. It shares the day
// strip's bar, scaled to the author's own busiest bar: the question a sparkline
// answers is "when", and the count column already says "how many".
//
// A bar per day while the range is short, runs of days summed beyond that (see
// sparkBuckets). Memoized because `perDay` comes out of a memo and is the same
// array across a selection change, which is the re-render this row sees most.
export const Sparkline = memo(function Sparkline({ perDay }: { perDay: readonly number[] }) {
  const bars = sparkBuckets(perDay, COMMITS_PANES_SPARK_BARS);
  const max = Math.max(1, ...bars);
  return (
    <span className="rank-spark">
      {bars.map((count, index) => (
        <i
          key={index}
          data-empty={count === 0 ? "true" : undefined}
          style={{ "--spark-h": `${Math.max(8, (count / max) * 100)}%` } as CSSProperties}
        />
      ))}
    </span>
  );
});

// Names the columns of the rows under it. Laid out on the same tracks as those
// rows (the chart's `rank-cols-*` class sets them for both), so each word sits
// over its own column. Presentation only: every row already carries the same
// facts in words in its accessible name.
export function RankHead({
  cols,
  label,
  extras,
  countLabel = "commits",
}: {
  cols: string;
  label: string;
  extras: readonly { label: string; start?: boolean }[];
  // The count column's name: what the rows count.
  countLabel?: string;
}) {
  return (
    <div className={`rank-head ${cols}`} aria-hidden="true">
      <span className="rank-head-start">{label}</span>
      <span />
      <span>{countLabel}</span>
      {extras.map((extra) => (
        <span key={extra.label} className={extra.start ? "rank-head-start" : undefined}>
          {extra.label}
        </span>
      ))}
    </div>
  );
}

// "3h" for a row's last-commit column: the head says what the column is, so
// the cell does not repeat "ago" on every row.
export function ageLabel(iso: string | null): string {
  const label = relativeTime(iso);
  return label === "just now" ? "now" : label.replace(/ ago$/, "");
}
