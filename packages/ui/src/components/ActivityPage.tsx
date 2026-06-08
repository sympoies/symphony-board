import type { ActivityDTO } from "@symphony-board/contract";
import { ActivityFeed } from "./ActivityFeed.tsx";
import type { ColorOf, TimeRange } from "../model.ts";

export function ActivityPage({
  activities,
  windowTotal,
  totalActivities,
  range,
  sourceKind,
  colorOf,
}: {
  activities: ActivityDTO[];
  windowTotal: number;
  totalActivities: number;
  range: TimeRange;
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
      <ActivityFeed activities={activities} sourceKind={sourceKind} colorOf={colorOf} emptyMessage={emptyMessage} />
    </main>
  );
}
