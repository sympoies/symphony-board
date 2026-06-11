import { activeTimeRangePresetId, TIME_RANGE_PRESETS, timeRangeForPreset, type TimeRange, type TimeRangePresetId } from "../model.ts";

export function TimeRangeControls({
  range,
  generatedAt,
  timezone,
  preferredPresetId,
  loading,
  error,
  suspended,
  onRange,
}: {
  range: TimeRange;
  generatedAt: string;
  timezone: string;
  preferredPresetId?: TimeRangePresetId | null;
  loading?: boolean;
  error?: string | null;
  // True while the current view ignores the time range (the graph's focus view
  // shows an item's FULL neighbourhood). The selection is KEPT — the active
  // preset stays highlighted — but the whole control dims and interaction is
  // disabled, so the user sees their range is remembered yet not in effect.
  // Clearing focus flips this back without losing the selection.
  suspended?: boolean;
  onRange: (range: TimeRange, presetId?: TimeRangePresetId | null) => void;
}) {
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
  const presetOptions = TIME_RANGE_PRESETS.map((option) => ({ option, range: timeRangeForPreset(option.id, generatedAtMs, timezone) }));
  const activePresetId = activeTimeRangePresetId(range, generatedAtMs, preferredPresetId, timezone);
  const setFrom = (from: string) => onRange({ ...range, from }, null);
  const setTo = (to: string) => onRange({ ...range, to }, null);
  const presetButtons = (group: "calendar" | "rolling") =>
    presetOptions
      .filter(({ option }) => option.group === group)
      .map(({ option, range: preset }) => {
        const active = option.id === activePresetId;
        return (
          <button key={option.id} type="button" className={`toggle${active ? " toggle-on" : ""}`} disabled={suspended} onClick={() => onRange(preset, option.id)}>
            {option.label}
          </button>
        );
      });
  return (
    <div
      className={`time-range-controls${suspended ? " range-suspended" : ""}`}
      title={suspended ? "Time range doesn't apply while an item is focused in the graph — the focus view shows the item's full neighbourhood. Leave focus to re-enable." : undefined}
    >
      <span className="muted">range</span>
      <label className="date-filter">
        from <input type="date" value={range.from} max={range.to} disabled={suspended} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="date-filter">
        to <input type="date" value={range.to} min={range.from} disabled={suspended} onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className="toggle-group">
        <span className="toggle-label">quick</span>
        {presetButtons("calendar")}
        <span className="toggle-separator" aria-hidden="true" />
        {presetButtons("rolling")}
      </div>
      {suspended ? <span className="muted">not applied in focus</span> : null}
      {loading ? <span className="muted">loading range...</span> : null}
      {error ? <span className="range-error">{error}</span> : null}
    </div>
  );
}
