import { useEffect, useState, type KeyboardEvent } from "react";
import { activeTimeRangePresetId, isDateOnly, normalizeTimeRange, TIME_RANGE_PRESETS, timeRangeForPreset, type TimeRange, type TimeRangePresetId } from "../model.ts";

const DATE_ONLY_PATTERN = "\\d{4}-\\d{2}-\\d{2}";

function padDatePart(value: string): string {
  return value.padStart(2, "0");
}

function normalizeDateDraftInput(value: string): string {
  const trimmed = value.trim();
  const yearFirst = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (yearFirst) return `${yearFirst[1]}-${padDatePart(yearFirst[2]!)}-${padDatePart(yearFirst[3]!)}`;
  const monthFirst = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (monthFirst) return `${monthFirst[3]}-${padDatePart(monthFirst[1]!)}-${padDatePart(monthFirst[2]!)}`;
  return trimmed.replace(/[^\d-]/g, "").slice(0, 10);
}

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
  const [draftRange, setDraftRange] = useState<TimeRange>(range);
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
  const presetOptions = TIME_RANGE_PRESETS.map((option) => ({ option, range: timeRangeForPreset(option.id, generatedAtMs, timezone) }));
  const activePresetId = activeTimeRangePresetId(range, generatedAtMs, preferredPresetId, timezone);
  useEffect(() => setDraftRange(range), [range.from, range.to]);
  const setDraft = (field: "from" | "to", value: string) => {
    const next = { ...draftRange, [field]: normalizeDateDraftInput(value) };
    setDraftRange(next);
    const normalized = normalizeTimeRange(next);
    if (normalized && (normalized.from !== range.from || normalized.to !== range.to)) onRange(normalized, null);
  };
  const resetInvalidDraft = (field: "from" | "to") => {
    if (!isDateOnly(draftRange[field])) setDraftRange(range);
  };
  const resetOnEscape = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    setDraftRange(range);
    event.currentTarget.blur();
  };
  const fromIsDate = isDateOnly(draftRange.from);
  const toIsDate = isDateOnly(draftRange.to);
  const draftOrderInvalid = fromIsDate && toIsDate && draftRange.from > draftRange.to;
  const fromInvalid = (!!draftRange.from && draftRange.from.length >= 10 && !fromIsDate) || draftOrderInvalid;
  const toInvalid = (!!draftRange.to && draftRange.to.length >= 10 && !toIsDate) || draftOrderInvalid;
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
        from
        <input
          className="date-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          pattern={DATE_ONLY_PATTERN}
          maxLength={10}
          value={draftRange.from}
          placeholder="YYYY-MM-DD"
          aria-invalid={fromInvalid}
          disabled={suspended}
          onBlur={() => resetInvalidDraft("from")}
          onChange={(e) => setDraft("from", e.target.value)}
          onKeyDown={resetOnEscape}
        />
      </label>
      <label className="date-filter">
        to
        <input
          className="date-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          pattern={DATE_ONLY_PATTERN}
          maxLength={10}
          value={draftRange.to}
          placeholder="YYYY-MM-DD"
          aria-invalid={toInvalid}
          disabled={suspended}
          onBlur={() => resetInvalidDraft("to")}
          onChange={(e) => setDraft("to", e.target.value)}
          onKeyDown={resetOnEscape}
        />
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
