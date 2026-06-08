import { sameTimeRange, TIME_RANGE_PRESETS, timeRangeForPreset, type TimeRange, type TimeRangePresetId } from "../model.ts";

export function TimeRangeControls({
  range,
  generatedAt,
  preferredPresetId,
  loading,
  error,
  onRange,
}: {
  range: TimeRange;
  generatedAt: string;
  preferredPresetId?: TimeRangePresetId | null;
  loading?: boolean;
  error?: string | null;
  onRange: (range: TimeRange) => void;
}) {
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
  const presetOptions = TIME_RANGE_PRESETS.map((option) => ({ option, range: timeRangeForPreset(option.id, generatedAtMs) }));
  const matchingPresetIds = presetOptions
    .filter((candidate) => sameTimeRange(range, candidate.range))
    .map((candidate) => candidate.option.id);
  const activePresetId =
    preferredPresetId && matchingPresetIds.includes(preferredPresetId)
      ? preferredPresetId
      : (matchingPresetIds[0] ?? null);
  const setFrom = (from: string) => onRange({ ...range, from });
  const setTo = (to: string) => onRange({ ...range, to });
  return (
    <div className="time-range-controls">
      <span className="muted">range</span>
      <label className="date-filter">
        from <input type="date" value={range.from} max={range.to} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="date-filter">
        to <input type="date" value={range.to} min={range.from} onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className="toggle-group">
        <span className="toggle-label">quick</span>
        {presetOptions.map(({ option, range: preset }) => {
          const active = option.id === activePresetId;
          return (
            <button key={option.id} type="button" className={`toggle${active ? " toggle-on" : ""}`} onClick={() => onRange(preset)}>
              {option.label}
            </button>
          );
        })}
      </div>
      {loading ? <span className="muted">loading range...</span> : null}
      {error ? <span className="range-error">{error}</span> : null}
    </div>
  );
}
