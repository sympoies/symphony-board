import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type Ref } from "react";
import type { ActivityDTO, ActivityDailyDTO } from "@symphony-board/contract";
import {
  ACTIVITY_SUMMARY_KINDS,
  activitySummaryKindCounts,
  buildActivityHeatmap,
  buildActivityHeatmapFromDaily,
  buildActivityTrend,
  pluralize,
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

// The lines the trend chart can overlay, in legend order: the aggregate plus
// the developer-significant kinds. Colors are CSS-driven via `data-kind`.
// All lines are visible by default; the legend toggles let the viewer hide any
// of them (which rescales the rest to fill the height). The kind lines are
// single-sourced from the model's ACTIVITY_SUMMARY_KINDS so the chart overlay
// and the summary tiles can never drift apart.
const TREND_LINE_ORDER = ["total", ...ACTIVITY_SUMMARY_KINDS] as const;
// The component kinds the chart sums into its `total` line — the non-total
// entries of TREND_LINE_ORDER.
const TREND_KIND_LINES = ACTIVITY_SUMMARY_KINDS;
const TREND_DEFAULT_HIDDEN: string[] = [];
const TREND_LINE_LABELS: Record<string, string> = {
  total: "total",
  commit: "commit",
  change_request: "change request",
  review: "review",
};
const seriesLabel = (kind: string) => TREND_LINE_LABELS[kind] ?? kind.replace(/_/g, " ");

const cellTip = (cell: HeatmapCell) =>
  `${cell.date} · ${cell.count.toLocaleString()} ${pluralize(cell.count, "event")}`;

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

function activeDaysItem(activeDays: number, dayCount: number) {
  return {
    label: "active days",
    value: activeDays.toLocaleString(),
    detail: `of ${dayCount.toLocaleString()} ${pluralize(dayCount, "day")}`,
  };
}

// Map a pointer's client Y onto the chart's viewBox Y so we can pick the line
// nearest the cursor. The hit band spans the full chart height, so its bounding
// rect maps 1:1 onto [0, TREND_H].
function viewBoxY(event: ReactMouseEvent): number {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  return ((event.clientY - rect.top) / rect.height) * TREND_H;
}

function ActivityTrendChart({
  trend,
  onTip,
}: {
  trend: ActivityTrend;
  onTip: (tip: { label: string; x: number; y: number } | null) => void;
}) {
  const { points, bucket, from, to } = trend;
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  // Persistent show/hide (legend click) vs. transient emphasis (legend or line
  // hover). They are independent: a hidden line never draws; a focused line
  // stays full-strength while the others dim to background grey.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(TREND_DEFAULT_HIDDEN));
  const [focused, setFocused] = useState<string | null>(null);

  const modelSeries = useMemo(
    () => new Map(trend.series.map((series) => [series.kind, series] as const)),
    [trend.series],
  );
  // The model's total series is the chart aggregate: commit + change request +
  // review. Broader all-event totals stay in the summary panels.
  const seriesByKind = useMemo(() => {
    const total = modelSeries.get("total");
    const parts = TREND_KIND_LINES.flatMap((kind) => {
      const series = modelSeries.get(kind);
      return series ? [series] : [];
    });
    return new Map([...(total ? [total] : []), ...parts].map((series) => [series.kind, series] as const));
  }, [modelSeries]);
  // Legend entries: total plus the curated lines that actually occur in range.
  const legend = TREND_LINE_ORDER.filter((kind) => seriesByKind.has(kind));
  const visible = legend.filter((kind) => !hidden.has(kind)).map((kind) => seriesByKind.get(kind)!);
  const shownTotal = seriesByKind.get("total")?.total ?? 0;

  // Shared Y axis across visible lines only — so hiding the dominant line
  // (usually commits) rescales the rest up to fill the height and become
  // readable, which is the whole point of the toggle.
  const maxY = Math.max(
    1,
    ...visible.flatMap((series) => [series.maxCount, series.maxAverage]),
  );

  // Per-line geometry: `line` is the smoothed-average curve (drives the path and
  // nearest-line hover detection); `raw` is the per-bucket count position, where
  // the dots sit — so the dots show the actual values around the trend line.
  const dotStep = Math.max(1, Math.ceil(points.length / 120));
  const lines = visible.map((series) => {
    const line = series.points.map((point, index) => trendCoord(index, series.points.length, maxY, point.average));
    const raw = series.points.map((point, index) => trendCoord(index, series.points.length, maxY, point.count));
    return { kind: series.kind, series, line, raw, path: smoothPath(line) };
  });

  const byLabel = bucketLabel(bucket);
  const selectedRange = rangeLabel(from, to);
  const axisStart = points[0]?.label ?? from;
  const axisEnd = points.at(-1)?.label ?? to;

  // Full-height invisible hit bands, one per bucket with boundaries at the
  // midpoints between neighbors: every bucket is hoverable — including
  // zero-count ones — without aiming at a thin line.
  const axisX = points.map((_, index) => trendCoord(index, points.length, maxY, 0).x);
  const hitBands = axisX.map((x, index) => {
    const left = index === 0 ? 0 : (axisX[index - 1]! + x) / 2;
    const right = index === axisX.length - 1 ? TREND_W : (x + axisX[index + 1]!) / 2;
    return { x: left, width: right - left };
  });

  const tipFor = (index: number) => {
    // List every visible line's count for the hovered bucket, in legend order,
    // so the tooltip reads as a snapshot of the whole group at that moment.
    if (visible.length === 0) return null;
    const label = visible[0]!.points[index]?.label ?? points[index]?.label;
    if (!label) return null;
    const parts = visible.map(
      (series) => `${seriesLabel(series.kind)} ${(series.points[index]?.count ?? 0).toLocaleString()}`,
    );
    return `${label} · ${parts.join(" · ")}`;
  };

  const focusAt = (index: number, event: ReactMouseEvent) => {
    setFocusIndex(index);
    // Emphasize the visible line whose curve sits closest to the cursor.
    if (lines.length > 0) {
      const vy = viewBoxY(event);
      let nearest = lines[0]!;
      let best = Infinity;
      for (const entry of lines) {
        const dy = Math.abs((entry.line[index]?.y ?? Infinity) - vy);
        if (dy < best) {
          best = dy;
          nearest = entry;
        }
      }
      setFocused(nearest.kind);
    }
    const label = tipFor(index);
    if (label) onTip({ label, x: event.clientX, y: event.clientY });
  };
  const clearChartFocus = () => {
    setFocusIndex(null);
    setFocused(null);
    onTip(null);
  };

  const toggle = (kind: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <section className="hm-trend" aria-label="Selected range activity trend" data-bucket={bucket}>
      <div className="hm-trend-head">
        <span>
          Selected range activity by {byLabel}
          <small>{selectedRange}</small>
        </span>
        <b>{shownTotal.toLocaleString()} events</b>
      </div>
      <div className="hm-trend-legend" role="group" aria-label="Toggle activity lines">
        {legend.map((kind) => {
          const isHidden = hidden.has(kind);
          return (
            <button
              key={kind}
              type="button"
              className="hm-trend-legend-item"
              data-kind={kind}
              data-hidden={isHidden || undefined}
              data-focused={!isHidden && focused === kind ? true : undefined}
              aria-pressed={!isHidden}
              onClick={() => toggle(kind)}
              onMouseEnter={() => setFocused(kind)}
              onMouseLeave={() => setFocused((cur) => (cur === kind ? null : cur))}
            >
              <span className="hm-trend-swatch" data-kind={kind} aria-hidden="true" />
              {seriesLabel(kind)}
              <small>{(seriesByKind.get(kind)?.total ?? 0).toLocaleString()}</small>
            </button>
          );
        })}
      </div>
      {/* aria-label, not <title>: a <title> child doubles as a native hover
          tooltip and fights the custom hm-tip. */}
      <svg
        className="hm-trend-chart"
        viewBox={`0 0 ${TREND_W} ${TREND_H}`}
        role="img"
        aria-label={`Activity trend by ${byLabel} from ${from} to ${to}`}
        onMouseLeave={clearChartFocus}
      >
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
        {lines.map((entry) => (
          <path
            key={entry.kind}
            className="hm-trend-line"
            data-kind={entry.kind}
            data-dim={focused && focused !== entry.kind ? true : undefined}
            d={entry.path}
          />
        ))}
        {/* Per-bucket markers at the raw count, one per visible line, so the
            actual values read around the smoothed trend line. */}
        {lines.map((entry) =>
          entry.raw.map((coord, index) =>
            entry.series.points[index]?.count && index % dotStep === 0 ? (
              <circle
                key={`${entry.kind}-${entry.series.points[index]!.date}`}
                className="hm-trend-dot"
                data-kind={entry.kind}
                data-dim={focused && focused !== entry.kind ? true : undefined}
                cx={coord.x}
                cy={coord.y}
                r="2.2"
              />
            ) : null,
          ),
        )}
        {focusIndex !== null ? (
          <g className="hm-trend-focus" aria-hidden="true">
            <line
              className="hm-trend-cursor"
              x1={axisX[focusIndex]}
              x2={axisX[focusIndex]}
              y1={TREND_PAD_Y}
              y2={TREND_H - TREND_PAD_Y}
            />
            {lines.map((entry) => {
              const coord = entry.raw[focusIndex];
              if (!coord) return null;
              const isFocused = focused === entry.kind;
              return (
                <g key={entry.kind}>
                  {isFocused ? (
                    <circle className="hm-trend-halo" data-kind={entry.kind} cx={coord.x} cy={coord.y} r="9" />
                  ) : null}
                  <circle
                    className="hm-trend-dot-focus"
                    data-kind={entry.kind}
                    data-dim={focused && !isFocused ? true : undefined}
                    cx={coord.x}
                    cy={coord.y}
                    r={isFocused ? 4.4 : 3}
                  />
                </g>
              );
            })}
          </g>
        ) : null}
        {hitBands.map((band, index) => (
          <rect
            key={points[index]!.date}
            className="hm-trend-hit"
            x={band.x}
            y={0}
            width={band.width}
            height={TREND_H}
            onMouseEnter={(event) => focusAt(index, event)}
            onMouseMove={(event) => focusAt(index, event)}
          />
        ))}
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
  const items = [
    { label: "events", value: trend.total.toLocaleString(), detail: selectedRange },
    ...(trend.busiest
      ? [{ label: `busiest ${byLabel}`, value: trend.busiest.count.toLocaleString(), detail: trend.busiest.label }]
      : []),
    activeDaysItem(trend.activeDays, trend.dayCount),
    ...activitySummaryKindCounts(trend.byKind).map((k) => ({
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
    </section>
  );
}

// Top repos by events for the selected range. Split out of the summary so it can
// sit BELOW the trend chart (order: summary -> trend -> top repos).
function ActivityTopRepos({ trend }: { trend: ActivityTrend }) {
  const topRepos = trend.byRepo.slice(0, 5);
  if (topRepos.length === 0) return null;
  const maxRepoCount = topRepos[0]?.count ?? 0;
  return (
    <section className="hm-range hm-top-repos" aria-label="Top repos by events">
      <div className="hm-range-repos">
        <h5>Top repos by events</h5>
        <ol>
          {topRepos.map((repo) => (
            <li
              key={`${repo.source_id}-${repo.project_path ?? ""}`}
              style={
                {
                  "--repo-share": `${maxRepoCount > 0 ? Math.max(4, Math.round((repo.count / maxRepoCount) * 100)) : 0}%`,
                } as CSSProperties
              }
            >
              <span className="hm-range-repo">
                <span className="hm-range-repo-name">{repo.project_path ?? "(no project)"}</span>
                <small>{sourceDisplayName(repo.source_id) || repo.source_id}</small>
              </span>
              <b>{repo.count.toLocaleString()}</b>
              <span className="hm-range-repo-bar" aria-hidden="true" />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function ActivityHeatmap({
  activities,
  activityDaily,
  generatedAt,
  trendActivities,
  timezone,
  range,
  panelRef,
}: {
  // Raw fallback source for the trailing-12-month heatmap, used only when
  // `activityDaily` is absent (a pre-4.0.0 contract or hand-loaded payload).
  activities: ActivityDTO[];
  // Pre-computed per-day/per-kind counts over the full history (4.0.0+). When
  // present it powers the heatmap, since the static `activities[]` is windowed
  // to 30 days and can no longer cover 12 months.
  activityDaily: ActivityDailyDTO | null;
  // Contract emit instant, the heatmap anchor for the raw fallback (not the UI
  // clock). The activity_daily path anchors at its own `to` instead.
  generatedAt: string;
  trendActivities: ActivityDTO[];
  timezone: string;
  range: TimeRange;
  panelRef?: Ref<HTMLElement>;
}) {
  const hm = useMemo(() => {
    if (activityDaily) return buildActivityHeatmapFromDaily(activityDaily);
    const anchor = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
    return buildActivityHeatmap(activities, anchor, timezone);
  }, [activityDaily, activities, generatedAt, timezone]);
  const trend = useMemo(
    () => buildActivityTrend(trendActivities, range, timezone),
    [trendActivities, range, timezone],
  );
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const calendarScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = calendarScrollRef.current;
    if (!node) return;
    node.scrollLeft = node.scrollWidth;
  }, [hm.from, hm.to, hm.weeks.length]);

  if (hm.total === 0) return null;

  const heatmapRange = rangeLabel(hm.from, hm.to);
  const hasRange = Boolean(range.from) && Boolean(range.to) && range.from <= range.to;
  const inSelectedRange = (date: string) => hasRange && date >= range.from && date <= range.to;
  const summary = [
    { label: "events", value: hm.total.toLocaleString(), detail: "events" },
    ...(hm.busiest
      ? [{ label: "busiest day", value: hm.busiest.count.toLocaleString(), detail: hm.busiest.date }]
      : []),
    activeDaysItem(hm.activeDays, hm.dayCount),
    ...activitySummaryKindCounts(hm.byKind).map((k) => ({
      label: formatKind(k.kind),
      value: k.count.toLocaleString(),
      detail: "events",
    })),
  ];

  return (
    <aside ref={panelRef} className="activity-heatmap" aria-label="Activity rhythm and trend">
      <div className="hm-overview-head">
        <h3>Activity overview</h3>
        <small>{`last 12 months · ${heatmapRange}`}</small>
      </div>

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
      </div>

      <div ref={calendarScrollRef} className="hm-calendar-scroll">
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

      <ActivityRangeSummary trend={trend} />
      <ActivityTrendChart trend={trend} onTip={setTip} />
      <ActivityTopRepos trend={trend} />

      {tip ? (
        <div className="hm-tip" role="status" style={{ left: tip.x, top: tip.y } as CSSProperties}>
          {tip.label}
        </div>
      ) : null}
    </aside>
  );
}
