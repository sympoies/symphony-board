import { ActorLink } from "./ExternalLink.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { DetailNav } from "./DetailNav.tsx";
import { useDetailSwipe } from "../useDetailSwipe.ts";
import { detailNavigation } from "../detail-navigation.ts";
// Reviews tab — provider review-thread inbox.
//
// Unlike Activity/Commits (which are event feeds), each row here is the LIVE
// STATE of one resolvable review thread: is it still open (needs attention) or
// resolved (handled)? The layout mirrors the Live tab's master-detail so the two
// read and operate the same: a compact thread list on the left (each row a
// status glyph + the change request it hangs off + a clamped markdown preview of the
// opening comment) and the selected thread's full comment chain on the right.
// Status drives the row accent (--cat): salmon = unresolved, green = resolved,
// muted = resolved-but-outdated — so unhandled vs handled is scannable at a
// glance. The list virtualizes (fixed-height rows) like the other long feeds.
//
// On a narrow screen the detail becomes a route-backed full-screen overlay
// (?reviewDetail=1) so Android/browser Back closes the thread before leaving the
// tab — the same affordance the Live tab uses. The shared facet Controls (search
// + source/repo/state/kind/review-lens chips) live in App above this page, so the
// FILTER operation stays identical to the other content tabs.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ItemDTO, ReviewThreadCommentDTO, ReviewThreadDTO } from "@symphony-board/contract";
import {
  activityVirtualRange,
  relativeTime,
  reviewThreadComparator,
  reviewResolution,
  reviewThreadDisplayTime,
  type Filters,
  type ReviewSort,
  type TimeRange,
} from "../model.ts";
import { ActorAvatar } from "./ActorAvatar.tsx";
import { safeHref } from "../url.ts";
import { useListViewport } from "../useListViewport.ts";
import { useScrollbarGutter } from "../useScrollbarGutter.ts";
import { useDetailScrollReset } from "../detail-scroll.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { DETAIL_OVERLAY_QUERY } from "../layout-tier.ts";
import { clampContentPaneHeight, contentPaneBottomGutter, paneDocumentTop, readSafeAreaBottomPx } from "../pane-height.ts";
import { Badge } from "./Badge.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";
import { SourceRepo } from "./SourceRepo.tsx";

// Keep the row geometry in sync with the CSS: each row is a fixed-height card so
// the list can virtualize. Mirrors the Live feed's constants.
const REVIEW_PREVIEW_LINES = 3;
const REVIEW_ROW_BASE_HEIGHT_PX = 76;
const REVIEW_ROW_PREVIEW_LINE_HEIGHT_PX = 20;
const REVIEW_ROW_HEIGHT_PX = REVIEW_ROW_BASE_HEIGHT_PX + REVIEW_PREVIEW_LINES * REVIEW_ROW_PREVIEW_LINE_HEIGHT_PX;
const REVIEW_ROW_GAP_PX = 6;
const REVIEW_ROW_STRIDE_PX = REVIEW_ROW_HEIGHT_PX + REVIEW_ROW_GAP_PX;
const REVIEW_OVERSCAN_ROWS = 8;
const REVIEW_DEFAULT_VIEWPORT_PX = 640;
const REVIEW_PANE_BOTTOM_GUTTER_PX = 16;
const REVIEW_DETAIL_SWIPE_MIN_PX = 54;
const REVIEW_DETAIL_SWIPE_MAX_MS = 1100;

type ReviewDetailMove = "previous" | "next";
type ReviewDetailMotion = ReviewDetailMove | "neutral";

interface ThreadRow {
  thread: ReviewThreadDTO;
  target: ItemDTO | null;
}

interface ThreadStatus {
  key: "unresolved" | "resolved" | "outdated";
  // A custom property carrying the status hue; .live-event::before /
  // .live-detail-shell::before fall back to --muted, so an unforeseen value
  // still renders.
  colorVar: string;
}

interface ThreadNavigation {
  position: number;
  total: number;
  previous: ThreadRow | null;
  next: ThreadRow | null;
}

function lower(value: string | null | undefined): string {
  return value?.toLowerCase() ?? "";
}

function threadText(row: ThreadRow): string {
  const { thread, target } = row;
  return [
    thread.source_id,
    thread.project_path,
    thread.title,
    target?.title,
    target?.author,
    thread.path,
    thread.resolved_by,
    ...thread.comments.flatMap((comment) => [comment.author, comment.body]),
  ]
    .map(lower)
    .join("\n");
}

