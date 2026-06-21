import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ItemDTO, RepoMetricDTO, RepoMetricStatsDTO, ReviewThreadDTO } from "@symphony-board/contract";
import {
  relativeTime,
  repoMetricMatches,
  sourceDisplayName,
  type ColorOf,
  type Filters,
  type TimeRange,
} from "../model.ts";
import { reviewRepoSearchHref } from "../nav.ts";
import { Badge } from "./Badge.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { StatTile } from "./StatTile.tsx";

const Markdown = lazy(() => import("./Markdown.tsx"));

const MarkdownBody = memo(function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<span className="live-md-fallback review-md-preview">{text}</span>}>
      <Markdown className={className}>{text}</Markdown>
    </Suspense>
  );
});

const LazyMarkdownPreview = memo(function LazyMarkdownPreview({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const node = ref.current;
    if (visible || !node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: null, rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={ref}>
      {visible ? (
        <MarkdownBody text={text} className="live-md live-md-preview review-md-preview" />
      ) : (
        <span className="live-md-fallback review-md-preview">{text}</span>
      )}
    </div>
  );
});

interface ThreadRow {
  thread: ReviewThreadDTO;
  target: ItemDTO | null;
}

interface RepoThreadSummary {
  source_id: string;
  project_path: string | null;
  total: number;
  open: number;
  resolved: number;
  comments: number;
  metric: RepoMetricDTO | null;
}

function changesRequested(stats: RepoMetricStatsDTO): number {
  return stats.by_activity_action["changes_requested"] ?? 0;
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

function timestamp(value: string | null | undefined): number {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

function compareThreads(a: ThreadRow, b: ThreadRow): number {
  if (a.thread.is_resolved !== b.thread.is_resolved) return a.thread.is_resolved ? 1 : -1;
  const repo = (a.thread.project_path ?? "").localeCompare(b.thread.project_path ?? "");
  if (repo !== 0) return repo;
  const target = (b.thread.target_iid ?? 0) - (a.thread.target_iid ?? 0);
  if (target !== 0) return target;
  const path = (a.thread.path ?? "").localeCompare(b.thread.path ?? "");
  if (path !== 0) return path;
  return timestamp(b.thread.last_seen_at) - timestamp(a.thread.last_seen_at);
}

function lineLabel(thread: ReviewThreadDTO): string | null {
  if (!thread.path) return null;
  if (thread.start_line != null && thread.line != null && thread.start_line !== thread.line) {
    return `${thread.path}:${thread.start_line}-${thread.line}`;
  }
  if (thread.line != null) return `${thread.path}:${thread.line}`;
  return thread.path;
}

function statusBadge(thread: ReviewThreadDTO) {
  if (!thread.is_resolved) return <Badge text="unresolved" kind="status-error" />;
  if (thread.is_outdated) return <Badge text="outdated" kind="status-unknown" />;
  return <Badge text="resolved" kind="status-ok" />;
}

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

function ReviewThreadBars({ summary }: { summary: RepoThreadSummary }) {
  const values = [
    { key: "resolved", value: summary.resolved, title: `${summary.resolved} resolved threads` },
    { key: "open", value: summary.open, title: `${summary.open} open threads` },
  ];
  const max = Math.max(0, ...values.map((value) => value.value));
  if (max <= 0) {
    return (
      <div className="review-trend review-trend-flat" aria-label="review thread volume">
        <span title="0 threads" />
      </div>
    );
  }
  return (
    <div className="review-trend" aria-label="review thread volume" title={`${summary.total} threads`}>
      {values.map(({ key, value, title }) => (
        <span
          key={key}
          data-state={key}
          title={title}
          style={{ "--bar-h": value > 0 ? `${Math.max(10, Math.round((value / max) * 100))}%` : "0%" } as CSSProperties}
        />
      ))}
    </div>
  );
}

function repoKey(sourceId: string, projectPath: string | null): string {
  return JSON.stringify([sourceId, projectPath]);
}

function repoSummaries(rows: ThreadRow[], metrics: RepoMetricDTO[], filters: Filters): RepoThreadSummary[] {
  const metricByRepo = new Map(metrics.map((metric) => [repoKey(metric.source_id, metric.project_path), metric]));
  const byRepo = new Map<string, RepoThreadSummary>();
  for (const { thread } of rows) {
    const key = repoKey(thread.source_id, thread.project_path);
    let row = byRepo.get(key);
    if (!row) {
      row = {
        source_id: thread.source_id,
        project_path: thread.project_path,
        total: 0,
        open: 0,
        resolved: 0,
        comments: 0,
        metric: metricByRepo.get(key) ?? null,
      };
      byRepo.set(key, row);
    }
    row.total += 1;
    if (thread.is_resolved) row.resolved += 1;
    else row.open += 1;
    row.comments += thread.comments_total;
  }
  for (const metric of metrics) {
    if (!repoMetricMatches(metric, filters)) continue;
    const key = repoKey(metric.source_id, metric.project_path);
    const unresolved = metric.totals.unresolved_review_threads ?? 0;
    if (!byRepo.has(key) && unresolved > 0) {
      byRepo.set(key, {
        source_id: metric.source_id,
        project_path: metric.project_path,
        total: unresolved,
        open: unresolved,
        resolved: 0,
        comments: 0,
        metric,
      });
    }
  }
  return [...byRepo.values()].sort((a, b) => b.total - a.total || b.open - a.open || a.source_id.localeCompare(b.source_id) || (a.project_path ?? "").localeCompare(b.project_path ?? ""));
}

function reviewLens(filters: Filters): "threads" | "unresolved" | null {
  if (filters.reviews.has("unresolved")) return "unresolved";
  if (filters.reviews.has("threads")) return "threads";
  return null;
}

export function ReviewsPage({
  reviewThreads,
  windowItems,
  metrics,
  filters,
  itemsById,
  range,
  sourceKind,
  colorOf,
  emptyState,
}: {
  reviewThreads: ReviewThreadDTO[];
  windowItems: ItemDTO[];
  metrics: RepoMetricDTO[];
  filters: Filters;
  itemsById: ReadonlyMap<string, ItemDTO>;
  range: TimeRange;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  emptyState?: ReactNode;
}) {
  const windowById = useMemo(() => new Map(windowItems.map((item) => [item.id, item])), [windowItems]);
  const threadRows = useMemo(
    () =>
      reviewThreads
        .map((thread): ThreadRow => ({ thread, target: itemsById.get(thread.target_ref) ?? windowById.get(thread.target_ref) ?? null }))
        .filter((row) => threadMatches(row, filters))
        .sort(compareThreads),
    [reviewThreads, itemsById, windowById, filters],
  );
  const summaryRows = useMemo(() => {
    const summaryFilters = { ...filters, reviews: new Set<string>() };
    return reviewThreads
      .map((thread): ThreadRow => ({ thread, target: itemsById.get(thread.target_ref) ?? windowById.get(thread.target_ref) ?? null }))
      .filter((row) => threadMatches(row, summaryFilters))
      .sort(compareThreads);
  }, [reviewThreads, itemsById, windowById, filters]);
  const summaries = useMemo(() => repoSummaries(summaryRows, metrics, filters), [summaryRows, metrics, filters]);
  const activeReviewLens = reviewLens(filters);

  const openThreads = threadRows.filter((row) => !row.thread.is_resolved).length;
  const resolvedThreads = threadRows.length - openThreads;
  const outdatedThreads = threadRows.filter((row) => row.thread.is_outdated === true).length;
  const commentsTotal = threadRows.reduce((sum, row) => sum + row.thread.comments_total, 0);
  const previewComments = threadRows.reduce((sum, row) => sum + row.thread.comments.length, 0);
  const changeRequests = new Set(threadRows.map((row) => row.thread.target_ref)).size;
  const repos = new Set(threadRows.map((row) => repoKey(row.thread.source_id, row.thread.project_path))).size;
  const showEmpty = threadRows.length === 0 && summaries.length === 0;

  return (
    <main className="reviews-page">
      <div className="reviews-head">
        <h2>Reviews</h2>
        <span className="count">{openThreads} open threads</span>
        <span className="muted">{range.from} to {range.to}</span>
      </div>
      <div className="review-stat-grid">
        <StatTile label="open threads">{openThreads}</StatTile>
        <StatTile label="resolved threads">{resolvedThreads}</StatTile>
        <StatTile label="threaded PR/MRs">{changeRequests}</StatTile>
        <StatTile label="repos">{repos}</StatTile>
        <StatTile label="comments">{commentsTotal}</StatTile>
        <StatTile label="previewed">{previewComments}</StatTile>
        <StatTile label="outdated">{outdatedThreads}</StatTile>
        <StatTile label="total threads">{threadRows.length}</StatTile>
      </div>

      {showEmpty ? (
        emptyState ?? <p className="empty">No review threads match the current view.</p>
      ) : (
        <div className="reviews-layout">
          <aside className="review-side" aria-label="Review context">
            <section className="review-repo-section" aria-labelledby="review-repos-title">
              <div className="review-section-head">
                <h3 id="review-repos-title">Repo Breakdown</h3>
                <span className="muted">{summaries.length} repos</span>
              </div>
              {summaries.length === 0 ? (
                <p className="empty">No repo review threads in this range.</p>
              ) : (
                <div className="review-repo-list">
                  {summaries.map((summary) => {
                    const metric = summary.metric;
                    const repoHref = reviewRepoSearchHref({ source: summary.source_id, repo: summary.project_path, range, review: activeReviewLens });
                    const accentColor = colorOf(summary.source_id, summary.project_path);
                    const rowClass = `review-repo-row${accentColor ? " review-row-accent" : ""}`;
                    const rowStyle = { "--repo-color": accentColor ?? undefined } as CSSProperties;
                    const rowContent = (
                      <>
                        <div className="review-repo-main">
                          <span className="review-repo-name">
                            <SourceIcon kind={sourceKind.get(summary.source_id)} />
                            <span>{summary.project_path ?? "(unknown repo)"}</span>
                          </span>
                          <span className="muted">{sourceDisplayName(summary.source_id)}</span>
                        </div>
                        <ReviewThreadBars summary={summary} />
                        <dl className="review-repo-metrics">
                          <div>
                            <dt>threads</dt>
                            <dd>{summary.total}</dd>
                          </div>
                          <div>
                            <dt>open</dt>
                            <dd>{summary.open}</dd>
                          </div>
                          <div>
                            <dt>resolved</dt>
                            <dd>{summary.resolved}</dd>
                          </div>
                          <div>
                            <dt>comments</dt>
                            <dd>{summary.comments}</dd>
                          </div>
                          <div>
                            <dt>reviews</dt>
                            <dd>{metric?.totals.reviews ?? 0}</dd>
                          </div>
                          <div>
                            <dt>changes</dt>
                            <dd>{metric ? changesRequested(metric.totals) : 0}</dd>
                          </div>
                        </dl>
                      </>
                    );
                    return repoHref ? (
                      <a
                        key={`${summary.source_id}|${summary.project_path ?? ""}`}
                        href={repoHref}
                        className={rowClass}
                        style={rowStyle}
                        aria-label={`Search review threads in ${summary.project_path ?? "repo"}`}
                      >
                        {rowContent}
                      </a>
                    ) : (
                      <article
                        key={`${summary.source_id}|${summary.project_path ?? ""}`}
                        className={rowClass}
                        style={rowStyle}
                      >
                        {rowContent}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </aside>

          <section className="review-queue" aria-labelledby="review-queue-title">
            <div className="review-section-head">
              <h3 id="review-queue-title">Thread Inbox</h3>
              <span className="muted">{openThreads} unresolved / {resolvedThreads} resolved</span>
            </div>
            {threadRows.length === 0 ? (
              <p className="empty">No synced review-thread detail matches the current filters.</p>
            ) : (
              <div className="review-table-wrap">
                <table className="review-table">
                  <colgroup>
                    <col className="review-col-small" />
                    <col className="review-col-seen" />
                    <col className="review-col-pr" />
                    <col className="review-col-commenter" />
                    <col className="review-col-location" />
                    <col className="review-col-preview" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Seen</th>
                      <th>Thread</th>
                      <th>Commenter</th>
                      <th>Location</th>
                      <th>Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {threadRows.map(({ thread, target }) => {
                      const accentColor = colorOf(thread.source_id, thread.project_path);
                      const label = lineLabel(thread);
                      const title = thread.title ?? target?.title ?? "Untitled change request";
                      return (
                        <tr
                          key={thread.id}
                          className={accentColor ? "review-row-accent" : ""}
                          style={{ "--repo-color": accentColor ?? undefined } as CSSProperties}
                        >
                          <td data-label="Status">
                            <span className="review-state-stack">
                              {statusBadge(thread)}
                              {thread.resolved_by ? <span className="muted">@{thread.resolved_by}</span> : null}
                            </span>
                          </td>
                          <td data-label="Seen">
                            <time title={thread.last_seen_at ?? undefined}>{relativeTime(thread.last_seen_at)}</time>
                          </td>
                          <td className="review-pr-cell" data-label="Thread">
                            <span className="review-pr-title">
                              {thread.url ? (
                                <a href={thread.url} target="_blank" rel="noopener noreferrer">
                                  {thread.target_iid != null ? `#${thread.target_iid} ` : ""}
                                  {title}
                                </a>
                              ) : (
                                <span>
                                  {thread.target_iid != null ? `#${thread.target_iid} ` : ""}
                                  {title}
                                </span>
                              )}
                            </span>
                            <span className="review-pr-meta">
                              <SourceRepo kind={sourceKind.get(thread.source_id)} repo={thread.project_path} />
                              {target?.author ? <span>@{target.author}</span> : null}
                            </span>
                          </td>
                          <td data-label="Commenter">
                            <span className="review-commenter" title="First synced thread comment author; falls back to the PR/MR author">
                              {commentersLabel(thread, target)}
                            </span>
                          </td>
                          <td data-label="Location">
                            <span className="review-location">{label ?? "general discussion"}</span>
                          </td>
                          <td data-label="Preview">
                            {thread.comments.length === 0 ? (
                              <span className="muted">No synced comment preview.</span>
                            ) : (
                              <div className="review-comment-preview">
                                {thread.comments.slice(0, 2).map((comment) => (
                                  <div className="review-comment" key={comment.id}>
                                    {comment.author ? <strong>@{comment.author}</strong> : null}
                                    <LazyMarkdownPreview text={comment.body ?? "(empty comment)"} />
                                  </div>
                                ))}
                                {thread.comments_total > thread.comments.length ? (
                                  <span className="muted">+{thread.comments_total - thread.comments.length} more comments</span>
                                ) : null}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
