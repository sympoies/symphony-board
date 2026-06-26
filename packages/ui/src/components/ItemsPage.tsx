import { lazy, memo, Suspense, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { ItemKindIcon, itemKindLabel } from "./ItemKindIcon.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { relativeTime, reviewThreadsLabel, pluralize, type ColorOf, type RelationCount, type TimeRange } from "../model.ts";
import { graphFocusHref, type ItemRouteFields } from "../nav.ts";

const Markdown = lazy(() => import("./Markdown.tsx"));

const MarkdownBody = memo(function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<div className={className}><div className="live-md-fallback">{text}</div></div>}>
      <Markdown className={className}>{text}</Markdown>
    </Suspense>
  );
});

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

function itemBody(item: ItemDTO): string | null {
  const body = item.body;
  return typeof body === "string" && body.trim() ? body.trim() : null;
}

function stopRowSelection(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function itemRelativeTime(value: string | null | undefined, label: string): ReactNode {
  if (!value) return null;
  return <time title={value}>{label} {relativeTime(value)}</time>;
}

function DetailFact({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="items-detail-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ItemDetail({
  item,
  sourceKind,
  relationCounts,
  lens,
}: {
  item: ItemDTO;
  sourceKind: ReadonlyMap<string, string>;
  relationCounts: ReadonlyMap<string, RelationCount>;
  lens?: ItemRouteFields;
}) {
  const body = itemBody(item);
  const related = relationCounts.get(item.id) ?? null;
  const threadLabel = reviewThreadsLabel(item.review_threads);

  return (
    <aside className="items-detail" aria-label="Item details">
      <div className="items-detail-card">
        <div className="items-detail-head">
          <ItemKindIcon kind={item.kind} className="items-detail-kind-icon" />
          <Badge text={item.state} kind={item.state} />
          {item.is_draft ? <Badge text="draft" kind="draft" /> : null}
        </div>
        <h3 className="items-detail-title">
          {item.url ? (
            <a className="items-detail-title-link" href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title ?? "(untitled)"} <span className="items-detail-title-arrow" aria-hidden="true">↗</span>
            </a>
          ) : (
            item.title ?? "(untitled)"
          )}
        </h3>
        <div className="items-detail-ref">
          <SourceRepo kind={sourceKind.get(item.source_id)} repo={item.project_path} />
          {item.iid != null ? <span>#{item.iid}</span> : null}
          {item.author ? <span>@{item.author}</span> : null}
        </div>

        {body ? (
          <MarkdownBody text={body} className="live-md items-detail-body" />
        ) : (
          <p className="items-detail-body items-detail-body-empty">No synced provider body.</p>
        )}

        <dl className="items-detail-facts">
          <DetailFact label="updated" value={itemRelativeTime(item.updated_at, "updated")} />
          <DetailFact label="created" value={itemRelativeTime(item.created_at, "created")} />
          <DetailFact label="closed" value={itemRelativeTime(item.closed_at, "closed")} />
          <DetailFact label="merged" value={itemRelativeTime(item.merged_at, "merged")} />
          <DetailFact label="state raw" value={item.state_raw} />
          <DetailFact label="state reason" value={item.state_reason} />
          <DetailFact label="milestone" value={item.milestone} />
          <DetailFact label="demand" value={item.demand != null && item.demand > 0 ? `${item.demand} comments/reactions` : null} />
          <DetailFact label="review" value={item.review_state ? <Badge text={item.review_state} kind={`review-${item.review_state}`} /> : null} />
          <DetailFact label="ci" value={item.ci_state ? <Badge text={item.ci_state} kind={`ci-${item.ci_state}`} /> : null} />
          <DetailFact label="merge" value={item.merge_state ? <Badge text={item.merge_state} kind={`merge-${item.merge_state}`} /> : null} />
          <DetailFact
            label="threads"
            value={threadLabel ? <Badge text={threadLabel} kind={item.review_threads!.open > 0 ? "status-error" : "status-ok"} /> : null}
          />
          <DetailFact
            label="related"
            value={related && related.total > 0 ? (
              <a className="items-detail-graph" href={graphFocusHref(item, lens)}>
                <LinkIcon /> {related.total} {pluralize(related.total, "related item")}
              </a>
            ) : null}
          />
        </dl>

        {item.labels.length > 0 ? (
          <div className="items-detail-labels" aria-label="Labels">
            {item.labels.map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedItem = useMemo(() => {
    if (items.length === 0) return null;
    return items.find((item) => item.id === selectedId) ?? items[0]!;
  }, [items, selectedId]);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => (current && items.some((item) => item.id === current) ? current : items[0]!.id));
  }, [items]);

  const selectItemFromKey = (event: KeyboardEvent<HTMLElement>, item: ItemDTO) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setSelectedId(item.id);
  };

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
        <div className="items-split">
          <div className="items-list" role="list" aria-label="Items">
            {items.map((item) => {
              const accentColor = colorOf(item.source_id, item.project_path);
              const related = relationCounts.get(item.id) ?? null;
              const threadLabel = reviewThreadsLabel(item.review_threads);
              const labels = item.labels.slice(0, 4);
              const hiddenLabelCount = item.labels.length - labels.length;
              const selected = selectedItem?.id === item.id;
              return (
                <article
                  key={item.id}
                  className={`item-row${accentColor ? " item-row-accent" : ""}${selected ? " item-row-selected" : ""}`}
                  role="listitem"
                  tabIndex={0}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => setSelectedId(item.id)}
                  onKeyDown={(event) => selectItemFromKey(event, item)}
                  style={accentColor ? ({ "--repo-color": accentColor } as CSSProperties) : undefined}
                >
                  <div className="item-row-kind" title={itemKindLabel(item.kind)}>
                    <ItemKindIcon kind={item.kind} />
                  </div>
                  <div className="item-row-main">
                    <div className="item-row-title-line">
                      <Badge text={item.state} kind={item.state} />
                      {item.url ? (
                        <a className="item-row-title" href={item.url} target="_blank" rel="noopener noreferrer" onClick={stopRowSelection}>
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
                    <a className="item-row-graph" href={graphFocusHref(item, lens)} title="Focus this item in Graph" aria-label="Focus in Graph" onClick={stopRowSelection}>
                      <LinkIcon />
                    </a>
                  ) : null}
                </article>
              );
            })}
          </div>
          {selectedItem ? <ItemDetail item={selectedItem} sourceKind={sourceKind} relationCounts={relationCounts} lens={lens} /> : null}
        </div>
      )}
    </section>
  );
}
