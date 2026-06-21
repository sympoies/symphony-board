import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { ItemDTO, RepoMetricDTO, RepoMetricStatsDTO, ReviewThreadDTO } from "@symphony-board/contract";
import {
  relativeTime,
  repoMetricMatches,
  sourceDisplayName,
  type ColorOf,
  type Filters,
  type TimeRange,
} from "../model.ts";
import { activityDrilldownHref, reviewThreadsHref, type ItemRouteFields } from "../nav.ts";
import { Badge } from "./Badge.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { StatTile } from "./StatTile.tsx";

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

function reviewSignal(stats: RepoMetricStatsDTO): number {
  return stats.unresolved_review_threads ?? 0;
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

function ReviewTrendBars({ metric }: { metric: RepoMetricDTO }) {
  const values = metric.series.map((point) => reviewSignal(point.stats));
  const max = Math.max(0, ...values);
  if (max <= 0) {
    return (
      <div className="review-trend review-trend-flat" aria-label="review thread trend">
        <span title="0 open threads" />
      </div>
    );
  }
  return (
    <div className="review-trend" aria-label="review thread trend">
      {values.map((value, index) => (
        <span
          key={`${index}-${value}`}
          title={`${value} open threads`}
          style={{ "--bar-h": `${Math.max(8, Math.round((value / max) * 100))}%` } as CSSProperties}
        />
      ))}
    </div>
  );
}

function ReviewMetricLink({ value, href, label }: { value: number; href: string | null; label: string }) {
  return value > 0 && href ? (
    <a className="repo-metric-link" href={href} aria-label={label}>
      {value}
    </a>
  ) : (
    <>{value}</>
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
    if (!byRepo.has(key) && reviewSignal(metric.totals) > 0) {
      byRepo.set(key, {
        source_id: metric.source_id,
        project_path: metric.project_path,
        total: 0,
        open: 0,
        resolved: 0,
        comments: 0,
        metric,
      });
    }
  }
  return [...byRepo.values()].sort((a, b) => b.open - a.open || b.total - a.total || a.source_id.localeCompare(b.source_id) || (a.project_path ?? "").localeCompare(b.project_path ?? ""));
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
  lens,
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
  lens?: ItemRouteFields;
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
  const summaries = useMemo(() => repoSummaries(threadRows, metrics, filters), [threadRows, metrics, filters]);

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
                    <col className="review-col-pr" />
                    <col className="review-col-small" />
                    <col className="review-col-location" />
                    <col className="review-col-preview" />
                    <col className="review-col-small" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Thread</th>
                      <th>Status</th>
                      <th>Location</th>
                      <th>Preview</th>
                      <th>Seen</th>
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
                          <td className="review-pr-cell" data-label="Thread">
                            <span className="review-pr-title">
                              <SourceIcon kind={sourceKind.get(thread.source_id)} />
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
                          <td data-label="Status">
                            <span className="review-state-stack">
                              {statusBadge(thread)}
                              {thread.resolved_by ? <span className="muted">@{thread.resolved_by}</span> : null}
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
                                  <p key={comment.id}>
                                    {comment.author ? <strong>@{comment.author}</strong> : null}
                                    <span>{comment.body ?? "(empty comment)"}</span>
                                  </p>
                                ))}
                                {thread.comments_total > thread.comments.length ? (
                                  <span className="muted">+{thread.comments_total - thread.comments.length} more comments</span>
                                ) : null}
                              </div>
                            )}
                          </td>
                          <td data-label="Seen">
                            <time title={thread.last_seen_at ?? undefined}>{relativeTime(thread.last_seen_at)}</time>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

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
                    const activityHref = summary.project_path
                      ? activityDrilldownHref({ source: summary.source_id, repo: summary.project_path, range, kind: "review", item: lens })
                      : null;
                    const threadsHref = reviewThreadsHref({ source: summary.source_id, repo: summary.project_path, range, value: "unresolved" });
                    const accentColor = colorOf(summary.source_id, summary.project_path);
                    return (
                      <article
                        key={`${summary.source_id}|${summary.project_path ?? ""}`}
                        className={`review-repo-row${accentColor ? " review-row-accent" : ""}`}
                        style={{ "--repo-color": accentColor ?? undefined } as CSSProperties}
                      >
                        <div className="review-repo-main">
                          <span className="review-repo-name">
                            <SourceIcon kind={sourceKind.get(summary.source_id)} />
                            <span>{summary.project_path ?? "(unknown repo)"}</span>
                          </span>
                          <span className="muted">{sourceDisplayName(summary.source_id)}</span>
                        </div>
                        {metric ? <ReviewTrendBars metric={metric} /> : <div className="review-trend review-trend-flat"><span title="No metric series" /></div>}
                        <dl className="review-repo-metrics">
                          <div>
                            <dt>open</dt>
                            <dd>
                              <ReviewMetricLink value={summary.open} href={threadsHref} label={`Open unresolved review threads for ${summary.project_path ?? "repo"}`} />
                            </dd>
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
                            <dd>
                              <ReviewMetricLink value={metric?.totals.reviews ?? 0} href={activityHref} label={`Open review activity for ${summary.project_path ?? "repo"}`} />
                            </dd>
                          </div>
                          <div>
                            <dt>changes</dt>
                            <dd>{metric ? changesRequested(metric.totals) : 0}</dd>
                          </div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
