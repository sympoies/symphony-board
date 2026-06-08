import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ActivityDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import {
  ACTIVITY_WINDOW_PRESETS,
  relativeTime,
  type ActivityWindowKey,
  type ColorOf,
} from "../model.ts";

const ACTION_KIND: Record<string, string> = {
  opened: "open",
  closed: "closed",
  merged: "merged",
  committed: "status-ok",
  pushed: "lifecycle-declared",
  force_pushed: "lifecycle-broken",
  created: "status-ok",
  deleted: "status-error",
  commented: "status-partial",
  reopened: "open",
};

function activityTitle(a: ActivityDTO): string {
  return a.summary ?? a.title ?? `${a.action} ${a.kind}`;
}

const PAGE_SIZE = 300;

export function ActivityPage({
  activities,
  windowTotal,
  totalActivities,
  activityWindow,
  onActivityWindow,
  sourceKind,
  colorOf,
}: {
  activities: ActivityDTO[];
  windowTotal: number;
  totalActivities: number;
  activityWindow: ActivityWindowKey;
  onActivityWindow: (window: ActivityWindowKey) => void;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [activities, activityWindow]);

  const visibleActivities = useMemo(() => activities.slice(0, limit), [activities, limit]);
  const hidden = activities.length - visibleActivities.length;
  const countLabel =
    activities.length === windowTotal
      ? `${activities.length} in range`
      : `${activities.length} matches`;

  return (
    <main className="activity-page">
      <div className="activity-head">
        <h2>Activity</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          {windowTotal} window / {totalActivities} total
        </span>
      </div>
      <div className="activity-controls">
        <div className="toggle-group">
          <span className="toggle-label">range</span>
          {ACTIVITY_WINDOW_PRESETS.map(([label, key]) => (
            <button
              key={key}
              type="button"
              className={`toggle${activityWindow === key ? " toggle-on" : ""}`}
              onClick={() => onActivityWindow(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {activities.length === 0 ? (
        <p className="empty">{windowTotal === 0 ? "No activity in this range." : "No activity matches the current filters."}</p>
      ) : (
        <>
          <div className="activity-list">
            {visibleActivities.map((a) => {
              const accentColor = colorOf(a.source_id, a.project_path);
              const title = activityTitle(a);
              return (
                <article
                  key={a.id}
                  className={`activity-row${accentColor ? " card-accent" : ""}`}
                  style={accentColor ? ({ "--repo-color": accentColor } as CSSProperties) : undefined}
                >
                  <div className="activity-main">
                    <div className="activity-title-row">
                      <Badge text={a.action} kind={ACTION_KIND[a.action] ?? "status-unknown"} />
                      {a.url ? (
                        <a className="activity-title" href={a.url} target="_blank" rel="noopener noreferrer">
                          {title}
                        </a>
                      ) : (
                        <span className="activity-title">{title}</span>
                      )}
                    </div>
                    <div className="activity-meta">
                      <SourceIcon kind={sourceKind.get(a.source_id)} />
                      {a.project_path ? <span>{a.project_path}</span> : null}
                      <span>{a.kind}</span>
                      {a.target_iid != null ? <span>#{a.target_iid}</span> : null}
                      {a.actor ? <span>@{a.actor}</span> : null}
                    </div>
                  </div>
                  <time className="activity-time" title={a.occurred_at}>
                    {relativeTime(a.occurred_at)}
                  </time>
                </article>
              );
            })}
          </div>
          {hidden > 0 ? (
            <div className="activity-more">
              <span className="muted">
                {visibleActivities.length} shown / {activities.length} matches
              </span>
              <button type="button" className="toggle" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                Show more
              </button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
