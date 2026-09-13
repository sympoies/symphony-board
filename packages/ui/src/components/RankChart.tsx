import type { CSSProperties, ReactNode } from "react";
import { formatAxisValue, niceAxisMax, rankBarHeight } from "../rank-scale.ts";

// The ranked-bar chart shared by the Live pulse cards and the Commits / Activity
// rails: a handful of bars on a two-gridline axis, each with a footer slot for an
// avatar or a label.
//
// The class names stay `live-rank-*` even though this is no longer Live-only.
// They are the established rank-chart family in styles.css (34 rules) and in the
// render smoke (12 assertions); renaming them would churn all of that for no
// visible change. The prefix is historical, not a scope claim.
export type RankChartItem = {
  key: string;
  label: string;
  count: number;
  footer: ReactNode;
  // Set when the row drives a filter. A selectable row gains a real <button>
  // inside its listitem, so it is reachable by keyboard and announced as a
  // pressable action rather than as plain list content.
  onSelect?: () => void;
  selected?: boolean;
};

export function RankChart({
  items,
  empty,
  ariaLabel,
  className = "",
  // How a count reads to a screen reader: "412 commits", "8,188 events".
  countLabel,
}: {
  items: RankChartItem[];
  empty: string;
  ariaLabel: string;
  className?: string;
  countLabel: (count: number) => string;
}) {
  if (items.length === 0) {
    return (
      <div className={`live-rank-chart live-rank-chart-empty ${className}`.trim()}>
        <div className="live-rank-empty">{empty}</div>
      </div>
    );
  }
  const max = Math.max(1, ...items.map((item) => item.count));
  const axisMax = niceAxisMax(max);
  const axisMid = axisMax / 2;
  return (
    <div className={`live-rank-chart ${className}`.trim()}>
      <div className="live-rank-axis" aria-hidden="true">
        <span className="live-rank-axis-top">{formatAxisValue(axisMax)}</span>
        <span className="live-rank-axis-mid">{formatAxisValue(axisMid)}</span>
        <span className="live-rank-axis-bottom">0</span>
      </div>
      <div className="live-rank-plot" role="list" aria-label={ariaLabel}>
        <span className="live-rank-grid live-rank-grid-top" aria-hidden="true" />
        <span className="live-rank-grid live-rank-grid-mid" aria-hidden="true" />
        <span className="live-rank-baseline" aria-hidden="true" />
        {items.map((item) => {
          const label = `${item.label} · ${countLabel(item.count)}`;
          const bar = (
            <>
              <span
                className="live-rank-bar-cell"
                style={{ "--rank-h": rankBarHeight(item.count, axisMax) } as CSSProperties}
                aria-hidden="true"
              >
                <span className="live-rank-tooltip">{item.count.toLocaleString("en-US")}</span>
                <span className="live-rank-bar" />
              </span>
              {/* The footer is clipped to one line, so the full value lives on
                  hover — as a CSS tip rather than a native `title`, which waits
                  about a second, dismisses on the smallest pointer move, and will
                  not re-arm until the pointer leaves and comes back. */}
              <span className="live-rank-footer">
                {item.footer}
                <span className="rank-name-tip" aria-hidden="true">{item.label}</span>
              </span>
            </>
          );
          // Read-only rows keep the original listitem markup verbatim so the Live
          // tab renders exactly as before.
          if (!item.onSelect) {
            return (
              <div key={item.key} className="live-rank-item" role="listitem" tabIndex={0} aria-label={label}>
                {bar}
              </div>
            );
          }
          // The listitem and the button must be SEPARATE elements. An explicit
          // role="listitem" on the <button> would replace its implicit button
          // role, and `aria-pressed` is not a supported attribute of listitem —
          // so the active filter would announce as a plain list entry with no
          // selected state at all.
          return (
            <div key={item.key} className="live-rank-item-slot" role="listitem">
              <button
                type="button"
                className={`live-rank-item live-rank-item-action${item.selected ? " live-rank-item-on" : ""}`}
                aria-label={label}
                aria-pressed={item.selected === true}
                onClick={item.onSelect}
              >
                {bar}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
