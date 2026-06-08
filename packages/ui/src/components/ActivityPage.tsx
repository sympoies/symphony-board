import type { ActivityDTO } from "@symphony-board/contract";
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
}) {
  const countLabel =
    activities.length === windowTotal
      ? `${activities.length} in range`
      : `${activities.length} matches`;
  const emptyMessage =
    windowTotal === 0 ? "No activity in this range." : "No activity matches the current filters.";

  return (
    <main className="activity-page">
      <div className="activity-head">
        <h2>Activity</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          {windowTotal} window / {totalActivities} total · {range.from} to {range.to}
        </span>
      </div>
      <div className="activity-layout">
        <ActivityFeed activities={activities} sourceKind={sourceKind} colorOf={colorOf} emptyMessage={emptyMessage} />
        <ActivityHeatmap activities={allActivities} timezone={timezone} />
      </div>
    </main>
  );
}
