import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ActivityDTO } from "@symphony-board/contract";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import {
  activityVirtualRange,
  commitBranches,
  commitMessage,
  commitSha,
  commitShortSha,
  relativeTime,
  type ColorOf,
  type CommitBranchOption,
  type CommitRepoOption,
  type TimeRange,
} from "../model.ts";

// A cross-provider commit log over ActivityDTO commit rows. It intentionally does
// not render GitHub-only badges such as Verified or check counts; only fields
// already present in the provider-neutral contract surface appear here.

const COMMIT_ROW_HEIGHT_PX = 92;
const COMMIT_ROW_HEIGHT_NARROW_PX = 152;
const COMMIT_DEFAULT_VIEWPORT_PX = 680;

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="5.2" y="3.2" width="7.6" height="9.6" rx="1.2" />
      <path d="M3.2 10.8H2.9A1.7 1.7 0 0 1 1.2 9.1V2.9A1.7 1.7 0 0 1 2.9 1.2h5.2a1.7 1.7 0 0 1 1.7 1.7v.3" />
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

function dateLabel(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed);
}

function dateKey(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown";
  return new Date(parsed).toISOString().slice(0, 10);
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
}: {
  commits: ActivityDTO[];
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  emptyMessage: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(COMMIT_DEFAULT_VIEWPORT_PX);
  const [rowHeight, setRowHeight] = useState(COMMIT_ROW_HEIGHT_PX);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const resetScroll = useCallback(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  useEffect(() => {
    resetScroll();
  }, [commits, resetScroll]);

  useEffect(() => {
    if (!copiedId) return;
    const timeout = window.setTimeout(() => setCopiedId(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [copiedId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const updateHeight = () => {
      setViewportHeight(el.clientHeight || COMMIT_DEFAULT_VIEWPORT_PX);
      setRowHeight(el.clientWidth <= 760 ? COMMIT_ROW_HEIGHT_NARROW_PX : COMMIT_ROW_HEIGHT_PX);
    };
    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, [commits.length]);

  const virtual = useMemo(
    () => activityVirtualRange({
      count: commits.length,
      scrollTop,
      viewportHeight,
      rowHeight,
      rowGap: 0,
    }),
    [commits.length, rowHeight, scrollTop, viewportHeight],
  );
  const visibleCommits = useMemo(() => commits.slice(virtual.start, virtual.end), [commits, virtual.start, virtual.end]);

  if (commits.length === 0) return <p className="empty">{emptyMessage}</p>;

  return (
    <div
      ref={listRef}
      className="commit-list"
      role="list"
      aria-label="Commits"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{ "--commit-row-height": `${rowHeight}px` } as CSSProperties}
    >
      <div className="commit-virtual-space" style={{ height: `${virtual.totalHeightPx}px` }}>
        {visibleCommits.map((commit, offset) => {
          const index = virtual.start + offset;
          const sha = commitSha(commit);
          const short = commitShortSha(commit);
          const branches = commitBranches(commit);
          const previous = commits[index - 1];
          const showDate = !previous || dateKey(previous.occurred_at) !== dateKey(commit.occurred_at);
          const accentColor = colorOf(commit.source_id, commit.project_path);
          const actor = commit.actor ? `@${commit.actor}` : "unknown author";
          return (
            <article
              key={commit.id}
              className={`commit-row${accentColor ? " commit-row-accent" : ""}`}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={commits.length}
              style={
                {
                  "--repo-color": accentColor ?? undefined,
                  transform: `translateY(${index * rowHeight}px)`,
                } as CSSProperties
              }
            >
              <div className="commit-date-slot">
                {showDate ? <span>Commits on {dateLabel(commit.occurred_at)}</span> : null}
              </div>
              <div className="commit-row-body">
                <div className="commit-row-main">
                  {commit.url ? (
                    <a className="commit-message-link" href={commit.url} target="_blank" rel="noopener noreferrer">
                      {commitMessage(commit)}
                    </a>
                  ) : (
                    <span className="commit-message-link commit-message-text">{commitMessage(commit)}</span>
                  )}
                  <div className="commit-row-meta">
                    <SourceIcon kind={sourceKind.get(commit.source_id)} />
                    <span>{actor} committed {relativeTime(commit.occurred_at)}</span>
                    {commit.project_path ? <span>{commit.project_path}</span> : null}
                    {branches.slice(0, 2).map((branch) => (
                      <span key={branch} className="commit-ref-chip">{branch}</span>
                    ))}
                  </div>
                </div>
                <div className="commit-row-actions">
                  {short ? <code className="commit-sha">{short}</code> : null}
                  <button
                    type="button"
                    className="commit-icon-button"
                    aria-label={sha ? `Copy commit hash ${short ?? sha}` : "Commit hash unavailable"}
                    title={sha ? (copiedId === commit.id ? "Copied" : "Copy commit hash") : "Commit hash unavailable"}
                    disabled={!sha}
                    onClick={() => {
                      if (!sha) return;
                      void copyToClipboard(sha).then(() => setCopiedId(commit.id));
                    }}
                  >
                    <CopyIcon />
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
  selectedRepo,
  selectedBranch,
  onRepo,
  onBranch,
  range,
  sourceKind,
  colorOf,
}: {
  commits: ActivityDTO[];
  windowTotal: number;
  totalCommits: number;
  repoOptions: CommitRepoOption[];
  branchOptions: CommitBranchOption[];
  selectedRepo: string | null;
  selectedBranch: string | null;
  onRepo: (repo: string | null) => void;
  onBranch: (branch: string | null) => void;
  range: TimeRange;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
}) {
  const countLabel =
    commits.length === windowTotal ? `${commits.length} in range` : `${commits.length} of ${windowTotal}`;
  const emptyMessage =
    windowTotal === 0
      ? "No commits in this range."
      : `No commits for ${selectedRepo ?? "this repo"} in this range.`;

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
        <div className="commits-filter">
          <RepoCombobox options={repoOptions} value={selectedRepo} onChange={onRepo} sourceKind={sourceKind} />
          <span className="muted commits-filter-hint">
            {repoOptions.length} repo{repoOptions.length === 1 ? "" : "s"} with commits
            {branchOptions.length > 0 ? ` · ${branchOptions.length} branch${branchOptions.length === 1 ? "" : "es"}` : ""}
          </span>
        </div>
      </div>
      <CommitTimeline commits={commits} sourceKind={sourceKind} colorOf={colorOf} emptyMessage={emptyMessage} />
    </main>
  );
}
