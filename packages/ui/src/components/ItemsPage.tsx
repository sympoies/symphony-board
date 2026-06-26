import type { CSSProperties, ReactNode } from "react";
import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { relativeTime, reviewThreadsLabel, pluralize, type ColorOf, type RelationCount, type TimeRange } from "../model.ts";
import { graphFocusHref, type ItemRouteFields } from "../nav.ts";

function LinkIcon() {
  return (
    <svg
      className="icon-related"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function kindLabel(kind: string): string {
  if (kind === "change_request") return "PR/MR";
  if (kind === "issue") return "issue";
  return kind.replace(/_/g, " ");
}

export function ItemsPage({
  items,
  windowTotal,
  totalItems,
  range,
  sourceKind,
  colorOf,
  relationCounts,
  lens,
  emptyState,
}: {
  items: ItemDTO[];
  windowTotal: number;
  totalItems: number;
  range: TimeRange;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  relationCounts: ReadonlyMap<string, RelationCount>;
  lens?: ItemRouteFields;
  emptyState?: ReactNode;
}) {
  const countLabel = items.length === windowTotal ? `${items.length} in range` : `${items.length} of ${windowTotal}`;

  return (
    <section className="items-page">
      <div className="items-head">
        <h2>Items</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          updated {range.from} to {range.to}
          {totalItems > windowTotal ? ` · ${totalItems} total` : ""}
        </span>
      </div>
      {items.length === 0 ? (
        emptyState ?? <p className="empty">No items.</p>
      ) : (
        <div className="items-list" role="list" aria-label="Items">
          {items.map((item) => {
            const accentColor = colorOf(item.source_id, item.project_path);
            const related = relationCounts.get(item.id) ?? null;
            const threadLabel = reviewThreadsLabel(item.review_threads);
            const labels = item.labels.slice(0, 4);
            const hiddenLabelCount = item.labels.length - labels.length;
            return (
              <article
                key={item.id}
                className={`item-row${accentColor ? " item-row-accent" : ""}`}
                role="listitem"
                style={accentColor ? ({ "--repo-color": accentColor } as CSSProperties) : undefined}
              >
                <div className="item-row-kind">
                  <span>{kindLabel(item.kind)}</span>
                  <Badge text={item.state} kind={item.state} />
                </div>
                <div className="item-row-main">
                  <div className="item-row-title-line">
                    {item.url ? (
                      <a className="item-row-title" href={item.url} target="_blank" rel="noopener noreferrer">
                        {item.title ?? "(untitled)"}
                      </a>
                    ) : (
                      <span className="item-row-title item-row-title-text">{item.title ?? "(untitled)"}</span>
                    )}
                    {item.is_draft ? <Badge text="draft" kind="draft" /> : null}
                  </div>
                  <div className="item-row-meta">
                    <SourceRepo kind={sourceKind.get(item.source_id)} repo={item.project_path} />
                    {item.iid != null ? <span>#{item.iid}</span> : null}
                    {item.author ? <span>@{item.author}</span> : null}
                    {item.updated_at ? <time title={item.updated_at}>updated {relativeTime(item.updated_at)}</time> : null}
                    {item.created_at ? <time title={item.created_at}>created {relativeTime(item.created_at)}</time> : null}
                  </div>
                  <div className="item-row-signals">
                    {item.review_state ? <Badge text={`review: ${item.review_state}`} kind={`review-${item.review_state}`} /> : null}
                    {item.ci_state ? <Badge text={`ci: ${item.ci_state}`} kind={`ci-${item.ci_state}`} /> : null}
                    {item.merge_state ? <Badge text={`merge: ${item.merge_state}`} kind={`merge-${item.merge_state}`} /> : null}
                    {threadLabel ? <Badge text={`threads: ${threadLabel}`} kind={item.review_threads!.open > 0 ? "status-error" : "status-ok"} /> : null}
                    {item.demand != null && item.demand > 0 ? <span className="item-row-chip">{item.demand} comments/reactions</span> : null}
                    {related && related.total > 0 ? (
                      <span className="item-row-chip" title={related.byType.map((part) => `${part.type} ${part.count}`).join(" · ")}>
                        {related.total} {pluralize(related.total, "related item")}
                      </span>
                    ) : null}
                    {labels.map((label) => (
                      <LabelChip key={label.name} label={label} />
                    ))}
                    {hiddenLabelCount > 0 ? <span className="item-row-chip">+{hiddenLabelCount} labels</span> : null}
                  </div>
                </div>
                {related && related.total > 0 ? (
                  <a className="item-row-graph" href={graphFocusHref(item, lens)} title="Focus this item in Graph" aria-label="Focus in Graph">
                    <LinkIcon />
                  </a>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
