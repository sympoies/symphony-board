import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { ItemMetricStrip } from "./ItemMetricStrip.tsx";
import { ItemKindIcon, itemKindLabel } from "./ItemKindIcon.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { itemMetricEntries } from "../item-metrics.ts";
import { relativeTime, reviewThreadsLabel, type ColorOf, type RelationCount, type TimeRange } from "../model.ts";
import { graphFocusHref, type ItemRouteFields } from "../nav.ts";

function GraphIcon() {
  return (
    <svg
      className="icon-graph"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
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

function relativeTimeValue(value: string | null | undefined): ReactNode {
  if (!value) return null;
  return <time title={value}>{relativeTime(value)}</time>;
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
  const hasSignals = Boolean(item.review_state || item.ci_state || item.merge_state || threadLabel);

  return (
    <aside className="items-detail" aria-label="Item details">
      <div className="items-detail-card">
        <div className="items-detail-shell">
          <div className="items-detail-kind" title={itemKindLabel(item.kind)}>
            <ItemKindIcon kind={item.kind} className="items-detail-kind-icon" />
          </div>
          <div className="items-detail-main">
            <div className="items-detail-head">
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
            <div className="items-detail-meta">
              <div className="items-detail-ref">
                <SourceRepo kind={sourceKind.get(item.source_id)} repo={item.project_path} />
                {item.iid != null ? <span>#{item.iid}</span> : null}
                {item.author ? <span>@{item.author}</span> : null}
              </div>

              <dl className="items-detail-facts">
                <DetailFact label="updated" value={relativeTimeValue(item.updated_at)} />
                <DetailFact label="created" value={relativeTimeValue(item.created_at)} />
                <DetailFact label="closed" value={relativeTimeValue(item.closed_at)} />
                <DetailFact label="merged" value={relativeTimeValue(item.merged_at)} />
                <DetailFact label="state raw" value={item.state_raw} />
                <DetailFact label="state reason" value={item.state_reason} />
                <DetailFact label="milestone" value={item.milestone} />
              </dl>
              <ItemMetricStrip item={item} related={related} className="items-detail-metrics" />

              {hasSignals ? (
                <div className="items-detail-signals" aria-label="Status signals">
                  {item.review_state ? <Badge text={`review: ${item.review_state}`} kind={`review-${item.review_state}`} /> : null}
                  {item.ci_state ? <Badge text={`ci: ${item.ci_state}`} kind={`ci-${item.ci_state}`} /> : null}
                  {item.merge_state ? <Badge text={`merge: ${item.merge_state}`} kind={`merge-${item.merge_state}`} /> : null}
                  {threadLabel ? <Badge text={`threads: ${threadLabel}`} kind={item.review_threads!.open > 0 ? "status-error" : "status-ok"} /> : null}
                </div>
              ) : null}

              {item.labels.length > 0 ? (
                <div className="items-detail-labels" aria-label="Labels">
                  {item.labels.map((label) => (
                    <LabelChip key={label.name} label={label} />
                  ))}
                </div>
              ) : null}
            </div>

            {body ? (
              <MarkdownBody text={body} className="live-md items-detail-body" />
            ) : (
              <p className="items-detail-body items-detail-body-empty">No synced provider body.</p>
            )}
          </div>
        </div>
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
              const hasMetrics = itemMetricEntries(item, related).length > 0;
              const hasActivityMeta = Boolean(item.author || hasMetrics);
              const hasTimes = Boolean(item.updated_at || item.created_at);
              const hasSignals = Boolean(item.review_state || item.ci_state || item.merge_state || threadLabel);
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
                    <div className="item-row-head">
                      <Badge text={item.state} kind={item.state} />
                      {item.is_draft ? <Badge text="draft" kind="draft" /> : null}
                      {related && related.total > 0 ? (
                        <a className="item-row-graph" href={graphFocusHref(item, lens)} title="Focus this item in Graph" aria-label="Focus in Graph" onClick={stopRowSelection}>
                          <GraphIcon />
                        </a>
                      ) : null}
                      <span className="item-row-title-break" aria-hidden="true" />
                      {item.url ? (
                        <a className="item-row-title" href={item.url} target="_blank" rel="noopener noreferrer" onClick={stopRowSelection}>
                          {item.title ?? "(untitled)"}
                        </a>
                      ) : (
                        <span className="item-row-title item-row-title-text">{item.title ?? "(untitled)"}</span>
                      )}
                    </div>
                    <div className="item-row-meta">
                      <SourceRepo kind={sourceKind.get(item.source_id)} repo={item.project_path} />
                      {item.iid != null ? <span>#{item.iid}</span> : null}
                    </div>
                    {hasActivityMeta ? (
                      <div className="item-row-meta item-row-activity">
                        {item.author ? <span>@{item.author}</span> : null}
                        <ItemMetricStrip item={item} related={related} />
                      </div>
                    ) : null}
                    {hasTimes ? (
                      <div className="item-row-times muted">
                        {item.updated_at ? <time title={item.updated_at}>updated {relativeTime(item.updated_at)}</time> : null}
                        {item.created_at && item.updated_at ? <span className="sep">·</span> : null}
                        {item.created_at ? <time title={item.created_at}>created {relativeTime(item.created_at)}</time> : null}
                      </div>
                    ) : null}
                    {hasSignals ? (
                      <div className="item-row-signals">
                        {item.review_state ? <Badge text={`review: ${item.review_state}`} kind={`review-${item.review_state}`} /> : null}
                        {item.ci_state ? <Badge text={`ci: ${item.ci_state}`} kind={`ci-${item.ci_state}`} /> : null}
                        {item.merge_state ? <Badge text={`merge: ${item.merge_state}`} kind={`merge-${item.merge_state}`} /> : null}
                        {threadLabel ? <Badge text={`threads: ${threadLabel}`} kind={item.review_threads!.open > 0 ? "status-error" : "status-ok"} /> : null}
                      </div>
                    ) : null}
                    {(labels.length > 0 || hiddenLabelCount > 0) ? (
                      <div className="item-row-labels">
                        {labels.map((label) => (
                          <LabelChip key={label.name} label={label} />
                        ))}
                        {hiddenLabelCount > 0 ? <span className="item-row-chip">+{hiddenLabelCount} labels</span> : null}
                      </div>
                    ) : null}
                  </div>
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
