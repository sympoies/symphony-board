import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type TouchEvent } from "react";
import type { ActivityDTO, ActivityDailyDTO } from "@symphony-board/contract";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { CommitsRail } from "./CommitsRail.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { CommitsOverview } from "./CommitsOverview.tsx";
import { CommitDetail } from "./CommitDetail.tsx";
import { useListViewport } from "../useListViewport.ts";
import { useScrollbarGutter } from "../useScrollbarGutter.ts";
import { useContentPaneHeight } from "../useContentPaneHeight.ts";
import { useCommitFileStats } from "../useCommitFileStats.ts";
import { COMMIT_COMPACT_SPLIT_QUERY, NARROW_VIEWPORT_QUERY } from "../layout-tier.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { sourceDisplayName } from "../model.ts";
import { EMPTY_ACTOR_INDEX, type ActorIndex, type CommitAuthorOption } from "../rail-stats.ts";
import {
  buildCommitRows,
  activityKey,
  commitBranches,
  commitMessage,
  commitSha,
  commitShortSha,
  commitStats,
  commitVirtualRange,
  relativeTime,
  pluralize,
  COMMIT_DEFAULT_VIEWPORT_PX,
  COMMIT_ROW_BODY_HEIGHT_PX,
  COMMIT_ROW_BODY_HEIGHT_NARROW_PX,
  type ColorOf,
  type CommitBranchOption,
  type CommitRepoOption,
  type TimeRange,
} from "../model.ts";

// A cross-provider commit log over ActivityDTO commit rows. Only fields the
// contract carries for EVERY provider appear here, which is why there are no
// GitHub-only badges such as Verified or check counts — and why the `+`/`-`
// line counts do belong, since both providers report them (and the row simply
// shows none where they are unknown, see DiffStat). The row-layout /
// visible-window math lives in model.ts (buildCommitRows / commitVirtualRange);
// this file owns the rendering and the DOM measurement.

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="5.2" y="3.2" width="7.6" height="9.6" rx="1.2" />
      <path d="M3.2 10.8H2.9A1.7 1.7 0 0 1 1.2 9.1V2.9A1.7 1.7 0 0 1 2.9 1.2h5.2a1.7 1.7 0 0 1 1.7 1.7v.3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.4 3 3 6-6.8" />
    </svg>
  );
}

// GitHub's `ellipsis` octicon: a rounded box with three cut-out dots, used as the
// "show more / expand description" affordance on a commit row.
function EllipsisIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 5.75C0 4.784.784 4 1.75 4h12.5c.966 0 1.75.784 1.75 1.75v4.5A1.75 1.75 0 0 1 14.25 12H1.75A1.75 1.75 0 0 1 0 10.25Zm12 .75a1 1 0 1 0 0 2 1 1 0 0 0 0-2M8 6.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2M5 7.5a1 1 0 1 0-2 0 1 1 0 0 0 2 0" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m5.7 4-3.5 4 3.5 4" />
      <path d="m10.3 4 3.5 4-3.5 4" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="4" cy="3.6" r="1.6" />
      <circle cx="12" cy="12.4" r="1.6" />
      <circle cx="4" cy="12.4" r="1.6" />
      <path d="M4 5.2v5.6" />
      <path d="M5.6 3.6h2.8A3.6 3.6 0 0 1 12 7.2v3.6" />
    </svg>
  );
}

function AuthorIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="8" cy="5.2" r="2.6" />
      <path d="M2.8 13.4a5.2 5.2 0 0 1 10.4 0" />
    </svg>
  );
}

function dateLabel(iso: string, tz: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown date";
  // Pin to en-US so the label reads the same on every viewer's device instead
  // of inheriting the runtime locale (e.g. a zh-TW phone rendered "2026年7月7日").
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(parsed);
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);

  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    document.execCommand("copy");
    return Promise.resolve();
  } finally {
    document.body.removeChild(el);
  }
}

