import type { ItemDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import { anchorId, STATUS_ORDER, STATUS_LABEL, STATUS_DESC, type ItemStatus } from "../model.ts";

// A display-only kanban-style board: one column per status, cards stacked. No
// drag-and-drop — status is a projection of GitHub/GitLab state (owned by the
// pipeline), exactly like the predecessor board. Columns scroll independently.
export function StatusBoard({ items, statuses }: { items: ItemDTO[]; statuses: Map<string, ItemStatus> }) {
  const cols: Record<ItemStatus, ItemDTO[]> = { open: [], in_progress: [], tracking: [], closed: [] };
  for (const it of items) cols[statuses.get(it.id) ?? "open"].push(it);
  return (
    <section className="status-board">
      {STATUS_ORDER.map((s) => (
        <div key={s} className={`col col-${s}`}>
          <h3 className="col-head" title={STATUS_DESC[s]}>
            <span className={`dot dot-${s}`} />
            {STATUS_LABEL[s]} <span className="count">{cols[s].length}</span>
            <span className="col-sub">{STATUS_DESC[s]}</span>
          </h3>
          <div className="col-cards">
            {cols[s].length === 0 ? (
              <p className="col-empty">—</p>
            ) : (
              cols[s].map((it) => <ItemCard key={it.id} item={it} anchorId={anchorId(it.id)} />)
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
