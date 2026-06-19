import type { ActivityDTO, ActivityDailyDTO, ItemDTO } from "@symphony-board/contract";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ActivityHeatmap } from "./ActivityHeatmap.tsx";
import { MOBILE_VIEWPORT_QUERY, type ColorOf, type TimeRange } from "../model.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import type { ActivityView } from "../nav.ts";

export function ActivityPage({
  activities,
  allActivities,
  activityDaily,
  generatedAt,
  windowTotal,
  totalActivities,
  range,
  timezone,
  sourceKind,
  colorOf,
  itemsById,
  emptyState,
  view,
  onView,
}: {
  activities: ActivityDTO[];
  // Raw fallback for the trailing-12-month heatmap when `activityDaily` is
  // absent (pre-4.0.0 contract); `activities` above is the range-filtered feed.
  allActivities: ActivityDTO[];
  // Pre-computed per-day/per-kind counts (4.0.0+) powering the trailing-12-month
  // heatmap, since the static `activities[]` is now windowed to 30 days.
  activityDaily: ActivityDailyDTO | null;
  // Contract emit instant — the heatmap's anchor (not the UI clock).
  generatedAt: string;
  windowTotal: number;
  totalActivities: number;
  range: TimeRange;
  timezone: string;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  // Item index by ref; passed to the feed so review rows can show their target
  // change_request's open-thread count.
  itemsById?: ReadonlyMap<string, ItemDTO>;
  // Shared empty-state node, rendered in place of the feed when nothing matches.
  emptyState?: ReactNode;
  // Mobile sub-view selection (route-backed). On narrow viewports the page shows
  // ONE of the two panes, chosen here; on wide viewports both render and this is
  // ignored.
  view: ActivityView;
  onView: (view: ActivityView) => void;
}) {
  const [heatmapPanel, setHeatmapPanel] = useState<HTMLElement | null>(null);
  const [heatmapHeight, setHeatmapHeight] = useState(0);
  const heatmapPanelRef = useCallback((node: HTMLElement | null) => setHeatmapPanel(node), []);
  // Below the breakpoint the feed and the overview compete for one narrow column,
  // and the feed's own inner scroll makes the overview hard to reach — so we show
  // just one at a time, defaulting to the feed (latest records). Above it, both
  // render side by side as before and `view` is moot.
  const isMobile = useMediaQuery(MOBILE_VIEWPORT_QUERY);
  const showFeed = !isMobile || view === "feed";
  const showOverview = !isMobile || view === "overview";
  // On a phone showing ONLY the Overview pane, the feed (which renders emptyState
  // when nothing matches) is unmounted, and ActivityHeatmap returns null when its
  // trailing-window total is zero — so an activity-less board would show just the
  // header and a blank body. Surface the shared empty state in the overview slot
  // instead. (When the feed is also shown — desktop, or the Feed sub-view — the
  // feed already owns the empty state, so this never double-renders it.)
  // "Empty overview" means no trailing-12-month activity to chart: with the
  // aggregate present that is its total; otherwise fall back to the raw set.
  const overviewIsEmpty = activityDaily ? activityDaily.total === 0 : allActivities.length === 0;
  const overviewOnlyEmpty = showOverview && !showFeed && overviewIsEmpty;
  const countLabel =
    activities.length === windowTotal
      ? `${activities.length} in range`
      : `${activities.length} matches`;
  const layoutStyle =
    heatmapHeight > 0
      ? ({
          "--activity-rhythm-height": `${heatmapHeight}px`,
        } as CSSProperties)
      : undefined;

  useEffect(() => {
    if (!heatmapPanel) {
      setHeatmapHeight(0);
      return;
    }

    const measure = () => setHeatmapHeight(Math.ceil(heatmapPanel.getBoundingClientRect().height));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(heatmapPanel);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [heatmapPanel]);

  return (
    <main className="activity-page">
      <div className="activity-head">
        <h2>Activity</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          {windowTotal} window / {totalActivities} total · {range.from} to {range.to}
        </span>
      </div>
      {isMobile ? <ActivityViewToggle view={view} onView={onView} /> : null}
      <div className="activity-layout" style={layoutStyle}>
        {showFeed ? (
          <ActivityFeed activities={activities} sourceKind={sourceKind} colorOf={colorOf} empty={emptyState} itemsById={itemsById} />
        ) : null}
        {showOverview ? (
          overviewOnlyEmpty ? (
            (emptyState ?? null)
          ) : (
            <ActivityHeatmap
              activities={allActivities}
              activityDaily={activityDaily}
              generatedAt={generatedAt}
              trendActivities={activities}
              timezone={timezone}
              range={range}
              panelRef={heatmapPanelRef}
            />
          )
        ) : null}
      </div>
    </main>
  );
}

// Mobile-only segmented control choosing which single pane the Activity page
// shows. Mirrors the Settings sub-tab pattern (role=tablist + selected button)
// so the chrome reads as the same family of control.
function ActivityViewToggle({ view, onView }: { view: ActivityView; onView: (view: ActivityView) => void }) {
  return (
    <nav className="activity-view-toggle" role="tablist" aria-label="Activity view">
      {(["feed", "overview"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          className={`activity-view-tab${view === v ? " activity-view-tab-active" : ""}`}
          onClick={() => onView(v)}
        >
          {v === "feed" ? "Feed" : "Overview"}
        </button>
      ))}
    </nav>
  );
}
