import { useState, type CSSProperties, type ReactNode } from "react";
import type { RepoMetricDTO, RepoMetricStatsDTO } from "@symphony-board/contract";
import { relativeTime, repoCoverage, repoTrend, sourceDisplayName, type ColorOf, type RepoCoverage, type TimeRange } from "../model.ts";
import { activityDrilldownHref, commitsDrilldownHref, reviewThreadsHref, type ItemRouteFields } from "../nav.ts";
import { Badge } from "./Badge.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import { StatTile } from "./StatTile.tsx";

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
    activity_score: (target.activity_score ?? 0) + (next.activity_score ?? 0),
    commits: target.commits + next.commits,
    pushes: target.pushes + next.pushes,
    comments: target.comments + next.comments,
    reviews: target.reviews + next.reviews,
    approvals: target.approvals + next.approvals,
    unresolved_review_threads: (target.unresolved_review_threads ?? 0) + (next.unresolved_review_threads ?? 0),
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
    activity_score: 0,
    commits: 0,
    pushes: 0,
    comments: 0,
    reviews: 0,
    approvals: 0,
    unresolved_review_threads: 0,
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

function issuesOpened(stats: RepoMetricStatsDTO): number {
  return Math.max(0, stats.items_opened - stats.change_requests_opened);
}

function activityScore(stats: RepoMetricStatsDTO): number {
  return stats.activity_score ?? 0;
}

function displayScore(value: number): number {
  return Math.round(value);
}

// Both drill-downs go through nav.ts so the link a metric cell points at and the
// filters the destination renders stay in lockstep. The Activity feed reflects
// kind/action/source/repo as active chips; the Commits page reads source/repo in
// its own repo combobox.
function activityHref(metric: RepoMetricDTO, range: TimeRange, filter: { kind?: string; action?: string } = {}, lens?: ItemRouteFields): string | null {
  if (!metric.project_path) return null;
  return activityDrilldownHref({ source: metric.source_id, repo: metric.project_path, range, kind: filter.kind, action: filter.action, item: lens });
}

function commitsHref(metric: RepoMetricDTO, range: TimeRange, lens?: ItemRouteFields): string | null {
  if (!metric.project_path) return null;
  return commitsDrilldownHref({ source: metric.source_id, repo: metric.project_path, range, item: lens });
}

// Review-thread drill-downs go to the Reviews tab. `threads` means every
// synced thread for the repo; `unresolved` keeps the actionable open subset.
function reviewThreadHref(metric: RepoMetricDTO, range: TimeRange, value: "threads" | "unresolved"): string | null {
  return reviewThreadsHref({ source: metric.source_id, repo: metric.project_path, range, value });
}

function MetricValue({ value, href, label }: { value: number; href: string | null; label: string }) {
  return value > 0 && href ? (
    <a className="repo-metric-link" href={href} aria-label={label}>
      {value}
    </a>
  ) : (
    <>{value}</>
  );
}

function TrendBars({ metric }: { metric: RepoMetricDTO }) {
  const trend = repoTrend(metric.series);
  // An idle / no-activity repo draws a single continuous baseline rather than a
  // row of clamped min-height bars (which reads as a blank, broken dashed line).
  if (trend.flat) {
    return (
      <div className="repo-trend repo-trend-flat" aria-label="repo activity trend">
        <span className="repo-trend-baseline" title="0 activity" />
      </div>
    );
  }
  return (
    <div className="repo-trend" aria-label="repo activity trend">
      {trend.bars.map((bar, index) => (
        <span
          key={`${index}-${bar.value}`}
          className="repo-trend-bar"
          title={`${displayScore(bar.value)} activity`}
          style={{ "--bar-h": `${bar.height}%` } as CSSProperties}
        />
      ))}
    </div>
  );
}

// Coverage verdict -> badge text, hue, and a one-line "why". `partial`/`stale`
// stay quiet visually (a dormant or recently-onboarded repo is not a fault),
// while the data-gap states use the warning hue. `ok` is the green default.
const COVERAGE_BADGE: Record<RepoCoverage, { text: string; kind: string; hint: string }> = {
  ok: { text: "active", kind: "status-ok", hint: "" },
  partial: {
    text: "partial",
    kind: "status-partial",
    hint: "Activity coverage starts inside this window; counts before then are missing, not zero.",
  },
  stale: {
    text: "idle",
    kind: "status-idle",
    hint: "No activity in this window; the repo was last active earlier.",
  },
  no_activity: {
    text: "no data",
    kind: "status-partial",
    hint: "No activity rows observed; commit, push, comment, and review metrics may be incomplete.",
  },
};

