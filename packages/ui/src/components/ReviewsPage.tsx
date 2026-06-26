// Reviews tab — provider review-thread inbox.
//
// Unlike Activity/Commits (which are event feeds), each row here is the LIVE
// STATE of one resolvable review thread: is it still open (needs attention) or
// resolved (handled)? The layout mirrors the Live tab's master-detail so the two
// read and operate the same: a compact thread list on the left (each row a
// status glyph + the PR/MR it hangs off + a clamped markdown preview of the
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
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from "react";
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
import { liveAvatarModel } from "../live-avatar.ts";
import { safeHref } from "../url.ts";
import { useListViewport } from "../useListViewport.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { Badge } from "./Badge.tsx";
import { SourceRepo } from "./SourceRepo.tsx";

// react-markdown + remark-gfm are lazy-loaded so they form their own chunk and
// stay out of the board/graph bundles — shared with the Live tab's chunk.
const Markdown = lazy(() => import("./Markdown.tsx"));

// Memoized so an unrelated re-render never re-parses an unchanged body; falls
// back to the plain text while the markdown chunk loads so a row never flashes
// empty.
const MarkdownBody = memo(function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<div className={className}><div className="live-md-fallback">{text}</div></div>}>
      <Markdown className={className}>{text}</Markdown>
    </Suspense>
  );
});

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
const REVIEW_PANE_MIN_HEIGHT_PX = 320;
// Keep this in sync with the CSS breakpoint where .live-detail becomes a fixed
// overlay (shared with the Live tab).
const REVIEW_DETAIL_OVERLAY_QUERY = "(max-width: 900px)";
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

function commentersLabel(thread: ReviewThreadDTO, target: ItemDTO | null): string {
  const authors: string[] = [];
  for (const comment of thread.comments) {
    const author = comment.author?.trim();
    if (author && !authors.includes(author)) authors.push(author);
  }
  if (authors.length > 0) {
    return authors.length === 1 ? `@${authors[0]}` : `@${authors[0]} +${authors.length - 1}`;
  }
  return target?.author ? `@${target.author}` : "unknown";
}

function threadTitle(row: ThreadRow): string {
  const { thread, target } = row;
  const base = thread.title ?? target?.title ?? "Untitled change request";
  return thread.target_iid != null ? `#${thread.target_iid} ${base}` : base;
}

// The face for a thread comment. Avatars appear only inside the thread (the
// comment chain), not on the list rows or the detail header. Renders the real
// provider photo when the contract carries one (avatar_url, 4.2.0+) and falls
// back to the author's initials — the same circle + image handling as the Live
// tab (reusing liveAvatarModel and the .live-avatar styles).
function ReviewAvatar({ author, avatarUrl, className }: { author: string | null; avatarUrl?: string | null; className?: string }) {
  const model = liveAvatarModel(author ? { login: author, avatar_url: avatarUrl ?? null } : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [model.imageUrl]);
  const showImage = model.imageUrl != null && !failed;
  const cls = `live-avatar ${showImage ? "live-avatar-image" : "live-avatar-text"}${className ? ` ${className}` : ""}`;
  return (
    <span className={cls} title={model.label} aria-label={model.label}>
      {showImage ? (
        <img src={model.imageUrl!} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="live-avatar-fallback" aria-hidden="true">{model.initials}</span>
      )}
    </span>
  );
}

function threadKey(row: ThreadRow): string {
  return row.thread.id;
}

