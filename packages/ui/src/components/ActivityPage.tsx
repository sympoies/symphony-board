import type { ActivityDTO, ItemDTO } from "@symphony-board/contract";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ActivityHeatmap } from "./ActivityHeatmap.tsx";
import type { ColorOf, TimeRange } from "../model.ts";

export function ActivityPage({
  activities,
  allActivities,
  windowTotal,
  totalActivities,
  range,
  timezone,
  sourceKind,
  colorOf,
  itemsById,
  emptyState,
}: {
  activities: ActivityDTO[];
  // The full, range-independent activity set powering the trailing-12-month
  // heatmap; `activities` above is the range-filtered feed.
  allActivities: ActivityDTO[];
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
}) {
  const [heatmapPanel, setHeatmapPanel] = useState<HTMLElement | null>(null);
  const [heatmapHeight, setHeatmapHeight] = useState(0);
  const heatmapPanelRef = useCallback((node: HTMLElement | null) => setHeatmapPanel(node), []);
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
      <div className="activity-layout" style={layoutStyle}>
        <ActivityFeed activities={activities} sourceKind={sourceKind} colorOf={colorOf} empty={emptyState} itemsById={itemsById} />
        <ActivityHeatmap
          activities={allActivities}
          trendActivities={activities}
          timezone={timezone}
          range={range}
          panelRef={heatmapPanelRef}
        />
      </div>
    </main>
  );
}
