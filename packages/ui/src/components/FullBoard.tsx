import type { ItemDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import {
  anchorId,
  STATUS_ORDER,
  STATUS_LABEL,
  STATUS_DESC,
  spotlight,
  type ItemStatus,
} from "../model.ts";

function Column({
  kind,
  label,
  sub,
  items,
}: {
  kind: string;
  label: string;
  sub: string;
  items: ItemDTO[];
}) {
  return (
    <div className={`col col-${kind}`}>
      <h3 className="col-head" title={sub}>
        <span className={`dot dot-${kind}`} />
        {label} <span className="count">{items.length}</span>
        <span className="col-sub">{sub}</span>
      </h3>
      <div className="col-cards">
        {items.map((it) => (
          <ItemCard key={it.id} item={it} anchorId={anchorId(it.id)} />
        ))}
      </div>
    </div>
  );
}

// The primary, full-bleed board (GitHub-Projects style): the 4 status columns
// and the 3 Spotlight lanes fused into one 7-column row.
//
// NB: this is NOT a 7-way partition. The status columns partition items by
// lifecycle (each item lands in exactly one); the Spotlight lanes are a SEPARATE
// cross-cut (by label/kind, any state, latest N), so an item can appear in both
// a status column AND a lane. Intentional — it puts the predecessor's two views
// on one surface. The column counts therefore won't sum to the item total.
export function FullBoard({ items, statuses }: { items: ItemDTO[]; statuses: Map<string, ItemStatus> }) {
  const statusCols: Record<ItemStatus, ItemDTO[]> = { open: [], in_progress: [], tracking: [], closed: [] };
  for (const it of items) statusCols[statuses.get(it.id) ?? "open"].push(it);
  const lanes = spotlight(items);
  return (
    <section className="board-7">
      {STATUS_ORDER.map((s) => (
        <Column key={s} kind={s} label={STATUS_LABEL[s]} sub={STATUS_DESC[s]} items={statusCols[s]} />
      ))}
      {lanes.map(({ lane, items: laneItems }) => (
        <Column key={lane.key} kind={`lane-${lane.key}`} label={lane.label} sub={lane.hint} items={laneItems} />
      ))}
    </section>
  );
}
