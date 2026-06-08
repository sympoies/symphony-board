import { TIME_RANGE_PRESETS, timeRangeForPreset, type TimeRange } from "../model.ts";

export function TimeRangeControls({
  range,
  generatedAt,
  loading,
  error,
  onRange,
}: {
  range: TimeRange;
  generatedAt: string;
  loading?: boolean;
  error?: string | null;
  onRange: (range: TimeRange) => void;
}) {
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
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
        {TIME_RANGE_PRESETS.map((option) => {
          const preset = timeRangeForPreset(option.id, generatedAtMs);
          const active = range.from === preset.from && range.to === preset.to;
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
