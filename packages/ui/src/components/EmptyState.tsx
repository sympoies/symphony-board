import type { ReactNode } from "react";
import { emptyStateKind, rangeReachesDataTail, timeRangeForPreset, type TimeRange, type TimeRangePresetId } from "../model.ts";
import type { SyncState } from "../useSync.ts";

// One shared empty-state surface for every range-scoped page (Activity, Commits,
// Graph, Repo Analytics). It distinguishes WHY a page is empty and offers the
// matching escape hatch instead of a dead one-line "No X in this range.":
//   • board-empty  → guide to Settings / a first sync
//   • entity-empty → say this entity simply isn't on the board
//   • range-empty  → show the data extent and jump-to / widen the range
//   • filtered     → offer to clear the active filters
// The variant decision lives in the pure `emptyStateKind` (unit-tested); this
// component owns only the copy and the actions.
export function EmptyState({
  noun,
  boardEmpty,
  total,
  windowTotal,
  range,
  dataExtent,
  generatedAt,
  timezone,
  onRange,
  onClearFilters,
  onOpenSettings,
  sync,
}: {
  // Lower-case entity label woven into the copy, e.g. "activity", "commits".
  noun: string;
  boardEmpty: boolean;
  total: number;
  windowTotal: number;
  range: TimeRange;
  dataExtent: TimeRange | null;
  generatedAt: string;
  timezone: string;
  onRange?: (range: TimeRange, presetId?: TimeRangePresetId | null) => void;
  onClearFilters?: () => void;
  onOpenSettings?: () => void;
  sync?: SyncState;
}) {
  const kind = emptyStateKind({ boardEmpty, total, windowTotal });
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
  const goPreset = (id: TimeRangePresetId) => onRange?.(timeRangeForPreset(id, generatedAtMs, timezone), id);
  const goShowAll = () => (dataExtent ? onRange?.(dataExtent, null) : undefined);
  // "Jump to latest" must land on data even when the board has been idle longer
  // than a preset window: anchor a 30-day window to the newest data day
  // (dataExtent.to), not to the contract timestamp. Falls back to the 1mo preset
  // only when no extent is known (which can't happen in jump mode).
  const goLatest = () => {
    if (!dataExtent) return goPreset("1mo");
    const toMs = Date.parse(`${dataExtent.to}T00:00:00.000Z`);
    const from = new Date(toMs - 29 * 86_400_000).toISOString().slice(0, 10);
    onRange?.({ from: from < dataExtent.from ? dataExtent.from : from, to: dataExtent.to }, null);
  };

  let title: ReactNode;
  let body: ReactNode = null;
  let actions: ReactNode = null;

  if (kind === "board-empty") {
    title = "No data on the board yet.";
    body = sync?.available
      ? "Connect a source and run a sync to populate the board."
      : "No contract has been emitted yet.";
    const canSync = !!sync?.available && !!sync?.enabled;
    actions = (
      <div className="empty-actions">
        {onOpenSettings ? (
          <button type="button" className="empty-action primary" onClick={onOpenSettings}>
            Open Settings
          </button>
        ) : null}
        {canSync ? (
          <button
            type="button"
            className="empty-action"
            disabled={sync?.busy}
            onClick={() => sync?.start({ mode: "full", dry_run: false, source_id: null })}
          >
            {sync?.busy ? "Syncing…" : "Sync now"}
          </button>
        ) : null}
      </div>
    );
  } else if (kind === "entity-empty") {
    title = `No ${noun} on this board.`;
    body = "Nothing to show here yet.";
  } else if (kind === "range-empty") {
    title = range.from === range.to
      ? `No ${noun} on ${range.from}.`
      : `No ${noun} between ${range.from} and ${range.to}.`;
    if (rangeReachesDataTail(range, dataExtent)) {
      // New day / quiet period: the range already reaches the latest data, so
      // there is simply nothing here yet — nudge toward a wider window.
      body = "Nothing has landed here yet — try a wider range.";
      actions = onRange ? (
        <div className="empty-actions">
          <button type="button" className="empty-action primary" onClick={() => goPreset("1w")}>
            Last 7 days
          </button>
          <button type="button" className="empty-action" onClick={() => goPreset("1mo")}>
            Last 30 days
          </button>
          {dataExtent ? (
            <button type="button" className="empty-action" onClick={goShowAll}>
              Show all
            </button>
          ) : null}
        </div>
      ) : null;
    } else {
      // Stale / off-to-the-side range: the data lives elsewhere — point to it.
      body = dataExtent ? `This board has ${noun} from ${dataExtent.from} to ${dataExtent.to}.` : null;
      actions = onRange ? (
        <div className="empty-actions">
          <button type="button" className="empty-action primary" onClick={goLatest}>
            Jump to latest
          </button>
          <button type="button" className="empty-action" onClick={() => goPreset("this-week")}>
            This week
          </button>
          {dataExtent ? (
            <button type="button" className="empty-action" onClick={goShowAll}>
              Show all
            </button>
          ) : null}
        </div>
      ) : null;
    }
  } else {
    title = `No ${noun} match the current filters.`;
    actions = onClearFilters ? (
      <div className="empty-actions">
        <button type="button" className="empty-action primary" onClick={onClearFilters}>
          Clear filters
        </button>
      </div>
    ) : null;
  }

  return (
    <div className="empty empty-state">
      <p className="empty-state-title">{title}</p>
      {body ? <p className="empty-state-body">{body}</p> : null}
      {actions}
    </div>
  );
}