function threadMatches(row: ThreadRow, filters: Filters): boolean {
  const { thread, target } = row;
  if (filters.sources.size && !filters.sources.has(thread.source_id)) return false;
  if (filters.repos.size && !(thread.project_path != null && filters.repos.has(thread.project_path))) return false;
  if (filters.kinds.size && !(target && filters.kinds.has(target.kind))) return false;
  if (filters.states.size && !(target && filters.states.has(target.state))) return false;
  if (filters.reviews.size) {
    const wantsThreads = filters.reviews.has("threads");
    const wantsUnresolved = filters.reviews.has("unresolved");
    if (!wantsThreads && !wantsUnresolved) return false;
    const matchesReviewLens = (wantsUnresolved && !thread.is_resolved) || wantsThreads;
    if (!matchesReviewLens) return false;
  }
  const q = filters.search.trim().toLowerCase();
  if (q && lower(thread.project_path) === q) return true;
  return !q || threadText(row).includes(q);
}

function threadTimeTitle(thread: ReviewThreadDTO): string | undefined {
  const displayTime = reviewThreadDisplayTime(thread);
  if (!displayTime) return undefined;
  if (thread.last_seen_at && thread.last_seen_at !== displayTime) {
    return `last synced comment: ${displayTime}\nsync saw thread: ${thread.last_seen_at}`;
  }
  return displayTime;
}

function lineLabel(thread: ReviewThreadDTO): string | null {
  if (!thread.path) return null;
  if (thread.start_line != null && thread.line != null && thread.start_line !== thread.line) {
    return `${thread.path}:${thread.start_line}-${thread.line}`;
  }
  if (thread.line != null) return `${thread.path}:${thread.line}`;
  return thread.path;
}

function threadStatus(thread: ReviewThreadDTO): ThreadStatus {
  if (!thread.is_resolved) return { key: "unresolved", colorVar: "var(--broken)" };
  if (thread.is_outdated) return { key: "outdated", colorVar: "var(--muted)" };
  return { key: "resolved", colorVar: "var(--fulfilled)" };
}

function statusBadge(status: ThreadStatus) {
  if (status.key === "unresolved") return <Badge text="unresolved" kind="status-error" />;
  if (status.key === "outdated") return <Badge text="outdated" kind="status-unknown" />;
  return <Badge text="resolved" kind="status-ok" />;
}

const catStyle = (colorVar: string): CSSProperties => ({ "--cat": colorVar }) as CSSProperties;

function Commenters({ thread, target }: { thread: ReviewThreadDTO; target: ItemDTO | null }) {
  const authors: string[] = [];
  for (const comment of thread.comments) {
    const author = comment.author?.trim();
    if (author && !authors.includes(author)) authors.push(author);
  }
  if (authors.length > 0) {
    return <><ActorLink sourceId={thread.source_id} name={authors[0]!} username>@{authors[0]}</ActorLink>{authors.length > 1 ? ` +${authors.length - 1}` : ""}</>;
  }
  return target?.author ? <ActorLink sourceId={target.source_id} name={target.author} username>@{target.author}</ActorLink> : <>unknown</>;
}

function threadTitle(row: ThreadRow): string {
  const { thread, target } = row;
  const base = thread.title ?? target?.title ?? "Untitled change request";
  return thread.target_iid != null ? `#${thread.target_iid} ${base}` : base;
}

// The face for a thread comment. Avatars appear only inside the thread (the
// comment chain), not on the list rows or the detail header. The circle, the
// image fallback and the hover title are shared with the Activity rail, so this
// is a thin alias over ActorAvatar rather than a second copy.
function ReviewAvatar({ author, avatarUrl, className }: { author: string | null; avatarUrl?: string | null; className?: string }) {
  return <ActorAvatar login={author} avatarUrl={avatarUrl} className={className} />;
}

function threadKey(row: ThreadRow): string {
  return row.thread.id;
}

function threadNavigation(rows: ThreadRow[], current: ThreadRow | null): ThreadNavigation {
  const id = current?.thread.id;
  return detailNavigation(rows, id ? rows.findIndex((row) => row.thread.id === id) : -1);
}

