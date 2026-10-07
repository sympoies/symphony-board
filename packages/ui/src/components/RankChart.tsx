import type { CSSProperties, ReactNode } from "react";
import { formatAxisValue, labelClipped, labelShortened, nameTipText, niceAxisMax, rankBarHeight, showsNameTip } from "../rank-scale.ts";

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
  nameTip?: ReactNode;
  // Facts drawn beside the bar where the chart is laid out as rows with room
  // for them (the Commits wide-panes tier). Hidden everywhere else by the
  // stylesheet, so a caller can pass it without knowing the layout.
  extra?: ReactNode;
  // The same facts in words, appended to the row's accessible name: the
  // `extra` cells are presentation, and a bare "91%" or "7/7" means nothing
  // read aloud without its column header.
  detail?: string;
  // Set when the row drives a filter. A selectable row gains a real <button>
  // inside its listitem, so it is reachable by keyboard and announced as a
  // pressable action rather than as plain list content.
  onSelect?: () => void;
  selected?: boolean;
};

// Decides a row's name tip when it is hovered or focused, not when it renders:
// whether the label clips depends on the layout the stylesheet chose for this
// width. Written to the row directly, so a hover costs no React render.
//
// In a row layout the tip sits over its own row, starting at the name, so it
// reads as the name continued and never covers the row beside it; the two
// custom properties place it there. The vertical-bar layout ignores them.
function armNameTip(row: HTMLElement, label: string, selectable: boolean) {
  const footer = row.querySelector<HTMLElement>(".live-rank-footer");
  const shown = footer?.querySelector<HTMLElement>(".live-rank-name, .activity-rank-actor-name");
  const name = shown && shown.getClientRects().length > 0 ? shown : null;
  const clipped = labelClipped(name) || (name !== null && labelShortened(name.textContent ?? "", label));
  row.dataset.nameTip = showsNameTip({ clipped, selectable }) ? "show" : "none";
  if (!footer) return;
  const tip = footer.querySelector<HTMLElement>(".rank-name-tip");
  if (tip) {
    // Clear the previous focus's override before measuring again, so a row that
    // moved since its last focus gets positioned for its current place.
    tip.style.top = "";
    tip.style.bottom = "";
    const viewportBottom = document.documentElement.clientHeight - 8;
    const tipRect = tip.getBoundingClientRect();
    // CSS tips usually open below their footer. Flip only when that placement
    // would cross the bottom gutter.
    if (tipRect.bottom > viewportBottom) {
      tip.style.top = "auto";
      tip.style.bottom = "calc(100% + 6px)";
    }
  }
  if (!name) return;
  const nameLeft = name.getBoundingClientRect().left;
  row.style.setProperty("--tip-x", `${Math.round(nameLeft - footer.getBoundingClientRect().left)}px`);
  row.style.setProperty("--tip-max", `${Math.max(0, Math.round(row.getBoundingClientRect().right - nameLeft))}px`);
}

export function RankChart({
  items,
  empty,
  ariaLabel,
  className = "",
  // How a count reads to a screen reader: "412 commits", "8,188 events".
  countLabel,
  // What a full-length bar stands for. "axis" rounds the largest count up to a
  // 1 / 2 / 5 step, which is right while the chart draws that axis beside its
  // bars. A row layout draws no axis, so there the rounding only shortens
  // every bar for nothing -- 2,049 against a 5,000 ceiling leaves the leading
  // row at 41% of its track -- and "max" lets the leader fill it.
  scale = "axis",
}: {
  items: RankChartItem[];
  empty: string;
  ariaLabel: string;
  className?: string;
  countLabel: (count: number) => string;
  scale?: "axis" | "max";
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
          const label = `${item.label} · ${countLabel(item.count)}${item.detail ? ` · ${item.detail}` : ""}`;
          const selectable = item.onSelect !== undefined;
          const arm = (event: { currentTarget: HTMLElement }) => armNameTip(event.currentTarget, item.label, selectable);
          const bar = (
            <>
              <span
                className="live-rank-bar-cell"
                style={{ "--rank-h": rankBarHeight(item.count, scale === "max" ? max : axisMax) } as CSSProperties}
                aria-hidden="true"
              >
                <span className="live-rank-tooltip">{item.count.toLocaleString("en-US")}</span>
                <span className="live-rank-bar" />
              </span>
              {item.extra ? (
                <span className="live-rank-extra" aria-hidden="true">
                  {item.extra}
                </span>
              ) : null}
              {/* The footer is clipped to one line, so the full value lives on
                  hover — as a CSS tip rather than a native `title`, which waits
                  about a second, dismisses on the smallest pointer move, and will
                  not re-arm until the pointer leaves and comes back. It shows
                  only when it adds something (see armNameTip). */}
              <span className="live-rank-footer">
                {item.footer}
                <span className="rank-name-tip">
                  {item.nameTip ?? nameTipText(item.label, { selectable, selected: item.selected === true })}
                </span>
              </span>
            </>
          );
          // Read-only rows keep the original listitem markup verbatim so the Live
          // tab renders exactly as before.
          if (!item.onSelect) {
            return (
              <div key={item.key} className="live-rank-item" role="listitem" tabIndex={0} aria-label={label} onPointerEnter={arm} onFocus={arm}>
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
              <div className={`live-rank-item${item.selected ? " live-rank-item-on" : ""}`} onPointerEnter={arm} onFocus={arm}>
                <button type="button" className={`live-rank-item-action rank-filter-hit${item.selected ? " live-rank-item-on" : ""}`}
                  aria-label={label} aria-pressed={item.selected === true} onClick={item.onSelect} />
                {bar}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