function QualityBadge({ metric }: { metric: RepoMetricDTO }) {
  const { text, kind, hint } = COVERAGE_BADGE[repoCoverage(metric)];
  const title = [hint, ...metric.data_quality.notes].filter(Boolean).join(" ") || undefined;
  return <Badge text={text} kind={kind} title={title} />;
}

function TopActors({ metric }: { metric: RepoMetricDTO }) {
  const actors = (metric.top_actors ?? []).slice(0, 3);
  // An idle repo (no ranked actors) still draws a muted middle-dot placeholder so
  // the Actors column reads as an intentional "no data" cell rather than a blank
  // gap — matching the 0s the metric columns show and the flat baseline the
  // TREND column draws for the same idle rows. Theme-agnostic (uses --muted).
  if (actors.length === 0) {
    return (
      <span className="repo-actors repo-actors-empty" title="no actors in range" aria-label="no actors in range">
        ·
      </span>
    );
  }
  return (
    <span className="repo-actors">
      {actors.map((actor) => {
        const aliases = actor.aliases ?? [];
        const title = aliases.length
          ? `${actor.activities} activities (also ${aliases.join(", ")})`
          : `${actor.activities} activities`;
        return actor.profile_url ? (
          <a
            key={actor.actor_key}
            className="repo-actor-link"
            href={actor.profile_url}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            aria-label={`Open ${actor.display_name} profile on provider`}
          >
            @{actor.display_name}
          </a>
        ) : (
          <span key={actor.actor_key} title={title}>
            @{actor.display_name}
          </span>
        );
      })}
    </span>
  );
}

