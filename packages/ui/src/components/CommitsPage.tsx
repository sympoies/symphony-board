import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ActivityDTO } from "@symphony-board/contract";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { useListViewport } from "../useListViewport.ts";
import {
  buildCommitRows,
  commitBranches,
  commitMessage,
  commitSha,
  commitShortSha,
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

// A cross-provider commit log over ActivityDTO commit rows. It intentionally does
// not render GitHub-only badges such as Verified or check counts; only fields
// already present in the provider-neutral contract surface appear here. The
// row-layout / visible-window math lives in model.ts (buildCommitRows /
// commitVirtualRange); this file owns the rendering and the DOM measurement.

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

function dateLabel(iso: string, tz: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(parsed);
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
  emptyMessage,
  timezone,
}: {
  commits: ActivityDTO[];
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  emptyMessage: string;
  timezone: string;
}) {
  const [rowBodyHeight, setRowBodyHeight] = useState(COMMIT_ROW_BODY_HEIGHT_PX);
  const expandedRowBodyRef = useRef<HTMLDivElement | null>(null);
  const [measuredExpandedBodyHeights, setMeasuredExpandedBodyHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [expandedBodyId, setExpandedBodyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Scroll position, viewport height, and the scroll-to-top reset are shared
  // with the Activity feed. The commit list also derives its row-body height
  // from the container width (narrow = stacked layout) on every measure.
  const { listRef, scrollTop, viewportHeight, handleScroll } = useListViewport<HTMLDivElement>({
    defaultViewportPx: COMMIT_DEFAULT_VIEWPORT_PX,
    resetKey: commits,
    onMeasure: (el) =>
      setRowBodyHeight(el.clientWidth <= 760 ? COMMIT_ROW_BODY_HEIGHT_NARROW_PX : COMMIT_ROW_BODY_HEIGHT_PX),
  });

  // A new `commits` array collapses any expanded body and drops measured row
  // heights (the hook above handles the scroll reset on the same trigger).
  useEffect(() => {
    setExpandedBodyId(null);
    setMeasuredExpandedBodyHeights(new Map());
  }, [commits]);

  useEffect(() => {
    setMeasuredExpandedBodyHeights(new Map());
  }, [rowBodyHeight]);

  useEffect(() => {
    if (!copiedId) return;
    const timeout = window.setTimeout(() => setCopiedId(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [copiedId]);

  useLayoutEffect(() => {
    const el = expandedRowBodyRef.current;
    if (!el || !expandedBodyId) return;

    const updateHeight = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height <= 0) return;
      setMeasuredExpandedBodyHeights((previous) => {
        if (previous.get(expandedBodyId) === height) return previous;
        const next = new Map(previous);
        next.set(expandedBodyId, height);
        return next;
      });
    };
    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, [expandedBodyId, rowBodyHeight]);

  const layout = useMemo(
    () => buildCommitRows({ commits, rowBodyHeight, expandedBodyId, measuredExpandedBodyHeights, timezone }),
    [commits, expandedBodyId, measuredExpandedBodyHeights, rowBodyHeight, timezone],
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

  if (commits.length === 0) return <p className="empty">{emptyMessage}</p>;

  return (
    <div
      ref={listRef}
      className="commit-list"
      role="list"
      aria-label="Commits"
      onScroll={handleScroll}
      style={
        {
          "--commit-row-body-height": `${rowBodyHeight}px`,
        } as CSSProperties
      }
    >
      <div className="commit-virtual-space" style={{ height: `${virtual.totalHeightPx}px` }}>
        {visibleRows.map((row) => {
          const { commit, index, showDate, body, expanded } = row;
          const sha = commitSha(commit);
          const short = commitShortSha(commit);
          const copied = copiedId === commit.id;
          const branches = commitBranches(commit);
          const accentColor = colorOf(commit.source_id, commit.project_path);
          const actor = commit.actor ? `@${commit.actor}` : "unknown author";
          return (
            <article
              key={commit.id}
              className={`commit-row${showDate ? " commit-row-has-date" : ""}${expanded ? " commit-row-expanded" : ""}${accentColor ? " commit-row-accent" : ""}`}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={commits.length}
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
              <div className="commit-row-body" ref={expanded ? expandedRowBodyRef : undefined}>
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
                        onClick={() => setExpandedBodyId(expanded ? null : commit.id)}
                      >
                        <EllipsisIcon />
                      </button>
                    ) : null}
                  </div>
                  <div className="commit-row-meta">
                    <SourceRepo kind={sourceKind.get(commit.source_id)} repo={commit.project_path} />
                    <span>{actor} committed {relativeTime(commit.occurred_at)}</span>
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
                  {short ? <code className="commit-sha">{short}</code> : null}
                  <button
                    type="button"
                    className={`commit-icon-button commit-copy-button${copied ? " is-copied" : ""}`}
                    aria-label={sha ? `Copy commit hash ${short ?? sha}` : "Commit hash unavailable"}
                    title={sha ? "Copy commit hash" : "Commit hash unavailable"}
                    disabled={!sha}
                    onClick={() => {
                      if (!sha) return;
                      void copyToClipboard(sha).then(() => setCopiedId(commit.id));
                    }}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? <span className="commit-copy-tooltip" role="status">Copied!</span> : null}
                  </button>
                  {commit.url ? (
                    <a className="commit-icon-button" href={commit.url} target="_blank" rel="noopener noreferrer" aria-label="Open commit" title="Open commit">
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
  commits,
  windowTotal,
  totalCommits,
  repoOptions,
  branchOptions,
  selectedSource,
  selectedRepo,
  selectedBranch,
  onRepo,
  onBranch,
  range,
  timezone,
  sourceKind,
  colorOf,
}: {
  commits: ActivityDTO[];
  windowTotal: number;
  totalCommits: number;
  repoOptions: CommitRepoOption[];
  branchOptions: CommitBranchOption[];
  selectedSource: string | null;
  selectedRepo: string | null;
  selectedBranch: string | null;
  onRepo: (repo: CommitRepoOption | null) => void;
  onBranch: (branch: string | null) => void;
  range: TimeRange;
  timezone: string;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
}) {
  const countLabel =
    commits.length === windowTotal ? `${commits.length} in range` : `${commits.length} of ${windowTotal}`;
  const emptyMessage =
    windowTotal === 0
      ? "No commits in this range."
      : `No commits for ${selectedRepo ? `${selectedSource ? `${selectedSource} / ` : ""}${selectedRepo}` : "this repo"} in this range.`;

  return (
    <main className="commits-page">
      <div className="activity-head">
        <h2>Commits</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          {windowTotal} window / {totalCommits} total · {range.from} to {range.to}
        </span>
      </div>
      <div className="commits-toolbar">
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
      </div>
      <CommitTimeline commits={commits} sourceKind={sourceKind} colorOf={colorOf} emptyMessage={emptyMessage} timezone={timezone} />
    </main>
  );
}