function threadNavigation(rows: ThreadRow[], current: ThreadRow | null): ThreadNavigation {
  const id = current ? current.thread.id : null;
  const index = id ? rows.findIndex((row) => row.thread.id === id) : -1;
  return {
    position: index >= 0 ? index + 1 : 0,
    total: rows.length,
    previous: index > 0 ? rows[index - 1]! : null,
    next: index >= 0 && index + 1 < rows.length ? rows[index + 1]! : null,
  };
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
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="live-event-main">
        <div className="live-event-head">
          {statusBadge(status)}
          <span className="live-event-title">{threadTitle(row)}</span>
        </div>
        <div className="review-row-meta">
          <span className="review-row-repo">
            <SourceRepo kind={sourceKind.get(thread.source_id)} repo={thread.project_path} />
          </span>
          <span className="review-row-by">{commentersLabel(thread, target)}</span>
          <span className="review-row-loc">{location ?? "general discussion"}</span>
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

function blocksDetailSwipe(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("a, button, input, textarea, select, summary, [role='button']"));
}

// A horizontally-scrollable ancestor (a wide code block or markdown table) gets
// first claim on a horizontal drag, so swiping inside one scrolls it instead of
// flipping to the next/previous thread. Mirrors LivePage.
function horizontalSwipeScroller(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const scroller = target.closest("table, pre");
  if (!(scroller instanceof HTMLElement)) return null;
  return scroller.scrollWidth > scroller.clientWidth + 2 ? scroller : null;
}

function scrollCanConsumeSwipe(scroller: HTMLElement, scrollLeft: number, dx: number): boolean {
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxScrollLeft <= 2) return false;
  if (dx < 0) return scrollLeft < maxScrollLeft - 2;
  if (dx > 0) return scrollLeft > 2;
  return false;
}

