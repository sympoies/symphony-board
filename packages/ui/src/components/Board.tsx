import type { ItemDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import { anchorId, groupItems, type GroupBy } from "../model.ts";

// The items grid, grouped by the chosen dimension. Each card carries a stable
// anchor so the relationships view can link to it.
export function Board({ items, groupBy }: { items: ItemDTO[]; groupBy: GroupBy }) {
  if (items.length === 0) {
    return <p className="empty">No items match the current filters.</p>;
  }
  const groups = groupItems(items, groupBy);
  return (
    <section className="board">
      <h2>Items <span className="muted">· {items.length}</span></h2>
      {groups.map((g) => (
        <div key={g.key} className="group">
          {groupBy !== "none" && (
            <h3 className="group-head">
              {g.key} <span className="count">{g.items.length}</span>
            </h3>
          )}
          <div className="grid">
            {g.items.map((it) => (
              <ItemCard key={it.id} item={it} anchorId={anchorId(it.id)} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
