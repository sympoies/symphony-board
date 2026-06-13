import { useMemo } from "react";
import type { AggregateDTO, EdgeDTO, ItemDTO, ItemWindowDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import type { ItemRouteFields } from "../nav.ts";
import { StatsBar } from "./StatsBar.tsx";
import {
  anchorId,
  columnCollapsed,
  computeBoardWindowStats,
  findContractScopedStats,
  STATUS_ORDER,
  STATUS_LABEL,
  STATUS_DESC,
  spotlight,
  type ItemStatus,
  type ColorOf,
  type RelationCount,
  type TimeRange,
} from "../model.ts";

// A column renders at most `cap` cards (the list arrives already sorted, newest
// first). The header ALWAYS shows the true total (items.length); when the cap
// hides some, a "+N more" footer marks what was trimmed — so the count never
// lies. Omit `cap` to render the whole column. A `collapsed` column renders
// instead as a slim rail (dot + count + vertical label); clicking either the
// rail or the header caret flips it via `onToggle`.
function Column({
  kind,
  label,
  sub,
  items,
  cap,
  collapsed,
  onToggle,
  sourceKind,
  colorOf,
  relationCounts,
  lens,
}: {
  kind: string;
  label: string;
  sub: string;
  items: ItemDTO[];
  cap?: number;
  collapsed: boolean;
  onToggle: () => void;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  relationCounts: Map<string, RelationCount>;
  lens?: ItemRouteFields;
}) {
  // Collapsed: a slim, full-height rail — dot, count, vertical label — where the
  // whole rail is the expand button. Empty columns arrive here automatically (see
  // model.columnCollapsed); the labelled rail keeps the "this lane is empty"
  // signal on screen instead of dropping the column entirely.
  if (collapsed) {
    return (
      <div className={`col col-${kind} col-collapsed`}>
        <button
          type="button"
          className="col-rail"
          onClick={onToggle}
          title={`${label} (${items.length}) — ${sub}. Click to expand.`}
          aria-label={`Expand ${label} column, ${items.length} items`}
        >
          <span className={`dot dot-${kind}`} />
          <span className="col-rail-count">{items.length}</span>
          <span className="col-rail-label">{label}</span>
        </button>
      </div>
    );
  }
  const shown = cap != null ? items.slice(0, cap) : items;
  const hidden = items.length - shown.length;
  return (
    <div className={`col col-${kind}`}>
      <h3 className="col-head" title={sub}>
        <span className={`dot dot-${kind}`} />
        {label} <span className="count">{items.length}</span>
        <button
          type="button"
          className="col-collapse-btn"
          onClick={onToggle}
          title={`Collapse ${label}`}
          aria-label={`Collapse ${label} column`}
        >
          ‹
        </button>
        <span className="col-sub">{sub}</span>
      </h3>
      <div className="col-cards">
        {shown.map((it) => (
          <ItemCard
            key={it.id}
            item={it}
            anchorId={anchorId(it.id)}
            sourceKind={sourceKind.get(it.source_id)}
            accentColor={colorOf(it.source_id, it.project_path)}
            related={relationCounts.get(it.id) ?? null}
            graphLink
            lens={lens}
          />
        ))}
        {hidden > 0 && <div className="col-more muted">+{hidden} more</div>}
      </div>
    </div>
  );
}

// Per-column render cap (newest first). Applied to the Closed / Trailing status
// columns and every Spotlight lane — those grow without bound as history piles
// up. Open / In Progress stay uncapped: they are the actionable columns and small
// in practice. The header still reports the true total either way.
const COLUMN_CAP = 100;
const CAPPED_STATUS: ReadonlySet<ItemStatus> = new Set<ItemStatus>(["trailing", "closed"]);

// The primary, full-bleed board (GitHub-Projects style): the 4 status columns
// and the 3 Spotlight lanes fused into one 7-column row.
//
// NB: this is NOT a 7-way partition. The status columns partition items by
// lifecycle (each item lands in exactly one); the Spotlight lanes are a SEPARATE
// cross-cut (by label/kind, any state, latest N), so an item can appear in both
// a status column AND a lane. Intentional — it puts the predecessor's two views
// on one surface. The column counts therefore won't sum to the item total.
export function FullBoard({
  items,
  edges,
  statuses,
  sourceKind,
  colorOf,
  relationCounts,
  collapsed,
  peeked,
  onToggleCollapse,
  aggregates = [],
  itemWindow,
  range,
  lens,
}: {
  items: ItemDTO[];
  edges: EdgeDTO[];
  statuses: Map<string, ItemStatus>;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  relationCounts: Map<string, RelationCount>;
  collapsed: ReadonlySet<string>;
  peeked: ReadonlySet<string>;
  onToggleCollapse: (kind: string, isEmpty: boolean) => void;
  aggregates?: readonly AggregateDTO[];
  itemWindow?: ItemWindowDTO;
  range: TimeRange;
  lens?: ItemRouteFields;
}) {
  const boardItems = items;
  const contractBoardStats = useMemo(
    () => findContractScopedStats(aggregates, { scope: "boardWindow", since: range.from }),
    [aggregates, range.from],
  );
  const boardStats = useMemo(
    () => contractBoardStats ?? computeBoardWindowStats(boardItems, edges),
    [contractBoardStats, boardItems, edges],
  );
  const statusCols: Record<ItemStatus, ItemDTO[]> = { open: [], in_progress: [], trailing: [], closed: [] };
  for (const it of boardItems) statusCols[statuses.get(it.id) ?? "open"].push(it);
  const lanes = spotlight(boardItems);
  return (
    <>
      <div className="board-controls">
        <span className="muted">
          showing {boardItems.length} of {items.length} items
          {itemWindow?.truncated ? ` · range ${range.from} to ${range.to} · total ${itemWindow.total_items}` : ""}
        </span>
      </div>
      <StatsBar scoped={boardStats} />
      <section className="board-7">
        {STATUS_ORDER.map((s) => (
          <Column
            key={s}
            kind={s}
            label={STATUS_LABEL[s]}
            sub={STATUS_DESC[s]}
            items={statusCols[s]}
            cap={CAPPED_STATUS.has(s) ? COLUMN_CAP : undefined}
            collapsed={columnCollapsed(s, statusCols[s].length === 0, collapsed, peeked)}
            onToggle={() => onToggleCollapse(s, statusCols[s].length === 0)}
            sourceKind={sourceKind}
            colorOf={colorOf}
            relationCounts={relationCounts}
            lens={lens}
          />
        ))}
        {lanes.map(({ lane, items: laneItems }) => {
          const laneKind = `lane-${lane.key}`;
          return (
            <Column
              key={lane.key}
              kind={laneKind}
              label={lane.label}
              sub={lane.hint}
              items={laneItems}
              cap={COLUMN_CAP}
              collapsed={columnCollapsed(laneKind, laneItems.length === 0, collapsed, peeked)}
              onToggle={() => onToggleCollapse(laneKind, laneItems.length === 0)}
              sourceKind={sourceKind}
              colorOf={colorOf}
              relationCounts={relationCounts}
              lens={lens}
            />
          );
        })}
      </section>
    </>
  );
}