function CommitTimeline({
  commits,
  sourceKind,
  colorOf,
  empty,
  timezone,
  selectedKey,
  onSelect,
}: {
  commits: ActivityDTO[];
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  // Empty-state node rendered when there are no rows; falls back to a plain line.
  empty?: ReactNode;
  timezone: string;
  // Selection drives the detail pane in the rail slot. Kept as the activity key
  // rather than an index so it survives a re-filter that moves the row.
  selectedKey: string | null;
  onSelect: (commit: ActivityDTO) => void;
}) {
  const [rowBodyHeight, setRowBodyHeight] = useState(COMMIT_ROW_BODY_HEIGHT_PX);
  const [measuredBodyHeights, setMeasuredBodyHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [expandedBodyId, setExpandedBodyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Desktop rows are uniform single-line, so they keep the fixed row-body height
  // and skip per-row measurement; the narrow/portrait layout stacks variable
  // content and is measured so each card sizes to its content.
  const narrow = rowBodyHeight > COMMIT_ROW_BODY_HEIGHT_PX;

  // Scroll position, viewport height, and the scroll-to-top reset are shared
  // with the Activity feed. The commit list also derives its row-body height
  // from the container width (narrow = stacked layout) on every measure.
  const { listRef, scrollTop, viewportHeight, handleScroll } = useListViewport<HTMLDivElement>({
    defaultViewportPx: COMMIT_DEFAULT_VIEWPORT_PX,
    resetKey: commits,
    onMeasure: (el) =>
      setRowBodyHeight(el.clientWidth <= 760 ? COMMIT_ROW_BODY_HEIGHT_NARROW_PX : COMMIT_ROW_BODY_HEIGHT_PX),
  });
  // An empty result renders a paragraph instead of the list, so the element
  // this measures mounts late.
  const scrollbarPx = useScrollbarGutter(listRef, [commits.length === 0]);

  // A new `commits` array collapses any expanded body and drops measured row
  // heights (the hook above handles the scroll reset on the same trigger).
  useEffect(() => {
    setExpandedBodyId(null);
    setMeasuredBodyHeights(new Map());
  }, [commits]);

  // Width breakpoint flips the row layout, so any heights measured at the old
  // width no longer apply.
  useEffect(() => {
    setMeasuredBodyHeights(new Map());
  }, [rowBodyHeight]);

  useEffect(() => {
    if (!copiedId) return;
    const timeout = window.setTimeout(() => setCopiedId(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [copiedId]);

  const layout = useMemo(
    () => buildCommitRows({ commits, rowBodyHeight, expandedBodyId, measuredBodyHeights, timezone }),
    [commits, expandedBodyId, measuredBodyHeights, rowBodyHeight, timezone],
  );
  const virtual = useMemo(
    () => commitVirtualRange({
      rows: layout.rows,
      totalHeightPx: layout.totalHeightPx,
      scrollTop,
      viewportHeight,
    }),
    [layout, scrollTop, viewportHeight],
  );
  const visibleRows = useMemo(() => layout.rows.slice(virtual.start, virtual.end), [layout.rows, virtual.start, virtual.end]);

  // Measure each rendered narrow row's natural body height and feed it back into
  // the layout so cards size to content (no fixed blank space) while the list
  // stays virtualized. Desktop keeps the fixed height. Measurement is driven by
  // a ResizeObserver whose callback runs ASYNCHRONOUSLY — crucially decoupled
  // from the render cycle, so updating heights never re-enters a layout effect
  // and loops (React error #185). The functional update returns the previous map
  // unchanged when nothing moved, so the observer goes quiet once it settles.
  const measureObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const list = listRef.current;
      if (!list) return;
      const bodies = list.querySelectorAll<HTMLElement>(".commit-row-body[data-commit-id]");
      setMeasuredBodyHeights((previous) => {
        let next: Map<string, number> | null = null;
        bodies.forEach((el) => {
          const id = el.dataset.commitId;
          if (!id) return;
          const height = Math.ceil(el.getBoundingClientRect().height);
          if (height <= 0 || previous.get(id) === height) return;
          if (!next) next = new Map(previous);
          next.set(id, height);
        });
        return next ?? previous;
      });
    });
    measureObserverRef.current = observer;
    return () => {
      observer.disconnect();
      measureObserverRef.current = null;
    };
  }, [listRef]);

  // (Re)observe the currently rendered row bodies whenever the visible set
  // changes. This only sets up observation — it never calls setState — so it
  // cannot feed back into itself; the observer's async callback owns the height
  // updates. `disconnect()` first drops bodies that scrolled out (no leak).
  useLayoutEffect(() => {
    const observer = measureObserverRef.current;
    const list = listRef.current;
    if (!narrow || !observer || !list) return;
    observer.disconnect();
    list.querySelectorAll<HTMLElement>(".commit-row-body[data-commit-id]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [narrow, visibleRows, expandedBodyId, listRef]);

  if (commits.length === 0) return <>{empty ?? <p className="empty">No commits.</p>}</>;

  return (
    <div
      ref={listRef}
      className="commit-list"
      // The row HEIGHT is chosen from this container's width (onMeasure above),
      // so the layout that fills that height has to be chosen the same way. It
      // used to be a viewport media query, which disagreed with the measurement
      // at exactly the size the Commits column lands on in a desktop window: a
      // ~730px list inside a ~1900px viewport reserved the tall card and then
      // drew the one-line desktop meta into it, leaving ~56px of dead space
      // under three ellipsized facts.
      data-row-layout={narrow ? "stacked" : "inline"}
      role="list"
      aria-label="Commits"
      onScroll={handleScroll}
      style={
        {
          "--commit-row-body-height": `${rowBodyHeight}px`,
          // What the stylesheet pulls back out of the track so the gap beside
          // this list matches every other pane gap. See --list-scrollbar in
          // styles.css.
          "--list-scrollbar": `${scrollbarPx}px`,
        } as CSSProperties
      }
    >
      <div className="commit-virtual-space" style={{ height: `${virtual.totalHeightPx}px` }}>
        {visibleRows.map((row) => {
          const { commit, index, showDate, body, expanded } = row;
          const sha = commitSha(commit);
          const short = commitShortSha(commit);
          // Stable identity for this commit row (the contract dropped the redundant
          // activity `id` in 4.0.0; reconstruct it from source_id|external_id).
          const rowKey = activityKey(commit);
          const copied = copiedId === rowKey;
          const branches = commitBranches(commit);
          const accentColor = colorOf(commit.source_id, commit.project_path);
          const actor = commit.actor ? `@${commit.actor}` : "unknown author";
          return (
            <article
              key={rowKey}
              className={`commit-row${showDate ? " commit-row-has-date" : ""}${expanded ? " commit-row-expanded" : ""}${accentColor ? " commit-row-accent" : ""}${rowKey === selectedKey ? " commit-row-selected" : ""}`}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={commits.length}
              aria-current={rowKey === selectedKey ? "true" : undefined}
              // Selecting from the row background. The controls inside the row
              // (sha copy, provider link, body expander) each stop propagation,
              // so one click still does exactly one thing.
              //
              // The row carries tabIndex + Enter/Space itself rather than being
              // wrapped in a button: the detail pane is the only way to read a
              // full commit message, so a mouse-only path would put that behind
              // a pointer, and a <button> wrapper here would nest the row's own
              // interactive controls inside a button.
              tabIndex={0}
              onClick={() => onSelect(commit)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onSelect(commit);
              }}
              style={
                {
                  "--commit-row-height": `${row.height}px`,
                  "--repo-color": accentColor ?? undefined,
                  transform: `translateY(${row.offset}px)`,
                } as CSSProperties
              }
            >
              {showDate ? (
                <div className="commit-date-slot">
                  <span>Commits on {dateLabel(commit.occurred_at, timezone)}</span>
                </div>
              ) : null}
              <div className="commit-row-body" data-commit-id={rowKey}>
                <div className="commit-row-main">
                  <div className="commit-title-line">
                    {commit.url ? (
                      <a className="commit-message-link" href={commit.url} target="_blank" rel="noopener noreferrer">
                        {commitMessage(commit)}
                      </a>
                    ) : (
                      <span className="commit-message-link commit-message-text">{commitMessage(commit)}</span>
                    )}
                    {body ? (
                      <button
                        type="button"
                        className="commit-body-toggle"
                        aria-label={`${expanded ? "Hide" : "Show"} commit body ${short ?? index + 1}`}
                        aria-expanded={expanded}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedBodyId(expanded ? null : rowKey);
                        }}
                      >
                        <EllipsisIcon />
                      </button>
                    ) : null}
                  </div>
                  <div className="commit-row-meta">
                    {/* Grouped so the stacked layout can give each FACT its own
                        line: the provider mark belongs to the repo path, not to
                        whatever follows it. */}
                    <span className="commit-meta-repo">
                      <SourceRepo kind={sourceKind.get(commit.source_id)} repo={commit.project_path} />
                    </span>
                    <span className="commit-meta-who">{actor} committed {relativeTime(commit.occurred_at)}</span>
                    {branches.slice(0, 2).map((branch) => (
                      <span key={branch} className="commit-ref-chip">{branch}</span>
                    ))}
                  </div>
                  {expanded && body ? (
                    <div className="commit-body-panel">
                      <pre>{body}</pre>
                    </div>
                  ) : null}
                </div>
                <div className="commit-row-actions">
                  <DiffStat stats={commitStats(commit)} />
                  {short ? <code className="commit-sha">{short}</code> : null}
                  <button
                    type="button"
                    className={`commit-icon-button commit-copy-button${copied ? " is-copied" : ""}`}
                    aria-label={sha ? `Copy commit hash ${short ?? sha}` : "Commit hash unavailable"}
                    title={sha ? "Copy commit hash" : "Commit hash unavailable"}
                    disabled={!sha}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!sha) return;
                      void copyToClipboard(sha).then(() => setCopiedId(rowKey));
                    }}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? <span className="commit-copy-tooltip" role="status">Copied!</span> : null}
                  </button>
                  {commit.url ? (
                    <a
                      className="commit-icon-button"
                      href={commit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open commit"
                      title="Open commit"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <CodeIcon />
                    </a>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function CommitsPage({
  actorAvatars,
  commits,
  windowTotal,
  totalCommits,
  repoOptions,
  branchOptions,
  authorOptions,
  selectedSource,
  selectedRepo,
  selectedBranch,
  selectedAuthor,
  railRepoSource,
  railAuthorSource,
  railBranchSource,
  sourceOptions,
  activityDaily,
  actorIndex = EMPTY_ACTOR_INDEX,
  followLatest,
  onFollowLatest,
  fileStats,
  onRepo,
  onBranch,
  onAuthor,
  onSource,
  range,
  timezone,
  sourceKind,
  colorOf,
  emptyState,
}: {
  actorAvatars?: ReadonlyMap<string, string>;
  commits: ActivityDTO[];
  windowTotal: number;
  totalCommits: number;
  repoOptions: CommitRepoOption[];
  branchOptions: CommitBranchOption[];
  // Author options for the toolbar filter: the author facet source, merged
  // through the contract actor directory. Bots are kept — see
  // rail-stats.commitAuthorOptions.
  authorOptions: CommitAuthorOption[];
  selectedSource: string | null;
  selectedRepo: string | null;
  selectedBranch: string | null;
  selectedAuthor: string | null;
  // Facet sources for the digest rail: each already has every filter applied
  // except the one its own list drives.
  railRepoSource: ActivityDTO[];
  railAuthorSource: ActivityDTO[];
  railBranchSource: ActivityDTO[];
  // Every source id with a commit in the loaded window, for the source chips.
  // Commits filter on ONE source at a time (filterCommits compares source_id by
  // equality, and a repo pin carries its own source), so the chips select rather
  // than multi-select — unlike Activity's, which are a true facet set.
  sourceOptions: string[];
  // Full-history per-day/per-kind counts, for the trailing-12-month rhythm
  // calendar. The emitted activities[] is windowed and cannot reach that far.
  activityDaily: ActivityDailyDTO | null;
  // Contract actor directory as lookups, for the author ranking and count.
  actorIndex?: ActorIndex;
  followLatest: boolean;
  onFollowLatest: () => void;
  // Settings opt-in: ask the server for the selected commit's per-file
  // diffstat, rendered at the head of the digest rail. Off by default, because
  // it is one provider read per commit the pane shows.
  fileStats: boolean;
  onRepo: (repo: CommitRepoOption | null) => void;
  onBranch: (branch: string | null) => void;
  onAuthor: (author: string | null) => void;
  onSource: (source: string | null) => void;
  range: TimeRange;
  timezone: string;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  // Shared empty-state node, rendered in place of the timeline when empty.
  emptyState?: ReactNode;
}) {
  // Selection lives in the page, not the route: a commit is a transient thing to
  // read, unlike the repo/branch/author filters, which are shareable state. The
  // mode is explicit so clicking a row can pin it even while the device preference
  // remains enabled; only the release control returns the pane to auto-follow.
  const [detailMode, setDetailMode] = useState<
    | { kind: "closed" }
    | { kind: "hidden-following"; latestKey: string | null }
    | { kind: "following" }
    | { kind: "pinned"; key: string }
  >(() => (followLatest ? { kind: "following" } : { kind: "closed" }));
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const isCompactSplit = useMediaQuery(COMMIT_COMPACT_SPLIT_QUERY);
  const [mobileDetailRequested, setMobileDetailRequested] = useState(false);
  const [mobilePane, setMobilePane] = useState<"info" | "files">("info");
  const mobileDetailOpen = isNarrow && mobileDetailRequested;
  useEffect(() => {
    if (!isNarrow) {
      setMobileDetailRequested(false);
      setMobilePane("info");
    }
  }, [isNarrow]);
  const previousFollowLatest = useRef(followLatest);
  useEffect(() => {
    const previous = previousFollowLatest.current;
    previousFollowLatest.current = followLatest;
    if (previous === followLatest) return;
    setDetailMode((current) => {
      if (followLatest) {
        return current.kind === "closed" || current.kind === "hidden-following"
          ? { kind: "following" }
          : current;
      }
      if (current.kind === "hidden-following") return { kind: "closed" };
      if (current.kind !== "following") return current;
      const latest = commits[0];
      return latest ? { kind: "pinned", key: activityKey(latest) } : { kind: "closed" };
    });
  }, [commits, followLatest]);
  // A pin is valid only while its row remains visible. If a filter removes it,
  // resume the configured mode instead of retaining a stale hidden selection.
  useEffect(() => {
    if (detailMode.kind !== "pinned") return;
    if (commits.some((commit) => activityKey(commit) === detailMode.key)) return;
    setDetailMode(followLatest && commits.length > 0 ? { kind: "following" } : { kind: "closed" });
  }, [commits, detailMode, followLatest]);
  // Closing the pane hides it without cancelling the enabled preference. A new
  // first row (new data or a changed filter) makes that retained intent visible
  // again, matching the pre-pin follow behavior without reopening immediately.
  useEffect(() => {
    if (detailMode.kind !== "hidden-following" || !followLatest) return;
    const latest = commits[0];
    const latestKey = latest ? activityKey(latest) : null;
    if (latestKey !== detailMode.latestKey) {
      setDetailMode(latest ? { kind: "following" } : { kind: "hidden-following", latestKey: null });
    }
  }, [commits, detailMode, followLatest]);
  const selectedCommit = useMemo(() => {
    if (detailMode.kind === "following") return commits[0] ?? null;
    if (detailMode.kind === "pinned") {
      return commits.find((commit) => activityKey(commit) === detailMode.key) ?? null;
    }
    return null;
  }, [commits, detailMode]);
  const selectedKey = selectedCommit ? activityKey(selectedCommit) : null;
  const selectedIndex = commits.findIndex((commit) => activityKey(commit) === selectedKey);
  const navigateDetail = (direction: "previous" | "next") => {
    if (selectedIndex < 0) return;
    const commit = commits[selectedIndex + (direction === "next" ? 1 : -1)];
    if (commit) setDetailMode({ kind: "pinned", key: activityKey(commit) });
  };
  const detailTouchRef = useRef<{
    x: number; y: number; t: number; key: string;
    scroller: HTMLElement | null; scrollLeft: number;
  } | null>(null);
  const handleDetailTouchStart = (event: TouchEvent<HTMLElement>) => {
    detailTouchRef.current = null;
    const target = event.target;
    if (!selectedKey || event.touches.length !== 1 || !(target instanceof Element)) return;
    // Like Live, the entire open reader accepts swipes, including its blank
    // space. Outside the phone overlay, keep gestures in the detail column.
    if (!mobileDetailOpen && !target.closest(".commits-context, .commits-compact-support, .commit-files")) return;
    if (target.closest("a, button, input, textarea, select, summary, [role='button']")) return;
    const candidate = target.closest("table, pre");
    const scroller = candidate instanceof HTMLElement && candidate.scrollWidth > candidate.clientWidth + 2 ? candidate : null;
    const touch = event.touches[0]!;
    detailTouchRef.current = {
      x: touch.clientX, y: touch.clientY, t: Date.now(), key: selectedKey,
      scroller, scrollLeft: scroller?.scrollLeft ?? 0,
    };
  };
  const handleDetailTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = detailTouchRef.current;
    detailTouchRef.current = null;
    if (!start || start.key !== selectedKey || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0]!;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Date.now() - start.t > 1100 || Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    if (start.scroller) {
      const max = start.scroller.scrollWidth - start.scroller.clientWidth;
      if ((dx < 0 && start.scrollLeft < max - 2) || (dx > 0 && start.scrollLeft > 2)) return;
    }
    navigateDetail(dx < 0 ? "next" : "previous");
  };
  useEffect(() => {
    if (!selectedCommit) setMobileDetailRequested(false);
  }, [selectedCommit]);
  // Phone taps and the visible compact detail column include changed files.
  // Compact follow mode keeps those files in sync with its selected commit;
  // wider desktop rails still require the Settings opt-in.
  const changedFiles = useCommitFileStats(
    fileStats || mobileDetailOpen || (isCompactSplit && !!selectedCommit),
    selectedCommit?.source_id ?? null,
    selectedCommit?.project_path ?? null,
    selectedCommit ? commitSha(selectedCommit) : null,
  );
  const releasePin = () => {
    setDetailMode(commits.length > 0 ? { kind: "following" } : { kind: "closed" });
    onFollowLatest();
  };
  const closeDetail = () => {
    setMobileDetailRequested(false);
    setMobilePane("info");
    const latest = commits[0];
    setDetailMode(
      followLatest
        ? { kind: "hidden-following", latestKey: latest ? activityKey(latest) : null }
        : { kind: "closed" },
    );
  };
  const countLabel =
    commits.length === windowTotal ? `${commits.length} in range` : `${commits.length} of ${windowTotal}`;

  // The source, repo and branch SCM filters are rarely changed, so on
  // narrow/portrait they collapse behind a summary disclosure (same pattern as
  // the date range) and the commit feed gets the first screen. Desktop always
  // shows them. Foldable screens expand the inline toolbar on demand.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterSheetTab, setFilterSheetTab] = useState<"repo" | "branch" | "author">("repo");
  const activeFilterCount = (selectedRepo ? 1 : 0) + (selectedBranch ? 1 : 0) + (selectedSource ? 1 : 0) + (selectedAuthor ? 1 : 0);
  // The summary has to name every filter the count counts, or a pinned source
  // reads as "1 active" over the words "all repos · all branches".
  const filtersSummary =
    activeFilterCount === 0
      ? "all repos · all branches · all authors"
      : [
          selectedSource ? sourceDisplayName(selectedSource) : null,
          selectedRepo ?? "all repos",
          selectedBranch ?? "all branches",
          selectedAuthor ?? "all authors",
        ]
          .filter(Boolean)
          .join(" · ");
  const closeFiltersOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") setFiltersOpen(false);
  };
  const selectedRepoKey = selectedRepo ? `${selectedSource ?? ""}|${selectedRepo}` : null;
  // The commit list is the page's content pane: it fills the viewport below the
  // split instead of taking a fixed 74dvh, which on a 4K panel ran its last row
  // past the viewport bottom. Published on the split because its top is the
  // list's top; only .commit-list reads the var. See pane-height.ts.
  const { paneRef: splitPaneRef, paneHeightStyle } = useContentPaneHeight<HTMLDivElement>([
    commits.length,
    selectedKey,
  ]);
  useLayoutEffect(() => {
    if (isCompactSplit) {
      document.querySelector<HTMLElement>(".commits-compact-support")?.scrollTo(0, 0);
    }
    if (!mobileDetailOpen) return;
    const split = document.querySelector<HTMLElement>(".commits-split[data-mobile-detail-open='true']");
    split?.querySelector<HTMLElement>(".commits-context")?.scrollTo(0, 0);
    split?.querySelector<HTMLElement>(":scope > .commits-rail")?.scrollTo(0, 0);
    split?.querySelector<HTMLButtonElement>(".commit-mobile-back")?.focus({ preventScroll: true });
  }, [isCompactSplit, mobileDetailOpen, selectedKey]);
  // The same chip row Activity uses for its source facet, so switching tabs does
  // not switch filter idioms. Hidden when there is nothing to choose between
  // (a single-source board) unless one is already pinned by a drill-down, which
  // must stay visible and clearable.
  const sourceChips =
    sourceOptions.length > 1 || selectedSource ? (
      <div className="toggle-group commits-source-group">
        <span className="toggle-label">source</span>
        {[...new Set([...sourceOptions, ...(selectedSource ? [selectedSource] : [])])].map((id) => (
          <button
            key={id}
            type="button"
            className={`toggle${id === selectedSource ? " toggle-on" : ""}`}
            onClick={() => onSource(id === selectedSource ? null : id)}
            title={id}
          >
            {sourceDisplayName(id)}
          </button>
        ))}
      </div>
    ) : null;
  const filterBody = () => (
    <div className="commits-toolbar commits-toolbar-inline">
      {sourceChips}
      <div className="commits-filter">
        <RepoCombobox options={repoOptions} selectedSource={selectedSource} value={selectedRepo} onChange={onRepo} sourceKind={sourceKind} />
        <span className="muted commits-filter-hint">
          {repoOptions.length} {pluralize(repoOptions.length, "repo")} with commits
          {branchOptions.length > 0 ? ` · ${branchOptions.length} ${pluralize(branchOptions.length, "branch", "branches")}` : ""}
        </span>
      </div>
      <label className="commit-branch-select">
        <BranchIcon />
        <select
          aria-label="Filter commits by branch"
          value={selectedBranch ?? ""}
          disabled={branchOptions.length === 0}
          onChange={(event) => onBranch(event.target.value || null)}
        >
          <option value="">All branches</option>
          {selectedBranch && !branchOptions.some((option) => option.branch === selectedBranch) ? (
            <option value={selectedBranch}>{selectedBranch}</option>
          ) : null}
          {branchOptions.map((option) => (
            <option key={option.branch} value={option.branch}>
              {option.branch} ({option.count})
            </option>
          ))}
        </select>
      </label>
      {/* Author, the third SCM filter the route has always carried. Until now
          only the digest rail could set it, which left it unreachable wherever
          the rail is a sheet — and unfindable even on desktop, since nothing
          named it. Same shape as the branch select so the two read as a pair. */}
      <label className="commit-author-select">
        <AuthorIcon />
        <select
          aria-label="Filter commits by author"
          value={selectedAuthor ?? ""}
          // Never disabled while an author is pinned. The options are the facet
          // source, and a repo pin can empty it of the very author being
          // filtered on — disabling then would strand the filter with no way to
          // clear it from the control that shows it.
          disabled={authorOptions.length === 0 && !selectedAuthor}
          onChange={(event) => onAuthor(event.target.value || null)}
        >
          <option value="">All authors</option>
          {/* A route can name an author the current facet source no longer
              contains (a shared link, or a repo pin that excludes them). Keep
              it selectable so the control still shows what is being filtered
              instead of silently snapping back to "All authors". */}
          {selectedAuthor && !authorOptions.some((option) => option.author === selectedAuthor) ? (
            <option value={selectedAuthor}>{selectedAuthor}</option>
          ) : null}
          {authorOptions.map((option) => (
            <option key={option.author} value={option.author}>
              {option.author} ({option.count})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
  const repoFilterSection = () => (
    <div className="commit-filter-section" data-panel="repo">
      <div className="commit-filter-section-head">
        <strong>Repo</strong>
        <span className="muted">
          {repoOptions.length} {pluralize(repoOptions.length, "repo")}
        </span>
      </div>
      <div className="commit-filter-option-list">
        <button
          type="button"
          className={`commit-filter-option${selectedRepo ? "" : " is-selected"}`}
          data-kind="repo-all"
          aria-pressed={!selectedRepo}
          onClick={() => onRepo(null)}
        >
          <span className="commit-filter-option-main">All repos</span>
          <span className="commit-filter-option-meta">{windowTotal} {pluralize(windowTotal, "commit")}</span>
        </button>
        {repoOptions.map((option) => {
          const key = `${option.source_id}|${option.project_path}`;
          const selected = key === selectedRepoKey;
          return (
            <button
              key={key}
              type="button"
              className={`commit-filter-option${selected ? " is-selected" : ""}`}
              data-kind="repo"
              aria-pressed={selected}
              onClick={() => onRepo(option)}
            >
              <span className="commit-filter-option-main">{option.project_path}</span>
              <span className="commit-filter-option-meta">
                {option.count} {pluralize(option.count, "commit")} · {sourceKind.get(option.source_id) ?? option.source_id}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
  const branchFilterSection = () => (
    <div className="commit-filter-section commit-filter-section-branch" data-panel="branch">
      <div className="commit-filter-section-head">
        <strong>Branch</strong>
        <span className="muted">
          {branchOptions.length} {pluralize(branchOptions.length, "branch", "branches")}
        </span>
      </div>
      <div className="commit-filter-option-list">
        <button
          type="button"
          className={`commit-filter-option${selectedBranch ? "" : " is-selected"}`}
          data-kind="branch-all"
          aria-pressed={!selectedBranch}
          onClick={() => onBranch(null)}
          disabled={branchOptions.length === 0}
        >
          <span className="commit-filter-option-main">All branches</span>
          <span className="commit-filter-option-meta">{windowTotal} {pluralize(windowTotal, "commit")}</span>
        </button>
        {selectedBranch && !branchOptions.some((option) => option.branch === selectedBranch) ? (
          <button
            type="button"
            className="commit-filter-option is-selected"
            data-kind="branch"
            aria-pressed="true"
            onClick={() => onBranch(selectedBranch)}
          >
            <span className="commit-filter-option-main">{selectedBranch}</span>
            <span className="commit-filter-option-meta">selected</span>
          </button>
        ) : null}
        {branchOptions.map((option) => (
          <button
            key={option.branch}
            type="button"
            className={`commit-filter-option${option.branch === selectedBranch ? " is-selected" : ""}`}
            data-kind="branch"
            aria-pressed={option.branch === selectedBranch}
            onClick={() => onBranch(option.branch)}
          >
            <span className="commit-filter-option-main">{option.branch}</span>
            <span className="commit-filter-option-meta">
              {option.count} {pluralize(option.count, "commit")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
  const authorFilterSection = () => (
    <div className="commit-filter-section commit-filter-section-author" data-panel="author">
      <div className="commit-filter-section-head">
        <strong>Author</strong>
        <span className="muted">
          {authorOptions.length} {pluralize(authorOptions.length, "author")}
        </span>
      </div>
      <div className="commit-filter-option-list">
        <button
          type="button"
          className={`commit-filter-option${selectedAuthor ? "" : " is-selected"}`}
          data-kind="author-all"
          aria-pressed={!selectedAuthor}
          onClick={() => onAuthor(null)}
          // Same reason as the toolbar select: clearing must stay reachable
          // when the facet source no longer contains the pinned author.
          disabled={authorOptions.length === 0 && !selectedAuthor}
        >
          <span className="commit-filter-option-main">All authors</span>
          <span className="commit-filter-option-meta">{windowTotal} {pluralize(windowTotal, "commit")}</span>
        </button>
        {selectedAuthor && !authorOptions.some((option) => option.author === selectedAuthor) ? (
          <button
            type="button"
            className="commit-filter-option is-selected"
            data-kind="author"
            aria-pressed="true"
            onClick={() => onAuthor(selectedAuthor)}
          >
            <span className="commit-filter-option-main">{selectedAuthor}</span>
            <span className="commit-filter-option-meta">selected</span>
          </button>
        ) : null}
        {authorOptions.map((option) => (
          <button
            key={option.author}
            type="button"
            className={`commit-filter-option${option.author === selectedAuthor ? " is-selected" : ""}`}
            data-kind="author"
            aria-pressed={option.author === selectedAuthor}
            onClick={() => onAuthor(option.author)}
          >
            <span className="commit-filter-option-main">{option.author}</span>
            <span className="commit-filter-option-meta">
              {option.count} {pluralize(option.count, "commit")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
  const filterSheetBody = () => (
    <div className="commits-filter-sheet-body" data-active-filter={filterSheetTab}>
      <div className="commit-filter-sheet-tabs" role="tablist" aria-label="Commit filters">
        {/* Repo, branch, author — the order the inline toolbar uses, and the
            order the sheet opens in. The digest rail leads with authors
            instead, because it RANKS people rather than offering filters. */}
        <button
          type="button"
          className="commit-filter-sheet-tab"
          role="tab"
          aria-selected={filterSheetTab === "repo"}
          onClick={() => setFilterSheetTab("repo")}
        >
          Repo
        </button>
        <button
          type="button"
          className="commit-filter-sheet-tab"
          role="tab"
          aria-selected={filterSheetTab === "branch"}
          onClick={() => setFilterSheetTab("branch")}
        >
          Branch
        </button>
        <button
          type="button"
          className="commit-filter-sheet-tab"
          role="tab"
          aria-selected={filterSheetTab === "author"}
          onClick={() => setFilterSheetTab("author")}
        >
          Author
        </button>
      </div>
      {sourceChips}
      {filterSheetTab === "repo" ? repoFilterSection() : filterSheetTab === "branch" ? branchFilterSection() : authorFilterSection()}
    </div>
  );

  const detailNavigation = selectedCommit ? (
    <nav className="commit-detail-nav live-detail-nav" aria-label="Browse commits">
      <button type="button" className="live-detail-nav-button" aria-label="Show newer commit" disabled={selectedIndex <= 0} onClick={() => navigateDetail("previous")}>← Newer</button>
      <span className="live-detail-nav-count" aria-live="polite">{selectedIndex + 1} / {commits.length}</span>
      <button type="button" className="live-detail-nav-button" aria-label="Show older commit" disabled={selectedIndex < 0 || selectedIndex >= commits.length - 1} onClick={() => navigateDetail("next")}>Older →</button>
    </nav>
  ) : null;

  const supportPanes = (
    <>
        {/* Middle column. Keep the range overview mounted as the persistent
            context for the page; a selected commit is inserted before it so
            the original pane moves down intact. */}
        <div className="commits-context">
          {selectedCommit ? (
            <CommitDetail
              commit={selectedCommit}
              timezone={timezone}
              sourceKind={sourceKind}
              colorOf={colorOf}
              following={detailMode.kind === "following"}
              onFollowLatest={releasePin}
              onClose={closeDetail}
            />
          ) : null}
          {!mobileDetailOpen ? detailNavigation : null}
          <CommitsOverview commits={commits} activityDaily={activityDaily} timezone={timezone} range={range} actorIndex={actorIndex} />
        </div>
        {/* Third column: the ranked facets, always present. Unlike Activity's
            rail this is not gated on a wide breakpoint — the Commits page has
            only ever had one supporting column, so hiding it below the tier
            would take away what the page already showed; the stylesheet stacks
            it under the list instead. */}
        <CommitsRail
          avatarOf={actorAvatars}
          changedFiles={changedFiles}
          showOnlyChangedFiles={mobileDetailOpen || (isCompactSplit && !!selectedCommit)}
          commits={commits}
          repoSource={railRepoSource}
          authorSource={railAuthorSource}
          branchSource={railBranchSource}
          actorIndex={actorIndex}
          selectedRepo={selectedRepo}
          selectedSource={selectedSource}
          selectedAuthor={selectedAuthor}
          selectedBranch={selectedBranch}
          onRepo={onRepo}
          onAuthor={onAuthor}
          onBranch={onBranch}
        />
    </>
  );

  return (
    <main className="commits-page">
      <div className="activity-head">
        <h2>Commits</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          {windowTotal} window / {totalCommits} total · {range.from} to {range.to}
        </span>
      </div>
      <button
        type="button"
        className="filter-summary-disclosure commits-filter-disclosure"
        aria-expanded={filtersOpen}
        aria-controls={isNarrow ? "mobile-commits-filter-panel" : "inline-commits-filter-panel"}
        onClick={() => setFiltersOpen((open) => {
          if (!open) setFilterSheetTab("repo");
          return !open;
        })}
      >
        <span className="filter-summary-disclosure-label">filters</span>
        <span className="filter-summary-disclosure-summary">{filtersSummary}</span>
        <span className="filter-summary-disclosure-caret" aria-hidden="true" />
      </button>
      <div id="inline-commits-filter-panel" onKeyDown={closeFiltersOnEscape} hidden={isCompactSplit && !filtersOpen}>
        {filterBody()}
      </div>
      {isNarrow && filtersOpen ? (
        <>
          <button type="button" className="mobile-control-backdrop" aria-label="Close commit filters" onClick={() => setFiltersOpen(false)} />
          <div
            id="mobile-commits-filter-panel"
            className="mobile-control-sheet"
            data-panel="commits-filters"
            role="dialog"
            aria-modal="false"
            aria-labelledby="mobile-commits-filter-title"
            onKeyDown={closeFiltersOnEscape}
          >
            <div className="mobile-control-sheet-head">
              <strong id="mobile-commits-filter-title" className="mobile-control-sheet-title">Filters</strong>
              <button type="button" className="mobile-control-sheet-close" aria-label="Close commit filters" onClick={() => setFiltersOpen(false)}>
                ×
              </button>
            </div>
            {filterSheetBody()}
          </div>
        </>
      ) : null}
      <div
        className="commits-split"
        ref={splitPaneRef}
        style={paneHeightStyle}
        data-mobile-detail-open={mobileDetailOpen}
        data-mobile-pane={mobilePane}
        onTouchStart={handleDetailTouchStart}
        onTouchEnd={handleDetailTouchEnd}
        onTouchCancel={() => { detailTouchRef.current = null; }}
        role={mobileDetailOpen ? "dialog" : undefined}
        aria-modal={mobileDetailOpen ? true : undefined}
        aria-label={mobileDetailOpen ? "Commit information and changed files" : undefined}
        onKeyDown={(event) => {
          if (mobileDetailOpen && event.key === "Escape") closeDetail();
        }}
      >
        {mobileDetailOpen ? (
          <nav className="commit-mobile-pane-nav" aria-label="Commit panes">
            <button type="button" className="commit-mobile-back" onClick={closeDetail}>← Commits</button>
            <button type="button" aria-pressed={mobilePane === "info"} onClick={() => setMobilePane("info")}>Info</button>
            <button type="button" aria-pressed={mobilePane === "files"} onClick={() => setMobilePane("files")}>Files</button>
          </nav>
        ) : null}
        <CommitTimeline
          commits={commits}
          sourceKind={sourceKind}
          colorOf={colorOf}
          empty={emptyState}
          timezone={timezone}
          selectedKey={selectedKey}
          onSelect={(commit) => {
            const key = activityKey(commit);
            if (isNarrow) {
              if (selectedKey !== key) setDetailMode({ kind: "pinned", key });
              setMobilePane("info");
              setMobileDetailRequested(true);
              return;
            }
            if (isCompactSplit && detailMode.kind === "following") setDetailMode({ kind: "pinned", key });
            else if (selectedKey === key) closeDetail();
            else setDetailMode({ kind: "pinned", key });
          }}
        />
        {isCompactSplit ? <div className="commits-compact-support">{supportPanes}</div> : supportPanes}
        {mobileDetailOpen ? detailNavigation : null}
      </div>
    </main>
  );
}
