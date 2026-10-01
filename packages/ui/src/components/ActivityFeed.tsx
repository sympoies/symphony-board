import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ActivityDTO, ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { ACTION_KIND } from "../activity-action-style.ts";
import { useListViewport } from "../useListViewport.ts";
import { useScrollbarGutter } from "../useScrollbarGutter.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { activityRowView, activityTargetItem } from "../activity-detail.ts";
import { copyText } from "../clipboard.ts";
import { CheckIcon, CopyIcon } from "./icons.tsx";
import {
  ACTIVITY_DEFAULT_VIEWPORT_PX,
  MOBILE_VIEWPORT_QUERY,
  ACTIVITY_MOBILE_ROW_HEIGHT_PX,
  ACTIVITY_ROW_GAP_PX,
  ACTIVITY_ROW_HEIGHT_PX,
  activityKey,
  activityVirtualRange,
  relativeTime,
  reviewThreadsLabel,
  displayKind,
  type ColorOf,
} from "../model.ts";

// The scrollable, virtualized activity list: one compact row per event, the
// way the Commits list reads.
//
// A row is two lines. The first names the event: its action (for a review, its
// verdict), the item's number and title (or a commit's subject, or `branch
// main`), and on the right the one fact the kind carries -- the item's current
// state, or a commit's line counts. The second line says where and who, then the chips
// (a review comment's file and line, a push's from -> to). The full story is
// the detail pane, which a row opens: the whole row is the selection target,
// and the title and the controls on the right keep their own clicks.
export function ActivityFeed({
  activities,
  sourceKind,
  colorOf,
  empty,
  itemsById,
  selectedKey = null,
  onSelect,
}: {
  activities: ActivityDTO[];
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  // Empty-state node rendered when there are no rows; falls back to a plain line.
  empty?: ReactNode;
  // Item index by ref, so a row can name the item it is about: its title and
  // current state, and a review row's open-thread count.
  itemsById?: ReadonlyMap<string, ItemDTO>;
  // The row shown in the detail pane, by activityKey.
  selectedKey?: string | null;
  onSelect?: (activity: ActivityDTO) => void;
}) {
  const mobileRows = useMediaQuery(MOBILE_VIEWPORT_QUERY);
  const rowHeight = mobileRows ? ACTIVITY_MOBILE_ROW_HEIGHT_PX : ACTIVITY_ROW_HEIGHT_PX;
  const rowStride = rowHeight + ACTIVITY_ROW_GAP_PX;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // A new `activities` array means the range or repo filter changed — the hook
  // jumps back to the top so the viewer is not stranded mid-scroll in a
  // different result set.
  const { listRef, scrollTop, viewportHeight, handleScroll } = useListViewport({
    defaultViewportPx: ACTIVITY_DEFAULT_VIEWPORT_PX,
    resetKey: activities,
  });
  // An empty result renders a paragraph instead of the list, so the element
  // this measures mounts late.
  const scrollbarPx = useScrollbarGutter(listRef, [activities.length === 0]);

  useEffect(() => {
    if (!copiedKey) return;
    const timeout = window.setTimeout(() => setCopiedKey(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [copiedKey]);

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
          // See --list-scrollbar in styles.css: the feed's scrollbar sits inside
          // its own track, so without this the overview beside it reads 22px
          // away while everything else on the page reads 12.
          "--list-scrollbar": `${scrollbarPx}px`,
        } as CSSProperties
      }
    >
      <div className="activity-virtual-space" style={{ height: `${virtual.totalHeightPx}px` }}>
        {visibleActivities.map((a, offset) => {
          const index = virtual.start + offset;
          const key = activityKey(a);
          const accentColor = colorOf(a.source_id, a.project_path);
          const item = activityTargetItem(a, itemsById);
          const view = activityRowView(a, item, sourceKind.get(a.source_id));
          const chips = [...view.chips];
          if (a.kind === "review") {
            const threads = reviewThreadsLabel(item?.review_threads);
            if (threads) chips.push(threads);
          }
          const selected = key === selectedKey;
          const copied = copiedKey === key;
          const kindLabel = displayKind(a.kind);
          return (
            <article
              key={key}
              className={`activity-row${accentColor ? " card-accent" : ""}${selected ? " activity-row-selected" : ""}`}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={activities.length}
              aria-current={selected ? "true" : undefined}
              data-activity-key={key}
              // The row is the way into the detail pane, by mouse and by
              // keyboard. Its links and buttons stop propagation, so one click
              // does one thing.
              tabIndex={onSelect ? 0 : undefined}
              onClick={onSelect ? () => onSelect(a) : undefined}
              onKeyDown={
                onSelect
                  ? (e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      onSelect(a);
                    }
                  : undefined
              }
              style={
                {
                  "--repo-color": accentColor ?? undefined,
                  transform: `translateY(${index * rowStride}px)`,
                } as CSSProperties
              }
            >
              <div className="activity-main">
                <div className="activity-title-row">
                  <Badge text={a.action.replace(/_/g, " ")} kind={ACTION_KIND[a.action] ?? "status-unknown"} />
                  {view.label ? <span className="activity-ref">{view.label}</span> : null}
                  {a.url ? (
                    <a
                      className="activity-title"
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={view.title}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {view.title}
                    </a>
                  ) : (
                    <span className="activity-title" title={view.title}>
                      {view.title}
                    </span>
                  )}
                </div>
                <div className="activity-meta">
                  <SourceRepo kind={sourceKind.get(a.source_id)} repo={a.project_path} />
                  {a.actor ? <span className="activity-actor">@{a.actor}</span> : null}
                  {kindLabel ? <span className="activity-kind">{kindLabel}</span> : null}
                  {chips.length > 0 ? (
                    <span className="activity-chips">
                      {chips.map((part) => (
                        <span key={part}>{part}</span>
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="activity-side">
                <span className="activity-fact">
                  {view.state ? (
                    <Badge text={view.state} kind={view.state} title={`now ${view.state}`} />
                  ) : view.merge ? (
                    <span className="commit-merge-tag" title="Merge commit: its lines are counted in the commits it brought in">
                      merge
                    </span>
                  ) : view.diff ? (
                    <DiffStat stats={view.diff} />
                  ) : null}
                </span>
                <time className="activity-time" dateTime={a.occurred_at} title={a.occurred_at}>
                  {relativeTime(a.occurred_at)}
                </time>
                {view.copy ? (
                  <button
                    type="button"
                    className={`activity-icon-button${copied ? " is-copied" : ""}`}
                    aria-label={`Copy ${view.copy.label}`}
                    title={copied ? "Copied" : `Copy ${view.copy.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const value = view.copy?.value;
                      if (value) void copyText(value).then(() => setCopiedKey(key));
                    }}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
