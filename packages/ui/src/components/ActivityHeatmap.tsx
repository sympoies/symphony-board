import { useMemo, useState, type CSSProperties } from "react";
import type { ActivityDTO } from "@symphony-board/contract";
import {
  buildActivityHeatmap,
  buildActivityTrend,
  sourceDisplayName,
  type ActivityTrend,
  type ActivityTrendBucket,
  type HeatmapCell,
  type TimeRange,
} from "../model.ts";

const WEEKDAY_LABELS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };
const LEVELS = [0, 1, 2, 3, 4] as const;
const TREND_W = 640;
const TREND_H = 170;
const TREND_PAD_X = 18;
const TREND_PAD_Y = 16;

const cellTip = (cell: HeatmapCell) =>
  `${cell.date} · ${cell.count.toLocaleString()} ${cell.count === 1 ? "event" : "events"}`;

function formatKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

function trendCoord(
  index: number,
  count: number,
  maxY: number,
  value: number,
): { x: number; y: number } {
  const spanX = TREND_W - TREND_PAD_X * 2;
  const spanY = TREND_H - TREND_PAD_Y * 2;
  const x = TREND_PAD_X + (count <= 1 ? spanX / 2 : (index / (count - 1)) * spanX);
  const y = TREND_H - TREND_PAD_Y - (maxY > 0 ? (value / maxY) * spanY : 0);
  return { x, y };
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} L ${points[0]!.x + 1} ${points[0]!.y}`;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function bucketLabel(bucket: ActivityTrendBucket): string {
  return bucket === "hour" ? "hour" : bucket === "day" ? "day" : bucket === "week" ? "week" : "month";
}

function rangeLabel(from: string, to: string): string {
  return from === to ? from : `${from} to ${to}`;
}

function ActivityTrendChart({
  trend,
}: {
  trend: ActivityTrend;
}) {
  const { points, bucket, total, maxCount, maxAverage, from, to } = trend;
  const maxY = Math.max(1, maxCount, maxAverage);
  const linePoints = points.map((point, index) => trendCoord(index, points.length, maxY, point.average));
  const rawPoints = points.map((point, index) => trendCoord(index, points.length, maxY, point.count));
  const path = smoothPath(linePoints);
  const dotStep = Math.max(1, Math.ceil(points.length / 120));
  const byLabel = bucketLabel(bucket);
  const selectedRange = rangeLabel(from, to);
  const axisStart = points[0]?.label ?? from;
  const axisEnd = points.at(-1)?.label ?? to;

  return (
    <section className="hm-trend" aria-label="Selected range activity trend" data-bucket={bucket}>
      <div className="hm-trend-head">
        <span>
          Selected range activity by {byLabel}
          <small>{selectedRange}</small>
        </span>
        <b>{total.toLocaleString()} events</b>
      </div>
      <svg className="hm-trend-chart" viewBox={`0 0 ${TREND_W} ${TREND_H}`} role="img">
        <title>
          Activity trend by {byLabel} from {from} to {to}
        </title>
        {[0.25, 0.5, 0.75].map((n) => (
          <line
            key={n}
            className="hm-trend-grid"
            x1={TREND_PAD_X}
            x2={TREND_W - TREND_PAD_X}
            y1={TREND_PAD_Y + n * (TREND_H - TREND_PAD_Y * 2)}
            y2={TREND_PAD_Y + n * (TREND_H - TREND_PAD_Y * 2)}
          />
        ))}
        {rawPoints.map((point, index) =>
          points[index]?.count && index % dotStep === 0 ? (
            <circle key={points[index]!.date} className="hm-trend-dot" cx={point.x} cy={point.y} r="2.2" />
          ) : null,
        )}
        <path className="hm-trend-line" d={path} />
      </svg>
      <div className="hm-trend-axis" aria-hidden="true">
        <span>{axisStart}</span>
        <span>{axisEnd}</span>
      </div>
    </section>
  );
}

function ActivityRangeSummary({ trend }: { trend: ActivityTrend }) {
  const selectedRange = rangeLabel(trend.from, trend.to);
  const byLabel = bucketLabel(trend.bucket);
  const topRepos = trend.byRepo.slice(0, 5);
  const items = [
    { label: "events", value: trend.total.toLocaleString(), detail: selectedRange },
    ...(trend.busiest
      ? [{ label: `busiest ${byLabel}`, value: trend.busiest.count.toLocaleString(), detail: trend.busiest.label }]
      : []),
    ...trend.byKind.slice(0, 4).map((k) => ({
      label: formatKind(k.kind),
      value: k.count.toLocaleString(),
      detail: "events",
    })),
  ];

  return (
    <section className="hm-range" aria-label="Selected range activity summary">
      <div className="hm-range-head">
        <h4>Selected range summary</h4>
        <span>{selectedRange}</span>
      </div>
      <dl className="hm-summary hm-range-summary">
        {items.map((item) => (
          <div key={`${item.label}-${item.detail}`}>
            <dt>{item.label}</dt>
            <dd>
              {item.value}
              <small>{item.detail}</small>
            </dd>
          </div>
        ))}
      </dl>
      {topRepos.length > 0 ? (
        <div className="hm-range-repos">
          <div className="hm-range-repos-head">
            <span>Repos</span>
            <span>events</span>
          </div>
          <ol>
            {topRepos.map((repo) => (
              <li key={`${repo.source_id}-${repo.project_path ?? ""}`}>
                <span className="hm-range-repo">
                  <span className="hm-range-repo-name">{repo.project_path ?? "(no project)"}</span>
                  <small>{sourceDisplayName(repo.source_id) || repo.source_id}</small>
                </span>
                <b>{repo.count.toLocaleString()}</b>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

export function ActivityHeatmap({
  activities,
  trendActivities,
  timezone,
  range,
}: {
  activities: ActivityDTO[];
  trendActivities: ActivityDTO[];
  timezone: string;
  range: TimeRange;
}) {
  const hm = useMemo(() => buildActivityHeatmap(activities, Date.now(), timezone), [activities, timezone]);
  const trend = useMemo(
    () => buildActivityTrend(trendActivities, range, timezone),
    [trendActivities, range, timezone],
  );
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);

  if (hm.total === 0) return null;

  const heatmapRange = rangeLabel(hm.from, hm.to);
  const hasRange = Boolean(range.from) && Boolean(range.to) && range.from <= range.to;
  const inSelectedRange = (date: string) => hasRange && date >= range.from && date <= range.to;
  const summary = [
    { label: "events", value: hm.total.toLocaleString(), detail: "last 12 months" },
    ...(hm.busiest
      ? [{ label: "busiest day", value: hm.busiest.count.toLocaleString(), detail: hm.busiest.date }]
      : []),
    ...hm.byKind.slice(0, 4).map((k) => ({
      label: formatKind(k.kind),
      value: k.count.toLocaleString(),
      detail: "events",
    })),
  ];

  return (
    <aside className="activity-heatmap" aria-label="Activity rhythm and trend">
      <dl className="hm-summary">
        {summary.map((item) => (
          <div key={`${item.label}-${item.detail}`}>
            <dt>{item.label}</dt>
            <dd>
              {item.value}
              <small>{item.detail}</small>
            </dd>
          </div>
        ))}
      </dl>

      <div className="hm-head">
        <h3>Activity rhythm</h3>
        <span className="muted">last 12 months · {heatmapRange}</span>
      </div>

      <div className="hm-calendar-scroll">
        <div
          className="hm-calendar"
          role="img"
          aria-label={`Daily activity from ${hm.from} to ${hm.to}`}
          onMouseLeave={() => setTip(null)}
        >
          <div className="hm-months" aria-hidden="true">
            {hm.monthLabels.map((m) => (
              <span key={`${m.col}-${m.label}`} style={{ "--hm-col": m.col } as CSSProperties}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="hm-body">
            <div className="hm-weekdays" aria-hidden="true">
              {Array.from({ length: 7 }, (_, row) => (
                <span key={row}>{WEEKDAY_LABELS[row] ?? ""}</span>
              ))}
            </div>
            <div className="hm-grid">
              {hm.weeks.map((week, col) => (
                <div className="hm-col" key={col}>
                  {week.map((cell, row) =>
                    cell ? (
                      <div
                        key={cell.date}
                        className="hm-cell"
                        data-level={cell.level}
                        data-in-range={inSelectedRange(cell.date) || undefined}
                        onMouseEnter={(e) => setTip({ label: cellTip(cell), x: e.clientX, y: e.clientY })}
                        onMouseMove={(e) => setTip({ label: cellTip(cell), x: e.clientX, y: e.clientY })}
                      />
                    ) : (
                      <div key={`empty-${col}-${row}`} className="hm-cell hm-cell-empty" />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="hm-legend">
            <span>Less</span>
            {LEVELS.map((level) => (
              <span key={level} className="hm-cell" data-level={level} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>

      <ActivityTrendChart trend={trend} />
      <ActivityRangeSummary trend={trend} />

      {tip ? (
        <div className="hm-tip" role="status" style={{ left: tip.x, top: tip.y } as CSSProperties}>
          {tip.label}
        </div>
      ) : null}
    </aside>
  );
}