function ReviewDetailNav({
  position,
  total,
  canPrevious,
  canNext,
  onNavigate,
}: {
  position: number;
  total: number;
  canPrevious: boolean;
  canNext: boolean;
  onNavigate: (move: ReviewDetailMove) => void;
}) {
  if (total <= 1) return null;
  const handleTouchNavigate = (move: ReviewDetailMove) => (event: TouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onNavigate(move);
  };
  const stopTouchPropagation = (event: TouchEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  return (
    <nav className="live-detail-nav" aria-label="Review thread navigation">
      <button
        type="button"
        className="live-detail-nav-button"
        disabled={!canPrevious}
        aria-label="Show previous thread"
        title="Show previous thread"
        onTouchStart={stopTouchPropagation}
        onTouchEnd={handleTouchNavigate("previous")}
        onClick={() => onNavigate("previous")}
      >
        ‹ <span>Prev</span>
      </button>
      <span className="live-detail-nav-count" aria-live="polite">
        {position > 0 ? position : "—"} / {total}
      </span>
      <button
        type="button"
        className="live-detail-nav-button"
        disabled={!canNext}
        aria-label="Show next thread"
        title="Show next thread"
        onTouchStart={stopTouchPropagation}
        onTouchEnd={handleTouchNavigate("next")}
        onClick={() => onNavigate("next")}
      >
        <span>Next</span> ›
      </button>
    </nav>
  );
}

function ReviewComment({ comment }: { comment: ReviewThreadCommentDTO }) {
  const link = safeHref(comment.url);
  const when = comment.created_at ?? comment.updated_at;
  return (
    <article className="review-comment-card">
      <ReviewAvatar author={comment.author} avatarUrl={comment.avatar_url} className="review-comment-avatar" />
      <div className="review-comment-main">
        <div className="review-comment-head">
          <strong>{comment.author ? `@${comment.author}` : "unknown"}</strong>
          {when ? (
            <time title={when}>{relativeTime(when)}</time>
          ) : null}
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer" className="review-comment-link">
              view ↗
            </a>
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
    <article className="live-detail-card">
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
            {thread.resolved_by ? <span className="review-resolved-by">resolved by @{thread.resolved_by}</span> : null}
            <time title={threadTimeTitle(thread)}>{relativeTime(displayTime)}</time>
          </div>
          <h2 className="live-detail-title">
            {link ? (
              <a className="live-detail-title-link" href={link} target="_blank" rel="noopener noreferrer">
                {threadTitle(row)}
                <span className="live-detail-title-arrow" aria-hidden="true"> ↗</span>
              </a>
            ) : (
              threadTitle(row)
            )}
          </h2>
          <div className="live-detail-ref">
            <SourceRepo kind={sourceKind.get(thread.source_id)} repo={thread.project_path} />
            <span className="review-detail-dot" aria-hidden="true">·</span>
            <span>{commentersLabel(thread, target)}</span>
          </div>
          <div className="review-detail-loc">{location ?? "general discussion"}</div>
          {thread.comments.length === 0 ? (
            <p className="muted">No synced comment detail for this thread.</p>
          ) : (
            <div className="review-comment-thread">
              {thread.comments.map((comment) => (
                <ReviewComment key={comment.id} comment={comment} />
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
                {resolution.label}
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
    const compare = reviewThreadComparator(sort);
    return reviewThreads
      .map((thread): ThreadRow => ({ thread, target: itemsById.get(thread.target_ref) ?? windowById.get(thread.target_ref) ?? null }))
      .filter((row) => threadMatches(row, filters))
      .sort((a, b) => compare(a.thread, b.thread));
  }, [reviewThreads, itemsById, windowById, filters, sort]);

  const openThreads = useMemo(() => threadRows.reduce((n, row) => (row.thread.is_resolved ? n : n + 1), 0), [threadRows]);
  const resolvedThreads = threadRows.length - openThreads;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailMotion, setDetailMotion] = useState<ReviewDetailMotion>("neutral");
  const isDetailOverlay = useMediaQuery(REVIEW_DETAIL_OVERLAY_QUERY);
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
        const top = split.getBoundingClientRect().top;
        const next = Math.max(
          REVIEW_PANE_MIN_HEIGHT_PX,
          Math.floor(window.innerHeight - top - REVIEW_PANE_BOTTOM_GUTTER_PX),
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
  const detailTouchRef = useRef<{
    x: number;
    y: number;
    t: number;
    scroller: HTMLElement | null;
    scrollLeft: number;
  } | null>(null);
  const handleDetailTouchStart = useCallback(
    (e: TouchEvent<HTMLDivElement>) => {
      if (!detail || e.touches.length !== 1 || blocksDetailSwipe(e.target)) {
        detailTouchRef.current = null;
        return;
      }
      const touch = e.touches[0]!;
      const scroller = horizontalSwipeScroller(e.target);
      detailTouchRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        t: Date.now(),
        scroller,
        scrollLeft: scroller?.scrollLeft ?? 0,
      };
    },
    [detail],
  );
  const handleDetailTouchEnd = useCallback(
    (e: TouchEvent<HTMLDivElement>) => {
      const start = detailTouchRef.current;
      detailTouchRef.current = null;
      if (!start || e.changedTouches.length !== 1) return;
      const touch = e.changedTouches[0]!;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const elapsed = Date.now() - start.t;
      if (elapsed > REVIEW_DETAIL_SWIPE_MAX_MS) return;
      if (Math.abs(dx) < REVIEW_DETAIL_SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      if (start.scroller && scrollCanConsumeSwipe(start.scroller, start.scrollLeft, dx)) return;
      navigateDetail(dx < 0 ? "next" : "previous");
    },
    [navigateDetail],
  );
  const handleDetailTouchCancel = useCallback(() => {
    detailTouchRef.current = null;
  }, []);

  if (threadRows.length === 0) {
    return (
      <main className="reviews-page reviews-live">
        <div className="reviews-head">
          <h2>Reviews</h2>
          <span className="count">0 open threads</span>
          <span className="muted">{range.from} to {range.to}</span>
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
        <span className="muted">{resolvedThreads} resolved · {threadRows.length} total</span>
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
            title="Unresolved first, grouped by repo and the PR/MR each thread hangs off"
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
          style={{ "--live-row-height": `${REVIEW_ROW_HEIGHT_PX}px` } as CSSProperties}
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
              <ReviewDetailNav
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
