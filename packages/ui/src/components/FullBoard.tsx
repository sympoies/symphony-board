import { useEffect, useMemo, useState } from "react";
import type { AggregateDTO, EdgeDTO, ItemDTO, ItemWindowDTO } from "@symphony-board/contract";
import { ItemCard } from "./ItemCard.tsx";
import { StatsBar } from "./StatsBar.tsx";
import {
  ACTIVE_SINCE_PRESETS,
  anchorId,
  computeBoardWindowStats,
  cutoffIso,
  defaultActiveSince,
  findContractScopedStats,
  itemActiveSince,
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
  edges,
  statuses,
  sourceKind,
  colorOf,
  linkedIds,
  aggregates = [],
  itemWindow,
  generatedAt,
}: {
  items: ItemDTO[];
  edges: EdgeDTO[];
  statuses: Map<string, ItemStatus>;
  sourceKind: Map<string, string>;
  colorOf: ColorOf;
  linkedIds: Set<string>;
  aggregates?: readonly AggregateDTO[];
  itemWindow?: ItemWindowDTO;
  generatedAt: string;
}) {
  const generatedAtMs = useMemo(() => {
    const parsed = Date.parse(generatedAt);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }, [generatedAt]);
  const loadedSince = itemWindow?.window.kind === "active_since" ? itemWindow.window.since?.slice(0, 10) ?? null : null;
  const [since, setSince] = useState<string>(() => loadedSince ?? defaultActiveSince(generatedAtMs));
  useEffect(() => {
    if (loadedSince && (since === "" || since < loadedSince)) setSince(loadedSince);
  }, [loadedSince, since]);
  const cutoff = useMemo(() => (since ? new Date(since + "T00:00:00Z").toISOString() : null), [since]);
  const boardItems = useMemo(() => items.filter((it) => itemActiveSince(it, cutoff)), [items, cutoff]);
  const contractBoardStats = useMemo(
    () => findContractScopedStats(aggregates, { scope: "boardWindow", since }),
    [aggregates, since],
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
          {itemWindow?.truncated ? ` · loaded since ${loadedSince} · total ${itemWindow.total_items}` : ""}
        </span>
        <label className="date-filter board-since">
          active since <input type="date" min={loadedSince ?? undefined} value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <div className="toggle-group">
          <span className="toggle-label">since</span>
          {ACTIVE_SINCE_PRESETS.map(([lab, days]) => {
            const val = days == null ? "" : cutoffIso(days, generatedAtMs).slice(0, 10);
            const disabled = loadedSince !== null && (days == null || val < loadedSince);
            return (
              <button
                key={lab}
                type="button"
                className={`toggle${since === val ? " toggle-on" : ""}`}
                onClick={() => setSince(val)}
                disabled={disabled}
                title={disabled ? "Not loaded by this windowed contract" : undefined}
              >
                {lab}
              </button>
            );
          })}
        </div>
      </div>
      <StatsBar scoped={boardStats} />
      <section className="board-7">
        {STATUS_ORDER.map((s) => (
          <Column key={s} kind={s} label={STATUS_LABEL[s]} sub={STATUS_DESC[s]} items={statusCols[s]} cap={CAPPED_STATUS.has(s) ? COLUMN_CAP : undefined} sourceKind={sourceKind} colorOf={colorOf} linkedIds={linkedIds} />
        ))}
        {lanes.map(({ lane, items: laneItems }) => (
          <Column key={lane.key} kind={`lane-${lane.key}`} label={lane.label} sub={lane.hint} items={laneItems} cap={COLUMN_CAP} sourceKind={sourceKind} colorOf={colorOf} linkedIds={linkedIds} />
        ))}
      </section>
    </>
  );
}
