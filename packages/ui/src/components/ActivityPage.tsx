import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ActivityDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import {
  ACTIVITY_DEFAULT_VIEWPORT_PX,
  ACTIVITY_ROW_GAP_PX,
  ACTIVITY_ROW_HEIGHT_PX,
  activityDisplay,
  activityVirtualRange,
  relativeTime,
  type ColorOf,
  type TimeRange,
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

const ACTIVITY_ROW_STRIDE_PX = ACTIVITY_ROW_HEIGHT_PX + ACTIVITY_ROW_GAP_PX;

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
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(ACTIVITY_DEFAULT_VIEWPORT_PX);

  const resetScroll = useCallback(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  useEffect(() => {
    resetScroll();
  }, [activities, range, resetScroll]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const updateHeight = () => {
      setViewportHeight(el.clientHeight || ACTIVITY_DEFAULT_VIEWPORT_PX);
    };
    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, [activities.length]);

  const virtual = useMemo(
    () => activityVirtualRange({ count: activities.length, scrollTop, viewportHeight }),
    [activities.length, scrollTop, viewportHeight],
  );
  const visibleActivities = useMemo(
    () => activities.slice(virtual.start, virtual.end),
    [activities, virtual.start, virtual.end],
  );
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
          {windowTotal} window / {totalActivities} total · {range.from} to {range.to}
        </span>
      </div>
      {activities.length === 0 ? (
        <p className="empty">{windowTotal === 0 ? "No activity in this range." : "No activity matches the current filters."}</p>
      ) : (
        <div
          ref={listRef}
          className="activity-list"
          role="list"
          aria-label="Activity feed"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          style={
            {
              "--activity-row-height": `${ACTIVITY_ROW_HEIGHT_PX}px`,
            } as CSSProperties
          }
        >
          <div className="activity-virtual-space" style={{ height: `${virtual.totalHeightPx}px` }}>
            {visibleActivities.map((a, offset) => {
              const index = virtual.start + offset;
              const accentColor = colorOf(a.source_id, a.project_path);
              const display = activityDisplay(a);
              return (
                <article
                  key={a.id}
                  className={`activity-row${accentColor ? " card-accent" : ""}`}
                  role="listitem"
                  aria-posinset={index + 1}
                  aria-setsize={activities.length}
                  style={
                    {
                      "--repo-color": accentColor ?? undefined,
                      transform: `translateY(${index * ACTIVITY_ROW_STRIDE_PX}px)`,
                    } as CSSProperties
                  }
                >
                  <div className="activity-main">
                    <div className="activity-title-row">
                      <Badge text={a.action} kind={ACTION_KIND[a.action] ?? "status-unknown"} />
                      {a.url ? (
                        <a className="activity-title" href={a.url} target="_blank" rel="noopener noreferrer">
                          {display.title}
                        </a>
                      ) : (
                        <span className="activity-title">{display.title}</span>
                      )}
                    </div>
                    <div className="activity-meta">
                      <SourceIcon kind={sourceKind.get(a.source_id)} />
                      {display.meta.map((part) => (
                        <span key={part}>{part}</span>
                      ))}
                    </div>
                    {display.chips.length > 0 ? (
                      <div className="activity-chips">
                        {display.chips.map((part) => (
                          <span key={part}>{part}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <time className="activity-time" title={a.occurred_at}>
                    {relativeTime(a.occurred_at)}
                  </time>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}