export function RepoAnalyticsPage({
  metrics,
  windowTotal,
  range,
  sourceKind,
  colorOf,
  lens,
  emptyState,
}: {
  metrics: RepoMetricDTO[];
  windowTotal: number;
  range: TimeRange;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  // The shared item lens to thread into the drill-down links, so a round-trip
  // back to the board/graph preserves the active facets (incl. the repo pin).
  lens?: ItemRouteFields;
  // Shared empty-state node, rendered in place of the table when empty.
  emptyState?: ReactNode;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const totals = metrics.reduce((acc, metric) => addMetricStats(acc, metric.totals), zeroStats());
  const countLabel = metrics.length === windowTotal ? `${metrics.length} repos` : `${metrics.length} matches`;
  const summaryLabel = `${displayScore(activityScore(totals))} activity · ${totals.commits} commits`;

  return (
    <main className="repo-analytics-page">
      <div className="repo-analytics-head">
        <h2>Metrics</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">{range.from} to {range.to}</span>
      </div>
      <button
        type="button"
        className="filter-summary-disclosure repo-stats-disclosure"
        aria-expanded={summaryOpen}
        aria-controls="repo-stat-grid"
        onClick={() => setSummaryOpen((open) => !open)}
      >
        <span className="filter-summary-disclosure-label">summary</span>
        <span className="filter-summary-disclosure-summary">{summaryLabel}</span>
        <span className="filter-summary-disclosure-caret" aria-hidden="true" />
      </button>
      <div id="repo-stat-grid" className="repo-stat-grid" data-stats-collapsed={!summaryOpen ? "true" : undefined}>
        <StatTile label="activity">{displayScore(activityScore(totals))}</StatTile>
        <StatTile label="commits">{totals.commits}</StatTile>
        <StatTile label="issues opened">{issuesOpened(totals)}</StatTile>
        <StatTile label="PR/MRs opened">{totals.change_requests_opened}</StatTile>
        <StatTile label="total opened">{totals.items_opened}</StatTile>
        <StatTile label="closed / merged">{totals.items_closed}</StatTile>
        <StatTile label="merged PR/MRs">{totals.change_requests_merged}</StatTile>
        <StatTile label="reviews">{totals.reviews}</StatTile>
        <StatTile label="open threads">{totals.unresolved_review_threads ?? 0}</StatTile>
      </div>
      {metrics.length === 0 ? (
        emptyState ?? (
          <p className="empty">{windowTotal === 0 ? "No repo metrics in this range." : "No repo metrics match the current filters."}</p>
        )
      ) : (
        <div className="repo-table-wrap">
          <table className="repo-table">
            <colgroup>
              <col className="repo-table-col-repo" />
              <col className="repo-table-col-trend" />
              {Array.from({ length: 9 }, (_, index) => (
                <col key={index} className="repo-table-col-metric" />
              ))}
              <col className="repo-table-col-quality" />
              <col className="repo-table-col-actors" />
            </colgroup>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Trend</th>
                <th>Activity</th>
                <th>Commits</th>
                <th>Issues</th>
                <th>PR/MRs</th>
                <th>Total</th>
                <th>Closed</th>
                <th>Merged</th>
                <th>Reviews</th>
                <th>Threads</th>
                <th>Quality</th>
                <th>Actors</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => {
                const accentColor = colorOf(metric.source_id, metric.project_path);
                const activeLabel = metric.data_quality.last_activity_at
                  ? ` · active ${relativeTime(metric.data_quality.last_activity_at)}`
                  : "";
                return (
                  <tr
                    key={`${metric.source_id}|${metric.project_path ?? ""}`}
                    className={accentColor ? "repo-row-accent" : ""}
                    style={{ "--repo-color": accentColor ?? undefined } as CSSProperties}
                  >
                    <td className="repo-name-cell" data-label="Repo">
                      <span className="repo-name-head">
                        <span className="repo-name-main">
                          <SourceIcon kind={sourceKind.get(metric.source_id)} />
                          {metric.repo_url ? (
                            <a className="repo-provider-link" href={metric.repo_url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${metric.project_path ?? "repo"} on provider`}>
                              {metric.project_path ?? "(unknown repo)"}
                            </a>
                          ) : (
                            <span>{metric.project_path ?? "(unknown repo)"}</span>
                          )}
                        </span>
                        <span className="repo-mobile-quality">
                          <QualityBadge metric={metric} />
                        </span>
                      </span>
                      <span className="repo-name-meta" title={`${metric.source_id}${activeLabel}`}>
                        {sourceDisplayName(metric.source_id)}
                        {activeLabel}
                      </span>
                    </td>
                    <td className="repo-trend-cell" data-label="Trend"><TrendBars metric={metric} /></td>
                    <td className="repo-metric-cell repo-metric-primary" data-label="Activity"><MetricValue value={displayScore(activityScore(metric.totals))} href={activityHref(metric, range, {}, lens)} label={`Open activity for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-primary" data-label="Commits"><MetricValue value={metric.totals.commits} href={commitsHref(metric, range, lens)} label={`Open commits for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-secondary" data-label="Issues"><MetricValue value={issuesOpened(metric.totals)} href={activityHref(metric, range, { kind: "issue", action: "opened" }, lens)} label={`Open issue activity for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-primary" data-label="PR/MRs"><MetricValue value={metric.totals.change_requests_opened} href={activityHref(metric, range, { kind: "change_request", action: "opened" }, lens)} label={`Open change request activity for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-secondary" data-label="Total"><MetricValue value={metric.totals.items_opened} href={activityHref(metric, range, { action: "opened" }, lens)} label={`Open opened item activity for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-secondary" data-label="Closed"><MetricValue value={metric.totals.items_closed} href={activityHref(metric, range, { action: "closed,merged" }, lens)} label={`Open closed or merged item activity for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-secondary" data-label="Merged"><MetricValue value={metric.totals.change_requests_merged} href={activityHref(metric, range, { kind: "change_request", action: "merged" }, lens)} label={`Open merged change request activity for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-secondary" data-label="Reviews" title={`${metric.totals.approvals} approved`}><MetricValue value={metric.totals.reviews} href={activityHref(metric, range, { kind: "review" }, lens)} label={`Open review activity for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-metric-cell repo-metric-primary" data-label="Threads" title="open review threads (resolvable, still unresolved)"><MetricValue value={metric.totals.unresolved_review_threads ?? 0} href={reviewThreadHref(metric, range, "unresolved")} label={`Open unresolved review threads for ${metric.project_path ?? "repo"}`} /></td>
                    <td className="repo-quality-cell" data-label="Quality"><QualityBadge metric={metric} /></td>
                    <td className="repo-actors-cell" data-label="Actors"><TopActors metric={metric} /></td>
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