function ReviewRow({
  row,
  selected,
  positionY,
  index,
  total,
  sourceKind,
  onSelect,
}: {
  row: ThreadRow;
  selected: boolean;
  positionY: number;
  index: number;
  total: number;
  sourceKind: ReadonlyMap<string, string>;
  onSelect: () => void;
}) {
  const { thread, target } = row;
  const status = threadStatus(thread);
  const location = lineLabel(thread);
  const preview = thread.comments[0]?.body ?? null;
  const displayTime = reviewThreadDisplayTime(thread);
  const previewRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  // Fade the preview's bottom edge ONLY when the body actually overflows the
  // clamp; measured so it re-checks once the lazy markdown finishes loading.
  useEffect(() => {
    const el = previewRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [preview]);
  return (
    <li
      className={`live-event${selected ? " live-event-selected" : ""}`}
      data-status={status.key}
      data-feed-index={index}
      style={{ ...catStyle(status.colorVar), transform: `translateY(${positionY}px)` } as CSSProperties}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="live-event-main">
        <div className="live-event-head">
          {statusBadge(status)}
          <ExternalLink className="live-event-title" href={thread.url ?? target?.url}>{threadTitle(row)}</ExternalLink>
        </div>
        <div className="review-row-meta">
          <span className="review-row-repo">
            <SourceRepo sourceId={thread.source_id} kind={sourceKind.get(thread.source_id)} repo={thread.project_path} />
          </span>
          <span className="review-row-by"><Commenters thread={thread} target={target} /></span>
          <ExternalLink className="review-row-loc" href={thread.url}>{location ?? "general discussion"}</ExternalLink>
        </div>
        {preview ? (
          <div
            ref={previewRef}
            className={`live-event-preview${clamped ? " is-clamped" : ""}`}
            style={{ "--preview-lines": REVIEW_PREVIEW_LINES } as CSSProperties}
          >
            <MarkdownBody text={preview} className="live-md live-md-preview" />
          </div>
        ) : (
          <div className="review-row-nopreview">No synced comment preview.</div>
        )}
      </div>
      <time className="live-event-time" title={threadTimeTitle(thread)}>
        {relativeTime(displayTime)}
      </time>
    </li>
  );
}


function ReviewComment({ comment, sourceId }: { comment: ReviewThreadCommentDTO; sourceId: string }) {
  const link = safeHref(comment.url);
  const when = comment.created_at ?? comment.updated_at;
  return (
    <article className="review-comment-card">
      <ActorLink sourceId={sourceId} name={comment.author} username><ReviewAvatar author={comment.author} avatarUrl={comment.avatar_url} className="review-comment-avatar" /></ActorLink>
      <div className="review-comment-main">
        <div className="review-comment-head">
          <strong><ActorLink sourceId={sourceId} name={comment.author} username>{comment.author ? `@${comment.author}` : "unknown"}</ActorLink></strong>
          {when ? (
            <time title={when}>{relativeTime(when)}</time>
          ) : null}
          {link ? (
            <ExternalLink href={link} target="_blank" rel="noopener noreferrer" className="review-comment-link">
              view ↗
            </ExternalLink>
          ) : null}
        </div>
        <MarkdownBody text={comment.body ?? "(empty comment)"} className="live-md" />
      </div>
    </article>
  );
}

function ReviewDetail({
  row,
  motion,
  sourceKind,
  onClose,
}: {
  row: ThreadRow;
  motion: ReviewDetailMotion;
  sourceKind: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const { thread, target } = row;
  const status = threadStatus(thread);
  const location = lineLabel(thread);
  const link = safeHref(thread.url);
  const hiddenComments = Math.max(0, thread.comments_total - thread.comments.length);
  const displayTime = reviewThreadDisplayTime(thread);
  const resolution = reviewResolution(thread);
  return (
    <article className="live-detail-card" data-detail-scroll>
      <button type="button" className="live-detail-back" onClick={onClose}>
        ← Back to threads
      </button>
      {/* Keyed on the thread id so the shell REMOUNTS on selection change and
          replays the reveal crossfade (styles.css), exactly like the Live tab. The
          prev/next nav is a sibling of this card (see the render below), so the
          narrow-screen overlay can pin it to the bottom while the card scrolls. */}
      <div className="live-detail-shell" key={threadKey(row)} data-motion={motion} style={catStyle(status.colorVar)}>
        <div className="live-detail-main">
          <div className="live-detail-head">
            {statusBadge(status)}
            {thread.resolved_by ? <span className="review-resolved-by">resolved by <ActorLink sourceId={thread.source_id} name={thread.resolved_by} username>@{thread.resolved_by}</ActorLink></span> : null}
            <time title={threadTimeTitle(thread)}>{relativeTime(displayTime)}</time>
          </div>
          <h2 className="live-detail-title">
            {link ? (
              <ExternalLink className="live-detail-title-link" href={link} target="_blank" rel="noopener noreferrer">
                {threadTitle(row)}
                <span className="live-detail-title-arrow" aria-hidden="true"> ↗</span>
              </ExternalLink>
            ) : (
              threadTitle(row)
            )}
          </h2>
          <div className="live-detail-ref">
            <SourceRepo sourceId={thread.source_id} kind={sourceKind.get(thread.source_id)} repo={thread.project_path} />
            <span className="review-detail-dot" aria-hidden="true">·</span>
            <span><Commenters thread={thread} target={target} /></span>
          </div>
          <div className="review-detail-loc"><ExternalLink href={thread.url}>{location ?? "general discussion"}</ExternalLink></div>
          {thread.comments.length === 0 ? (
            <p className="muted">No synced comment detail for this thread.</p>
          ) : (
            <div className="review-comment-thread">
              {thread.comments.map((comment) => (
                <ReviewComment key={comment.id} comment={comment} sourceId={thread.source_id} />
              ))}
              {hiddenComments > 0 ? (
                <p className="muted review-comment-more">
                  +{hiddenComments} more {hiddenComments === 1 ? "comment" : "comments"} not in the synced preview
                </p>
              ) : null}
            </div>
          )}
          {/* Echo the resolution at the END of the chain (the providers' "marked
              this conversation as resolved" trailing event), so the outcome is
              visible without scrolling back to the header. Timeless — the contract
              carries no resolved_at. Outdated-resolved dims to the muted hue. */}
          {resolution ? (
            <div className={`review-thread-resolution${resolution.outdated ? " is-outdated" : ""}`} role="note">
              <span className="review-thread-resolution-mark" aria-hidden="true">✓</span>
              <span>
                {thread.resolved_by ? <>Resolved by <ActorLink sourceId={thread.source_id} name={thread.resolved_by} username>@{thread.resolved_by}</ActorLink></> : resolution.label}
                {resolution.outdated ? " · outdated" : ""}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function ReviewsPage({
  reviewThreads,
  windowItems,
  filters,
  itemsById,
  range,
  sourceKind,
  sort,
  onSortChange,
  detailRouteOpen,
  onOpenDetailRoute,
  onCloseDetailRoute,
  onClearDetailRoute,
  emptyState,
}: {
  reviewThreads: ReviewThreadDTO[];
  windowItems: ItemDTO[];
  filters: Filters;
  itemsById: ReadonlyMap<string, ItemDTO>;
  range: TimeRange;
  sourceKind: ReadonlyMap<string, string>;
  sort: ReviewSort;
  onSortChange: (sort: ReviewSort) => void;
  detailRouteOpen: boolean;
  onOpenDetailRoute: () => void;
  onCloseDetailRoute: () => void;
  onClearDetailRoute: () => void;
  emptyState?: ReactNode;
}) {
  const windowById = useMemo(() => new Map(windowItems.map((item) => [item.id, item])), [windowItems]);
  const threadRows = useMemo(() => {
    const rows = reviewThreads
      .map((thread): ThreadRow => ({ thread, target: itemsById.get(thread.target_ref) ?? windowById.get(thread.target_ref) ?? null }))
      .filter((row) => threadMatches(row, filters));
    const compare = reviewThreadComparator(sort, rows.map((row) => row.thread));
    return rows.sort((a, b) => compare(a.thread, b.thread));
  }, [reviewThreads, itemsById, windowById, filters, sort]);

  const openThreads = useMemo(() => threadRows.reduce((n, row) => (row.thread.is_resolved ? n : n + 1), 0), [threadRows]);
  const resolvedThreads = threadRows.length - openThreads;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailMotion, setDetailMotion] = useState<ReviewDetailMotion>("neutral");
  const isDetailOverlay = useMediaQuery(DETAIL_OVERLAY_QUERY);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // The detail follows the selected thread; with nothing selected it shows the
  // first thread so the right pane is never empty (the inbox always lands on the
  // top of the queue — the most urgent unresolved thread).
  const detail = useMemo(() => {
    if (selectedId != null) {
      const match = threadRows.find((row) => row.thread.id === selectedId);
      if (match) return match;
    }
    return threadRows[0] ?? null;
  }, [selectedId, threadRows]);
  const detailKey = detail ? threadKey(detail) : null;
  const detailScrollRef = useDetailScrollReset<HTMLDivElement>(detailKey);
  const detailNav = useMemo(() => threadNavigation(threadRows, detail), [threadRows, detail]);

  // Drives the NARROW-screen overlay; route-backed so Back closes detail first.
  const detailOpen = isDetailOverlay && detailRouteOpen;

  const feedResetKey = useMemo(
    () =>
      JSON.stringify({
        search: filters.search,
        sources: [...filters.sources].sort(),
        repos: [...filters.repos].sort(),
        kinds: [...filters.kinds].sort(),
        states: [...filters.states].sort(),
        reviews: [...filters.reviews].sort(),
        // Reordering the whole list -> scroll back to the top, so the user lands on
        // the new head (the most recent thread) instead of mid-list.
        sort,
      }),
    [filters, sort],
  );

  const { listRef: feedRef, scrollTop, viewportHeight, handleScroll } = useListViewport<HTMLUListElement>({
    defaultViewportPx: REVIEW_DEFAULT_VIEWPORT_PX,
    resetKey: feedResetKey,
  });
  // This page returns an empty state entirely when no thread matches, so the
  // feed mounts late the same way Live's does.
  const scrollbarPx = useScrollbarGutter(feedRef, [threadRows.length === 0]);
  const virtual = useMemo(
    () =>
      activityVirtualRange({
        count: threadRows.length,
        scrollTop,
        viewportHeight,
        rowHeight: REVIEW_ROW_HEIGHT_PX,
        rowGap: REVIEW_ROW_GAP_PX,
        overscan: REVIEW_OVERSCAN_ROWS,
      }),
    [threadRows.length, scrollTop, viewportHeight],
  );
  const visibleRows = useMemo(() => threadRows.slice(virtual.start, virtual.end), [threadRows, virtual.start, virtual.end]);

  const splitRef = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const split = splitRef.current;
    if (!split || typeof window === "undefined") return;
    let raf = 0;
    const measure = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        // Document-relative top + an inset-aware gutter, through the shared clamp
        // every tab uses (pane-height.ts): one floor, one Android inset rule. The
        // rect read MUST precede readSafeAreaBottomPx — it flushes style + layout,
        // so the custom-property read resolves from clean style.
        const top = paneDocumentTop(split.getBoundingClientRect().top, window.scrollY);
        const next = clampContentPaneHeight(
          window.innerHeight,
          top,
          contentPaneBottomGutter(REVIEW_PANE_BOTTOM_GUTTER_PX, readSafeAreaBottomPx(window)),
        );
        setPaneHeight((cur) => (cur == null || Math.abs(cur - next) > 1 ? next : cur));
      });
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(split);
    ro?.observe(document.body);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [threadRows.length]);

  // Resizing back to a wide viewport closes a stranded overlay route.
  useEffect(() => {
    if (!isDetailOverlay && detailRouteOpen) onClearDetailRoute();
  }, [detailRouteOpen, isDetailOverlay, onClearDetailRoute]);

  const openDetail = useCallback(() => {
    if (!isDetailOverlay || detailRouteOpen) return;
    onOpenDetailRoute();
  }, [detailRouteOpen, isDetailOverlay, onOpenDetailRoute]);
  const closeDetail = useCallback(() => {
    if (detailRouteOpen) onCloseDetailRoute();
  }, [detailRouteOpen, onCloseDetailRoute]);

  const scrollRowIntoFeed = useCallback(
    (id: string) => {
      const feed = feedRef.current;
      if (!feed) return;
      const index = threadRows.findIndex((row) => row.thread.id === id);
      if (index < 0) return;
      const viewport = feed.clientHeight || viewportHeight || REVIEW_DEFAULT_VIEWPORT_PX;
      const targetTop = index * REVIEW_ROW_STRIDE_PX - Math.max(0, (viewport - REVIEW_ROW_HEIGHT_PX) / 2);
      const maxTop = Math.max(0, virtual.totalHeightPx - viewport);
      feed.scrollTo({
        top: Math.min(Math.max(0, targetTop), maxTop),
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    },
    [feedRef, threadRows, viewportHeight, virtual.totalHeightPx, prefersReducedMotion],
  );

  const selectThread = useCallback(
    (row: ThreadRow, motion: ReviewDetailMotion) => {
      setDetailMotion(motion);
      setSelectedId(row.thread.id);
      openDetail();
      scrollRowIntoFeed(row.thread.id);
    },
    [openDetail, scrollRowIntoFeed],
  );
  const navigateDetail = useCallback(
    (move: ReviewDetailMove) => {
      const target = move === "previous" ? detailNav.previous : detailNav.next;
      if (!target) return;
      selectThread(target, move);
    },
    [detailNav.next, detailNav.previous, selectThread],
  );

  // Horizontal swipe on the detail pane flips to the previous/next thread (the
  // narrow-screen affordance, mirroring the Live tab). Handled on the whole
  // `.live-detail` wrapper — which holds the scrolling card AND the pinned nav —
  // so a swipe anywhere in the overlay navigates, except over a control or a
  // horizontally-scrollable code block / table.
  const { handleDetailTouchStart, handleDetailTouchEnd, handleDetailTouchCancel } = useDetailSwipe(detail?.thread.id ?? null, navigateDetail);

  if (threadRows.length === 0) {
    return (
      <main className="reviews-page reviews-live">
        <div className="reviews-head">
          <h2>Reviews</h2>
          <span className="count">0 open threads</span>
          <span className="muted">0 resolved · 0 total · {range.from} to {range.to}</span>
        </div>
        {emptyState ?? <p className="empty">No review threads match the current view.</p>}
      </main>
    );
  }

  return (
    <main className="reviews-page reviews-live">
      <div className="reviews-head">
        <h2>Reviews</h2>
        <span className="count">{openThreads} open threads</span>
        <span className="muted">{resolvedThreads} resolved · {threadRows.length} total · {range.from} to {range.to}</span>
        <div className="reviews-sort toggle-group" role="group" aria-label="Sort review threads">
          <span className="toggle-label">Sort</span>
          <button
            type="button"
            className={`toggle${sort === "recent" ? " toggle-on" : ""}`}
            aria-pressed={sort === "recent"}
            onClick={() => onSortChange("recent")}
            title="Newest comment first, across every source"
          >
            Recent
          </button>
          <button
            type="button"
            className={`toggle${sort === "grouped" ? " toggle-on" : ""}`}
            aria-pressed={sort === "grouped"}
            onClick={() => onSortChange("grouped")}
            title="Unresolved first, newest groups first, then grouped by repo and the change request each thread hangs off"
          >
            Grouped
          </button>
        </div>
      </div>
      <div
        ref={splitRef}
        className="live-split"
        data-detail-open={detailOpen ? "true" : "false"}
        style={paneHeight == null ? undefined : ({ "--live-pane-height": `${paneHeight}px` } as CSSProperties)}
      >
        <ul
          className="live-feed"
          ref={feedRef}
          onScroll={handleScroll}
          style={
            {
              "--live-row-height": `${REVIEW_ROW_HEIGHT_PX}px`,
              // What the stylesheet pulls back out of this track so the detail pane
              // beside the feed sits one --pane-gap away like everything else on the
              // page. See --list-scrollbar in styles.css.
              "--list-scrollbar": `${scrollbarPx}px`,
            } as CSSProperties
          }
        >
          <li className="live-virtual-space" style={{ height: `${virtual.totalHeightPx}px` }} aria-hidden="true" />
          {visibleRows.map((row, offset) => {
            const index = virtual.start + offset;
            return (
              <ReviewRow
                key={threadKey(row)}
                row={row}
                selected={threadKey(row) === detailKey}
                positionY={index * REVIEW_ROW_STRIDE_PX}
                index={index}
                total={threadRows.length}
                sourceKind={sourceKind}
                onSelect={() => selectThread(row, "neutral")}
              />
            );
          })}
        </ul>
        <div
          className="live-detail"
          ref={detailScrollRef}
          onTouchStart={handleDetailTouchStart}
          onTouchEnd={handleDetailTouchEnd}
          onTouchCancel={handleDetailTouchCancel}
        >
          {detail ? (
            <>
              <ReviewDetail
                row={detail}
                motion={detailMotion}
                sourceKind={sourceKind}
                onClose={closeDetail}
              />
              <DetailNav noun="thread" label="Review thread navigation"
                position={detailNav.position}
                total={detailNav.total}
                canPrevious={detailNav.previous !== null}
                canNext={detailNav.next !== null}
                onNavigate={navigateDetail}
              />
            </>
          ) : (
            <div className="live-detail-empty">Select a thread to read its discussion.</div>
          )}
        </div>
      </div>
    </main>
  );
}
