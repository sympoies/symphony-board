import type { ItemDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import { anchorId, spotlight, SPOTLIGHT_KEEP } from "../model.ts";

// Recency lanes (Follow-up / Plan-tracking / PR), independent of the status
// columns: the latest N matching items by created_at, REGARDLESS of state — so
// follow-up / plan issues stay surfaced even after they close (otherwise they
// sink into the Closed column). Mirrors the predecessor's Spotlight view.
export function Spotlight({ items }: { items: ItemDTO[] }) {
  const lanes = spotlight(items);
  if (lanes.every((l) => l.items.length === 0)) return null;
  return (
    <section className="spotlight">
      <h2>
        Spotlight <span className="muted">· latest {SPOTLIGHT_KEEP} per lane, any state</span>
      </h2>
      <div className="spotlight-lanes">
        {lanes.map(({ lane, items: laneItems }) => (
          <div key={lane.key} className="col">
            <h3 className="col-head" title={lane.hint}>
              {lane.label} <span className="count">{laneItems.length}</span>
              <span className="col-sub">{lane.hint}</span>
            </h3>
            <div className="col-cards">
              {laneItems.map((it) => (
                <ItemCard key={it.id} item={it} anchorId={anchorId(it.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
