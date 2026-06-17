import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ActivityDTO, ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { useListViewport } from "../useListViewport.ts";
import {
  ACTIVITY_DEFAULT_VIEWPORT_PX,
  ACTIVITY_MOBILE_ROW_HEIGHT_PX,
  ACTIVITY_ROW_GAP_PX,
  ACTIVITY_ROW_HEIGHT_PX,
  activityDisplay,
  activityVirtualRange,
  relativeTime,
  type ColorOf,
} from "../model.ts";

// Action -> badge style for the mixed Activity feed. Every `action` the sources
// emit (see src/sources/* and src/model/activity.ts) needs an entry here; an
// unmapped action falls through to the quiet neutral "status-unknown" pill.
export const ACTION_KIND: Record<string, string> = {
  // item lifecycle
  opened: "open",
  reopened: "open",
  closed: "closed",
  merged: "merged",
  accepted: "merged", // GitLab emits "accepted" when an MR is merged
  // commits / pushes
  committed: "status-ok",
  created: "status-ok",
  pushed: "lifecycle-declared",
  force_pushed: "lifecycle-broken",
  deleted: "status-error",
  // comments + reviews
  commented: "status-partial",
  approved: "status-ok",
  reviewed: "status-partial",
  changes_requested: "status-error",
  dismissed: "status-idle",
};

const ACTIVITY_MOBILE_QUERY = "(max-width: 760px)";

function mobileActivityRows(): boolean {
  return typeof window !== "undefined" && window.matchMedia(ACTIVITY_MOBILE_QUERY).matches;
}

// The scrollable, virtualized activity list. Rows render a clickable title when
// the record carries a `url` (e.g. a commit links straight to its GitHub/GitLab
// page), while the dedicated Commits page uses its own SCM-style renderer.
export function ActivityFeed({
  activities,
  sourceKind,
  colorOf,
  empty,
  itemsById,
}: {
  activities: ActivityDTO[];
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  // Empty-state node rendered when there are no rows; falls back to a plain line.
  empty?: ReactNode;
  // Item index by ref, so a `review` row can resolve its `target_ref` to the
  // change_request and show that PR/MR's current open-thread count. Optional:
  // callers without it simply render no review-resolution chip.
  itemsById?: ReadonlyMap<string, ItemDTO>;
}) {
  const [mobileRows, setMobileRows] = useState(mobileActivityRows);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia(ACTIVITY_MOBILE_QUERY);
    const onChange = () => setMobileRows(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const rowHeight = mobileRows ? ACTIVITY_MOBILE_ROW_HEIGHT_PX : ACTIVITY_ROW_HEIGHT_PX;
  const rowStride = rowHeight + ACTIVITY_ROW_GAP_PX;

  // A new `activities` array means the range or repo filter changed — the hook
  // jumps back to the top so the viewer is not stranded mid-scroll in a
  // different result set.
  const { listRef, scrollTop, viewportHeight, handleScroll } = useListViewport({
    defaultViewportPx: ACTIVITY_DEFAULT_VIEWPORT_PX,
    resetKey: activities,
  });

  const virtual = useMemo(
    () => activityVirtualRange({ count: activities.length, scrollTop, viewportHeight, rowHeight }),
    [activities.length, rowHeight, scrollTop, viewportHeight],
  );
  const visibleActivities = useMemo(
    () => activities.slice(virtual.start, virtual.end),
    [activities, virtual.start, virtual.end],
  );

  if (activities.length === 0) return <>{empty ?? <p className="empty">No activity.</p>}</>;

  return (
    <div
      ref={listRef}
      className="activity-list"
      role="list"
      aria-label="Activity feed"
      onScroll={handleScroll}
      style={
        {
          "--activity-row-height": `${rowHeight}px`,
        } as CSSProperties
      }
    >
      <div className="activity-virtual-space" style={{ height: `${virtual.totalHeightPx}px` }}>
        {visibleActivities.map((a, offset) => {
          const index = virtual.start + offset;
          const accentColor = colorOf(a.source_id, a.project_path);
          const reviewThreads =
            a.kind === "review" && a.target_ref ? (itemsById?.get(a.target_ref)?.review_threads ?? null) : null;
          const display = activityDisplay(a, { reviewThreads });
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
                  transform: `translateY(${index * rowStride}px)`,
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
                  <SourceRepo kind={sourceKind.get(a.source_id)} repo={display.repo} />
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
  );
}
