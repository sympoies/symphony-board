import type { CSSProperties } from "react";
import type { RepoMetricDTO, RepoMetricStatsDTO } from "@symphony-board/contract";
import { relativeTime, type ColorOf, type TimeRange } from "../model.ts";
import { Badge } from "./Badge.tsx";
import { SourceIcon } from "./SourceIcon.tsx";

function addMetricStats(target: RepoMetricStatsDTO, next: RepoMetricStatsDTO): RepoMetricStatsDTO {
  return {
    ...target,
    items_active: target.items_active + next.items_active,
    items_opened: target.items_opened + next.items_opened,
    items_closed: target.items_closed + next.items_closed,
    change_requests_opened: target.change_requests_opened + next.change_requests_opened,
    change_requests_closed: target.change_requests_closed + next.change_requests_closed,
    change_requests_merged: target.change_requests_merged + next.change_requests_merged,
    activities: target.activities + next.activities,
    commits: target.commits + next.commits,
    pushes: target.pushes + next.pushes,
    comments: target.comments + next.comments,
    reviews: target.reviews + next.reviews,
    approvals: target.approvals + next.approvals,
    edge_declared: target.edge_declared + next.edge_declared,
    edge_fulfilled: target.edge_fulfilled + next.edge_fulfilled,
    edge_broken: target.edge_broken + next.edge_broken,
  };
}

function zeroStats(): RepoMetricStatsDTO {
  return {
    items_active: 0,
    items_opened: 0,
    items_closed: 0,
    change_requests_opened: 0,
    change_requests_closed: 0,
    change_requests_merged: 0,
    activities: 0,
    commits: 0,
    pushes: 0,
    comments: 0,
    reviews: 0,
    approvals: 0,
    edge_declared: 0,
    edge_fulfilled: 0,
    edge_broken: 0,
    by_item_state: {},
    by_item_kind: {},
    by_activity_kind: {},
    by_activity_action: {},
    by_edge_type: {},
    by_edge_lifecycle: {},
    by_review_state: {},
    by_ci_state: {},
    by_merge_state: {},
    by_label_scope: {},
  };
}

function metricTrendValue(stats: RepoMetricStatsDTO): number {
  return stats.activities + stats.items_opened + stats.change_requests_merged;
}

function issuesOpened(stats: RepoMetricStatsDTO): number {
  return Math.max(0, stats.items_opened - stats.change_requests_opened);
}

function TrendBars({ metric }: { metric: RepoMetricDTO }) {
  const values = metric.series.map((point) => metricTrendValue(point.stats));
  const max = Math.max(1, ...values);
  const visible = values.slice(-16);
  return (
    <div className="repo-trend" aria-label="repo activity trend">
      {visible.map((value, index) => (
        <span
          key={`${index}-${value}`}
          className="repo-trend-bar"
          title={`${value} events`}
          style={{ "--bar-h": `${Math.max(10, Math.round((value / max) * 100))}%` } as CSSProperties}
        />
      ))}
    </div>
  );
}

function QualityBadge({ metric }: { metric: RepoMetricDTO }) {
  if (metric.data_quality.truncated) return <Badge text="truncated" kind="status-error" />;
  if (!metric.data_quality.activity_available) return <Badge text="limited" kind="status-partial" />;
  return <Badge text="activity" kind="status-ok" />;
}

function TopActors({ metric }: { metric: RepoMetricDTO }) {
  const actors = (metric.top_actors ?? []).slice(0, 3);
  if (actors.length === 0) return null;
  return (
    <span className="repo-actors">
      {actors.map((actor) => {
        const aliases = actor.aliases ?? [];
        const title = aliases.length
          ? `${actor.activities} activities (also ${aliases.join(", ")})`
          : `${actor.activities} activities`;
        return (
          <span key={actor.actor_key} title={title}>
            @{actor.display_name}
          </span>
        );
      })}
    </span>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="repo-stat-tile">
      <span className="stat-label">{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function RepoAnalyticsPage({
  metrics,
  windowTotal,
  range,
  sourceKind,
  colorOf,
}: {
  metrics: RepoMetricDTO[];
  windowTotal: number;
  range: TimeRange;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
}) {
  const totals = metrics.reduce((acc, metric) => addMetricStats(acc, metric.totals), zeroStats());
  const countLabel = metrics.length === windowTotal ? `${metrics.length} repos` : `${metrics.length} matches`;

  return (
    <main className="repo-analytics-page">
      <div className="repo-analytics-head">
        <h2>Repo Analytics</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">{range.from} to {range.to}</span>
      </div>
      <div className="repo-stat-grid">
        <StatTile label="issues opened" value={issuesOpened(totals)} />
        <StatTile label="PR/MRs opened" value={totals.change_requests_opened} />
        <StatTile label="total opened" value={totals.items_opened} />
        <StatTile label="closed / merged" value={totals.items_closed} />
        <StatTile label="merged PR/MRs" value={totals.change_requests_merged} />
        <StatTile label="reviews" value={totals.reviews} />
      </div>
      {metrics.length === 0 ? (
        <p className="empty">{windowTotal === 0 ? "No repo metrics in this range." : "No repo metrics match the current filters."}</p>
      ) : (
        <div className="repo-table-wrap">
          <table className="repo-table">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Trend</th>
                <th>Issues opened</th>
                <th>PR/MRs opened</th>
                <th>Total opened</th>
                <th>Closed / merged</th>
                <th>Merged PR/MRs</th>
                <th>Reviews</th>
                <th>Quality</th>
                <th>Actors</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => {
                const accentColor = colorOf(metric.source_id, metric.project_path);
                return (
                  <tr
                    key={`${metric.source_id}|${metric.project_path ?? ""}`}
                    className={accentColor ? "repo-row-accent" : ""}
                    style={{ "--repo-color": accentColor ?? undefined } as CSSProperties}
                  >
                    <td className="repo-name-cell">
                      <span className="repo-name-main">
                        <SourceIcon kind={sourceKind.get(metric.source_id)} />
                        <span>{metric.project_path ?? "(unknown repo)"}</span>
                      </span>
                      <span className="repo-name-meta">
                        {metric.source_id}
                        {metric.data_quality.observed_since ? ` · since ${relativeTime(metric.data_quality.observed_since)}` : ""}
                      </span>
                    </td>
                    <td><TrendBars metric={metric} /></td>
                    <td>{issuesOpened(metric.totals)}</td>
                    <td>{metric.totals.change_requests_opened}</td>
                    <td>{metric.totals.items_opened}</td>
                    <td>{metric.totals.items_closed}</td>
                    <td>{metric.totals.change_requests_merged}</td>
                    <td title={`${metric.totals.approvals} approved`}>{metric.totals.reviews}</td>
                    <td title={metric.data_quality.notes.join(" ") || undefined}><QualityBadge metric={metric} /></td>
                    <td><TopActors metric={metric} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
