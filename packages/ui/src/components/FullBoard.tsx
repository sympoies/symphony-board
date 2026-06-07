import type { ItemDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import {
  anchorId,
  STATUS_ORDER,
  STATUS_LABEL,
  STATUS_DESC,
  spotlight,
  type ItemStatus,
  type ColorOf,
} from "../model.ts";

// A column renders at most `cap` cards (the list arrives already sorted, newest
// first). The header ALWAYS shows the true total (items.length); when the cap
// hides some, a "+N more" footer marks what was trimmed — so the count never
// lies. Omit `cap` to render the whole column.
function Column({
  kind,
  label,
  sub,
  items,
  cap,
  sourceKind,
  colorOf,
  linkedIds,
}: {
  kind: string;
  label: string;
  sub: string;
  items: ItemDTO[];
  cap?: number;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  linkedIds: Set<string>;
}) {
  const shown = cap != null ? items.slice(0, cap) : items;
  const hidden = items.length - shown.length;
  return (
    <div className={`col col-${kind}`}>
      <h3 className="col-head" title={sub}>
        <span className={`dot dot-${kind}`} />
        {label} <span className="count">{items.length}</span>
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
            linked={linkedIds.has(it.id)}
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
  statuses,
  sourceKind,
  colorOf,
  linkedIds,
}: {
  items: ItemDTO[];
  statuses: Map<string, ItemStatus>;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  linkedIds: Set<string>;
}) {
  const statusCols: Record<ItemStatus, ItemDTO[]> = { open: [], in_progress: [], trailing: [], closed: [] };
  for (const it of items) statusCols[statuses.get(it.id) ?? "open"].push(it);
  const lanes = spotlight(items);
  return (
    <section className="board-7">
      {STATUS_ORDER.map((s) => (
        <Column key={s} kind={s} label={STATUS_LABEL[s]} sub={STATUS_DESC[s]} items={statusCols[s]} cap={CAPPED_STATUS.has(s) ? COLUMN_CAP : undefined} sourceKind={sourceKind} colorOf={colorOf} linkedIds={linkedIds} />
      ))}
      {lanes.map(({ lane, items: laneItems }) => (
        <Column key={lane.key} kind={`lane-${lane.key}`} label={lane.label} sub={lane.hint} items={laneItems} cap={COLUMN_CAP} sourceKind={sourceKind} colorOf={colorOf} linkedIds={linkedIds} />
      ))}
    </section>
  );
}
