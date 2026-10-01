import type { ActivityDTO, ActivityDailyDTO, ItemDTO, ReviewThreadDTO } from "@symphony-board/contract";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ActivityDetail } from "./ActivityDetail.tsx";
import { DetailNav } from "./DetailNav.tsx";
import { detailNavigation } from "../detail-navigation.ts";
import { useDetailSwipe } from "../useDetailSwipe.ts";
import { activityKey, commitChangeRequest, type ResolvedChangeRequest } from "../model.ts";
import type { ChangeRequestLinkResolver } from "./CommitsPage.tsx";
import {
  activityTargetItem,
  commentExcerptIndex,
  commentExcerptOf,
  eventsOnTarget,
  initialDetailMode,
  modeAfterRowClick,
  pushHeadCommit,
  reconcileDetailMode,
  selectedActivity,
  shouldClearDetailRoute,
  type ActivityDetailMode,
} from "../activity-detail.ts";
import { ActivityHeatmap } from "./ActivityHeatmap.tsx";
import { MOBILE_VIEWPORT_QUERY, type ColorOf, type TimeRange } from "../model.ts";
import { COMMITS_PANES_QUERY, COMMITS_STACK_QUERY, SPLIT_STACK_QUERY, type CommitsPanes } from "../layout-tier.ts";
import { ActivityOverview } from "./ActivityOverview.tsx";
import { ActivityPanesRail } from "./ActivityPanesRail.tsx";
import { useMediaQuery } from "../useMediaQuery.ts";
import { useContentPaneHeight } from "../useContentPaneHeight.ts";
import { EMPTY_ACTOR_INDEX, type ActorIndex } from "../rail-stats.ts";
import type { ActivityFacets, ActivityView } from "../nav.ts";

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
  actorAvatars,
  actorIndex = EMPTY_ACTOR_INDEX,
  onView,
  reviewThreads,
  resolveChangeRequestLink,
  itemDestination,
  detailRouteOpen = false,
  onOpenDetailRoute,
  onCloseDetailRoute,
  onClearDetailRoute,
  facets,
  onFacet,
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
  // Canonical actor name -> avatar URL for the rail Who column.
  actorAvatars?: ReadonlyMap<string, string>;
  // Contract actor directory as lookups, for the rail's Who column.
  actorIndex?: ActorIndex;
  onView: (view: ActivityView) => void;
  // The contract's review-thread rows, the only comment text it carries; a
  // selected review comment quotes its own words from here.
  reviewThreads?: readonly ReviewThreadDTO[];
  // A commit row's change request, resolved the way the Commits page does.
  resolveChangeRequestLink?: ChangeRequestLinkResolver;
  // Where a target item leads: the Items page or its provider page.
  itemDestination?: (item: ItemDTO) => { href: string | null; external: boolean };
  // The phone reader is route-backed (`activityDetail=1`), so Back closes the
  // event before it leaves the page.
  detailRouteOpen?: boolean;
  onOpenDetailRoute?: () => void;
  onCloseDetailRoute?: () => void;
  onClearDetailRoute?: () => void;
  // The route-backed facets, and the way to toggle one, for the pane tiers'
  // rows (a repository, a kind, an action, a review verdict).
  facets?: ActivityFacets;
  onFacet?: (dim: "repos" | "kinds" | "actions", value: string) => void;
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
  // The rail is an addition for viewports with room to spare, never a
  // replacement: below its breakpoint the page keeps exactly today's two-column
  // (then single-pane) behaviour, and the mobile Feed / Overview toggle is
  // untouched — a third sub-view would make the phone layout worse, not better.
  // The pane tiers, the Commits page's: from the laptop tier both supporting
  // columns carry the full set of panes, stacked; from the wide tier they lay
  // them out two-up. Decided here, once, for both columns. Below them the page
  // keeps its two columns and the plain overview.
  const widePanes = useMediaQuery(COMMITS_PANES_QUERY);
  const stackPanes = useMediaQuery(COMMITS_STACK_QUERY);
  const panes: CommitsPanes | null = widePanes ? "wide" : stackPanes ? "stack" : null;

  // ---- selection --------------------------------------------------------------
  // Below the split floor the overview stacks UNDER the feed, so a detail
  // inserted above it would open out of sight. There, as on a phone, a row opens
  // the event as a reader over the page instead.
  const readerMode = useMediaQuery(SPLIT_STACK_QUERY);
  // Like the Commits page: page-local, keyed by activityKey so a re-filter that
  // moves the row keeps it, and explicit about following the newest row versus
  // a pinned one. On a wide screen the pane opens following the latest event,
  // so the page shows an event's detail without a click (pinned to that row, so a
  // reload does not swap it; see initialDetailMode); a phone shows the feed and
  // opens the reader on a tap.
  const [detailMode, setDetailMode] = useState<ActivityDetailMode>(() =>
    initialDetailMode(activities, typeof window !== "undefined" && !!window.matchMedia?.(SPLIT_STACK_QUERY).matches),
  );
  const selected = useMemo(() => selectedActivity(activities, detailMode), [activities, detailMode]);
  useEffect(() => {
    const next = reconcileDetailMode(detailMode, activities, readerMode);
    if (next !== detailMode) setDetailMode(next);
  }, [detailMode, activities, readerMode]);
  const selectedKey = selected ? activityKey(selected) : null;
  const mobileDetailOpen = readerMode && detailRouteOpen && selected !== null;
  useEffect(() => {
    if (shouldClearDetailRoute(detailRouteOpen, readerMode, selected !== null)) onClearDetailRoute?.();
  }, [detailRouteOpen, readerMode, selected, onClearDetailRoute]);
  const excerptIndex = useMemo(() => commentExcerptIndex(reviewThreads), [reviewThreads]);
  const selectedItem = selected ? activityTargetItem(selected, itemsById) : undefined;
  const selectedExcerpt = useMemo(() => (selected ? commentExcerptOf(selected, excerptIndex) : null), [selected, excerptIndex]);
  const related = useMemo(() => (selected ? eventsOnTarget(activities, selected, 8) : { rows: [], total: 0 }), [activities, selected]);
  const headCommit = useMemo(() => (selected ? pushHeadCommit(activities, selected) : undefined), [activities, selected]);
  const selectedChangeRequest: ResolvedChangeRequest | null | undefined = useMemo(() => {
    if (!selected || !resolveChangeRequestLink) return undefined;
    const link = commitChangeRequest(selected);
    return link ? resolveChangeRequestLink(link, selected.source_id) : link;
  }, [selected, resolveChangeRequestLink]);
  const selectedIndex = selected ? activities.indexOf(selected) : -1;
  const detailNav = detailNavigation(activities, selectedIndex);
  const navigateDetail = (direction: "previous" | "next") => {
    const row = direction === "next" ? detailNav.next : detailNav.previous;
    if (row) setDetailMode({ kind: "pinned", key: activityKey(row) });
  };
  const { handleDetailTouchStart, handleDetailTouchEnd, handleDetailTouchCancel } = useDetailSwipe(
    mobileDetailOpen ? selectedKey : null,
    navigateDetail,
  );
  const pin = (row: ActivityDTO) => setDetailMode({ kind: "pinned", key: activityKey(row) });
  const selectRow = (row: ActivityDTO) => {
    const key = activityKey(row);
    if (readerMode) {
      pin(row);
      onOpenDetailRoute?.();
      return;
    }
    setDetailMode(modeAfterRowClick(detailMode, key, selectedKey));
  };
  const closeDetail = () => {
    if (mobileDetailOpen) onCloseDetailRoute?.();
    setDetailMode({ kind: "closed" });
  };
  useLayoutEffect(() => {
    if (!mobileDetailOpen) return;
    document.querySelector<HTMLElement>(".activity-reader")?.scrollTo(0, 0);
  }, [mobileDetailOpen, selectedKey]);
  const detailPane = selected ? (
    <ActivityDetail
      activity={selected}
      item={selectedItem}
      providerKind={sourceKind.get(selected.source_id)}
      sourceKind={sourceKind}
      colorOf={colorOf}
      timezone={timezone}
      excerpt={selectedExcerpt}
      related={related}
      headCommit={headCommit}
      changeRequest={selectedChangeRequest}
      itemDestination={itemDestination}
      avatarUrl={selected.actor ? actorAvatars?.get(actorIndex.canonical.get(selected.actor) ?? selected.actor) : undefined}
      following={detailMode.kind === "following"}
      onFollowLatest={() => setDetailMode({ kind: "following" })}
      onClose={closeDetail}
      onSelect={pin}
    />
  ) : null;
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
  // The feed is the page's content pane, so it fills the viewport below the
  // split exactly like Items / Board / Graph do rather than taking a fixed
  // fraction of it. `.activity-list` used to hardcode `max-height: 74dvh`, which
  // on a 4K panel stopped the feed ~100px short of the viewport bottom while
  // every other tab reached it. The var is published on the split (its top is
  // the feed's top, since the feed is a direct grid child) and only the feed
  // reads it; the overview and rail keep sizing to their own content.
  const { paneRef: splitPaneRef, paneHeightStyle } = useContentPaneHeight<HTMLDivElement>([
    activities.length,
    showFeed,
    showOverview,
    panes,
  ]);
  const layoutStyle: CSSProperties | undefined =
    heatmapHeight > 0 || paneHeightStyle
      ? ({
          ...paneHeightStyle,
          ...(heatmapHeight > 0 ? { "--activity-rhythm-height": `${heatmapHeight}px` } : {}),
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
      {mobileDetailOpen ? (
        <div
          className="activity-reader"
          role="dialog"
          aria-modal="true"
          aria-label="Activity event"
          onTouchStart={handleDetailTouchStart}
          onTouchEnd={handleDetailTouchEnd}
          onTouchCancel={handleDetailTouchCancel}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeDetail();
          }}
        >
          <nav className="commit-mobile-pane-nav" aria-label="Activity event">
            <button type="button" className="commit-mobile-back" onClick={closeDetail} autoFocus>
              ← Activity
            </button>
          </nav>
          <div className="activity-reader-body">{detailPane}</div>
          <DetailNav
            className="commit-detail-nav"
            label="Browse activity"
            noun="event"
            chronological
            hideSingle={false}
            position={detailNav.position}
            total={detailNav.total}
            canPrevious={detailNav.previous !== null}
            canNext={detailNav.next !== null}
            onNavigate={navigateDetail}
          />
        </div>
      ) : null}
      <div className="activity-head">
        <h2>Activity</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          {windowTotal} window / {totalActivities} total · {range.from} to {range.to}
        </span>
      </div>
      {isMobile ? <ActivityViewToggle view={view} onView={onView} /> : null}
      {/* In the pane tiers the layout is also a .commits-split, so the two pages
          share one set of tier rules: the column split, the middle column that
          stacks the detail over a scrolling overview, the rail's two-up grid. */}
      <div className={`activity-layout${panes ? " commits-split activity-panes" : ""}`} data-panes={panes ?? undefined} ref={splitPaneRef} style={layoutStyle}>
        {showFeed ? (
          <ActivityFeed
            activities={activities}
            sourceKind={sourceKind}
            colorOf={colorOf}
            empty={emptyState}
            itemsById={itemsById}
            selectedKey={readerMode ? null : selectedKey}
            onSelect={selectRow}
          />
        ) : null}
        {showOverview ? (
          overviewOnlyEmpty ? (
            (emptyState ?? null)
          ) : (
            // The middle column: the selected event above the range overview,
            // which moves down intact (the Commits page's .commits-context).
            <div className={`activity-context${panes ? " commits-context" : ""}`}>
              {readerMode ? null : detailPane}
              {panes ? (
                <ActivityOverview
                  activities={activities}
                  activityDaily={activityDaily}
                  timezone={timezone}
                  range={range}
                  actorIndex={actorIndex}
                  panes={panes}
                  itemsById={itemsById}
                  sourceKind={sourceKind}
                  selectedKey={selectedKey}
                  onSelect={pin}
                  selectedActions={facets?.actions ?? EMPTY_SET}
                  onAction={onFacet ? (action) => onFacet("actions", action) : undefined}
                  panelRef={heatmapPanelRef}
                />
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
              )}
            </div>
          )
        ) : null}
        {/* Third column, in the pane tiers only. Gated on the viewport rather
            than only hidden in CSS so a smaller screen never pays to rank what
            it will not show. */}
        {panes ? (
          <ActivityPanesRail
            activities={activities}
            timezone={timezone}
            range={range}
            panes={panes}
            actorIndex={actorIndex}
            avatarOf={actorAvatars}
            facets={facets ?? EMPTY_FACETS}
            onFacet={onFacet}
          />
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

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_FACETS: ActivityFacets = { sources: EMPTY_SET, repos: EMPTY_SET, kinds: EMPTY_SET, actions: EMPTY_SET };
