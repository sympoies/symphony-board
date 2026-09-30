import { useMemo, useState } from "react";
import type { AggregateDTO, EdgeDTO, ItemDTO, ItemWindowDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import type { ItemRouteFields } from "../nav.ts";
import { StatsBar } from "./StatsBar.tsx";
import {
  anchorId,
  columnCollapsed,
  computeBoardWindowStats,
  findContractScopedStats,
  initialMobileColumn,
  STATUS_ORDER,
  STATUS_LABEL,
  STATUS_DESC,
  spotlight,
  type ItemStatus,
  type ColorOf,
  type RelationCount,
  type TimeRange,
} from "../model.ts";
import { useContentPaneHeight } from "../useContentPaneHeight.ts";

// A column renders at most `cap` cards (the list arrives already sorted, newest
// first). The header ALWAYS shows the true total (items.length); when the cap
// hides some, a "+N more" footer marks what was trimmed — so the count never
// lies. Omit `cap` to render the whole column. A `foldClosed` column arrives
// open-items-first and tucks the closed rest behind a "Closed (N)" toggle, folded
// by default. A `collapsed` column renders instead as a slim rail (dot + count +
// vertical label); clicking either the rail or the header caret flips it via
// `onToggle`.
function Column({
  kind,
  label,
  sub,
  items,
  cap,
  foldClosed = false,
  collapsed,
  onToggle,
  sourceKind,
  colorOf,
  relationCounts,
  lens,
  mobileActive = false,
}: {
  kind: string;
  label: string;
  sub: string;
  items: ItemDTO[];
  cap?: number;
  foldClosed?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  relationCounts: Map<string, RelationCount>;
  lens?: ItemRouteFields;
  mobileActive?: boolean;
}) {
  const [showClosed, setShowClosed] = useState(false);
  // Collapsed: a slim, full-height rail — dot, count, vertical label — where the
  // whole rail is the expand button. Empty columns arrive here automatically (see
  // model.columnCollapsed); the labelled rail keeps the "this lane is empty"
  // signal on screen instead of dropping the column entirely.
  if (collapsed) {
    return (
      <div className={`col col-${kind} col-collapsed${mobileActive ? " col-mobile-active" : ""}`}>
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
  const openCount = foldClosed ? items.filter((it) => it.state === "open").length : items.length;
  const folded = items.length - openCount;
  const visible = showClosed ? items : items.slice(0, openCount);
  const shown = cap != null ? visible.slice(0, cap) : visible;
  const hidden = visible.length - shown.length;
  const card = (it: ItemDTO) => (
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
  );
  return (
    <div className={`col col-${kind}${mobileActive ? " col-mobile-active" : ""}`}>
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
        {shown.slice(0, openCount).map(card)}
        {folded > 0 && (
          <button type="button" className="col-fold muted" aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>
            Closed ({folded})
          </button>
        )}
        {shown.slice(openCount).map(card)}
        {hidden > 0 && <div className="col-more muted">+{hidden} more</div>}
      </div>
    </div>
  );
}

// Per-column render cap (newest first). Applied to the Closed status column and
// every Spotlight lane — those grow without bound as history piles up. Open
// stays uncapped: it is the actionable column and small in practice. The header
// still reports the true total either way.
const COLUMN_CAP = 100;
const CAPPED_STATUS: ReadonlySet<ItemStatus> = new Set<ItemStatus>(["closed"]);

// One rendered column: a status column (kind = the status key) or a Spotlight
// lane (kind = `lane-<key>`).
interface BoardColumn {
  kind: string;
  label: string;
  sub: string;
  items: ItemDTO[];
  cap?: number;
  foldClosed: boolean;
}

// The primary, full-bleed board (GitHub-Projects style): the 2 status columns
// and the 3 Spotlight lanes fused into one 5-column row — Trackers, Open,
// Closed, Follow-up, Change requests.
//
// NB: this is NOT a 5-way partition. The status columns partition items by
// lifecycle (each item lands in exactly one); the Spotlight lanes are a SEPARATE
// cross-cut (by label/kind/state, latest N), so an item can appear in both
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
  const statusCols: Record<ItemStatus, ItemDTO[]> = { open: [], closed: [] };
  for (const it of boardItems) statusCols[statuses.get(it.id) ?? "open"].push(it);
  const lanes = spotlight(boardItems);
  const laneColumn = ({ lane, items: laneItems }: (typeof lanes)[number]): BoardColumn => ({
    kind: `lane-${lane.key}`,
    label: lane.label,
    sub: lane.hint,
    items: laneItems,
    cap: COLUMN_CAP,
    foldClosed: lane.foldClosed,
  });
  // Column order: the leading lanes (Trackers), the status columns, then the
  // remaining lanes. The phone selector and the lane row both follow it.
  const columns: BoardColumn[] = [
    ...lanes.filter(({ lane }) => lane.lead).map(laneColumn),
    ...STATUS_ORDER.map((s) => ({
      kind: s,
      label: STATUS_LABEL[s],
      sub: STATUS_DESC[s],
      items: statusCols[s],
      cap: CAPPED_STATUS.has(s) ? COLUMN_CAP : undefined,
      foldClosed: false,
    })),
    ...lanes.filter(({ lane }) => !lane.lead).map(laneColumn),
  ];
  // A phone shows one column at a time (see model.initialMobileColumn).
  const [mobileKind, setMobileKind] = useState<string>(() => initialMobileColumn(columns));
  const { paneRef: boardPaneRef, paneHeightStyle } = useContentPaneHeight<HTMLElement>([
    boardItems.length,
    lanes.length,
    collapsed.size,
    peeked.size,
    mobileKind,
  ]);
  return (
    <>
      <div className="board-controls">
        <span className="muted">
          showing {boardItems.length} of {items.length} items
          {itemWindow?.truncated ? ` · range ${range.from} to ${range.to} · total ${itemWindow.total_items}` : ""}
        </span>
      </div>
      <StatsBar scoped={boardStats} />
      <div className="board-mobile-selector" aria-label="Board lanes">
        {columns.map((column) => (
          <button
            key={column.kind}
            type="button"
            className={`toggle${mobileKind === column.kind ? " toggle-on" : ""}`}
            onClick={() => setMobileKind(column.kind)}
          >
            <span>{column.label}</span>
            <span className="count">{column.items.length}</span>
          </button>
        ))}
      </div>
      <section className="board-lanes" ref={boardPaneRef} style={paneHeightStyle}>
        {columns.map((column) => (
          <Column
            key={column.kind}
            kind={column.kind}
            label={column.label}
            sub={column.sub}
            items={column.items}
            cap={column.cap}
            foldClosed={column.foldClosed}
            collapsed={columnCollapsed(column.kind, column.items.length === 0, collapsed, peeked)}
            onToggle={() => onToggleCollapse(column.kind, column.items.length === 0)}
            sourceKind={sourceKind}
            colorOf={colorOf}
            relationCounts={relationCounts}
            lens={lens}
            mobileActive={mobileKind === column.kind}
          />
        ))}
      </section>
    </>
  );
}
