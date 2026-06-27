import type { ItemDTO } from "@symphony-board/contract";
import { itemMetricEntries, type ItemMetricKind } from "../item-metrics.ts";
import type { RelationCount } from "../model.ts";

function MetricIcon({ kind }: { kind: ItemMetricKind }) {
  if (kind === "related") {
    return (
      <svg className="item-metric-icon icon-related" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    );
  }
  if (kind === "threads") {
    return (
      <svg className="item-metric-icon icon-threads" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 7.5a2.5 2.5 0 0 0-2.5-2.5h-13A2.5 2.5 0 0 0 3 7.5v6A2.5 2.5 0 0 0 5.5 16H7v3l4-3h7.5A2.5 2.5 0 0 0 21 13.5v-6Z" />
        <path d="M8 10h8" />
        <path d="M8 13h5" />
      </svg>
    );
  }
  return (
    <svg className="item-metric-icon icon-comments" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function ItemMetricStrip({
  item,
  related,
  relatedHref,
  relatedTitle,
  className,
}: {
  item: ItemDTO;
  related?: RelationCount | null;
  relatedHref?: string | null;
  relatedTitle?: string;
  className?: string;
}) {
  const entries = itemMetricEntries(item, related).map((entry) =>
    entry.kind === "related" && relatedTitle ? { ...entry, title: relatedTitle } : entry,
  );
  if (entries.length === 0) return null;
  return (
    <span className={`item-metric-strip${className ? ` ${className}` : ""}`}>
      {entries.map((entry) => {
        const body = (
          <>
            <MetricIcon kind={entry.kind} /> {entry.value}
          </>
        );
        const metricClass = `item-metric item-metric-${entry.kind}`;
        if (entry.kind === "related" && relatedHref) {
          return (
            <a key={entry.kind} className={metricClass} href={relatedHref} title={entry.title}>
              {body}
            </a>
          );
        }
        return (
          <span key={entry.kind} className={metricClass} title={entry.title}>
            {body}
          </span>
        );
      })}
    </span>
  );
}
