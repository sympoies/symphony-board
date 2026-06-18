import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { activeTimeRangePresetId, isDateOnly, normalizeTimeRange, TIME_RANGE_PRESETS, timeRangeForPreset, type TimeRange, type TimeRangePresetId } from "../model.ts";

const DISPLAY_DATE_PATTERN = "\\d{4}/\\d{2}/\\d{2}";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type RangeField = "from" | "to";
type DisplayRange = Record<RangeField, string>;

function dateOnlyToDisplay(value: string): string {
  return value.replaceAll("-", "/");
}

function rangeToDisplay(range: TimeRange): DisplayRange {
  return { from: dateOnlyToDisplay(range.from), to: dateOnlyToDisplay(range.to) };
}

function normalizeDateDisplayInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (!digits) return "";
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}/${digits.slice(4)}`;
  return `${digits.slice(0, 4)}/${digits.slice(4, 6)}/${digits.slice(6)}`;
}

function displayToDateOnly(value: string): string | null {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return isDateOnly(date) ? date : null;
}

function dateOnlyUtcMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

function dateOnlyFromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftDateOnly(date: string, days: number): string {
  return dateOnlyFromUtcMs(dateOnlyUtcMs(date) + days * DAY_MS);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function shiftMonth(date: string, months: number): string {
  const [year, month] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1 + months, 1));
  return shifted.toISOString().slice(0, 10);
}

function monthLabel(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return `${MONTH_LABELS[month! - 1]} ${year}`;
}

function calendarDates(month: string): string[] {
  const first = monthStart(month);
  const start = shiftDateOnly(first, -new Date(`${first}T00:00:00.000Z`).getUTCDay());
  return Array.from({ length: 42 }, (_, index) => shiftDateOnly(start, index));
}

export function TimeRangeControls({
  range,
  generatedAt,
  timezone,
  preferredPresetId,
  loading,
  error,
  suspended,
  collapsibleOnNarrow,
  mobilePanel,
  onRange,
  onMobilePanel,
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
  // On narrow/portrait, collapse the range fields + quick presets behind a
  // disclosure that summarizes the active range, so a long-feed page (Commits)
  // doesn't spend the first screen on date controls. Desktop always shows them.
  collapsibleOnNarrow?: boolean;
  mobilePanel?: "search" | "filters" | "range" | null;
  onRange: (range: TimeRange, presetId?: TimeRangePresetId | null) => void;
  onMobilePanel?: (panel: "search" | "filters" | "range" | null) => void;
}) {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [draftDisplay, setDraftDisplay] = useState<DisplayRange>(() => rangeToDisplay(range));
  const [localRangeOpen, setLocalRangeOpen] = useState(false);
  const [openPicker, setOpenPicker] = useState<RangeField | null>(null);
  const [pickerMonth, setPickerMonth] = useState(() => monthStart(range.to));
  const generatedAtMs = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
  const presetOptions = TIME_RANGE_PRESETS.map((option) => ({ option, range: timeRangeForPreset(option.id, generatedAtMs, timezone) }));
  const activePresetId = activeTimeRangePresetId(range, generatedAtMs, preferredPresetId, timezone);
  // Collapsed-state summary for the narrow disclosure: the active quick preset's
  // label, else the explicit from–to range.
  const activePresetLabel = presetOptions.find(({ option }) => option.id === activePresetId)?.option.label ?? null;
  const rangeSummary = activePresetLabel ?? `${dateOnlyToDisplay(range.from)} – ${dateOnlyToDisplay(range.to)}`;
  const rangeOpen = mobilePanel === undefined ? localRangeOpen : mobilePanel === "range";
  const setRangeOpen = (open: boolean) => {
    if (mobilePanel === undefined) setLocalRangeOpen(open);
    else onMobilePanel?.(open ? "range" : null);
  };
  useEffect(() => setDraftDisplay(rangeToDisplay(range)), [range.from, range.to]);
  useEffect(() => {
    if (!openPicker) return;
    const onPointerDown = (event: PointerEvent) => {
      if (controlsRef.current?.contains(event.target as Node)) return;
      setOpenPicker(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openPicker]);
  const parsedDraftRange = {
    from: displayToDateOnly(draftDisplay.from),
    to: displayToDateOnly(draftDisplay.to),
  };
  const setDraft = (field: RangeField, value: string) => {
    const nextDisplay = { ...draftDisplay, [field]: normalizeDateDisplayInput(value) };
    setDraftDisplay(nextDisplay);
    const normalized = normalizeTimeRange({
      from: displayToDateOnly(nextDisplay.from) ?? undefined,
      to: displayToDateOnly(nextDisplay.to) ?? undefined,
    });
    if (normalized && (normalized.from !== range.from || normalized.to !== range.to)) onRange(normalized, null);
  };
  const resetInvalidDraft = (field: RangeField) => {
    const date = displayToDateOnly(draftDisplay[field]);
    if (!date || draftOrderInvalid) {
      setDraftDisplay(rangeToDisplay(range));
      return;
    }
    setDraftDisplay((current) => ({ ...current, [field]: dateOnlyToDisplay(date) }));
  };
  const resetOnEscape = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    setDraftDisplay(rangeToDisplay(range));
    setOpenPicker(null);
    event.currentTarget.blur();
  };
  const fromIsDate = !!parsedDraftRange.from;
  const toIsDate = !!parsedDraftRange.to;
  const draftOrderInvalid = fromIsDate && toIsDate && parsedDraftRange.from! > parsedDraftRange.to!;
  const fromInvalid = (!!draftDisplay.from && draftDisplay.from.length >= 10 && !fromIsDate) || draftOrderInvalid;
  const toInvalid = (!!draftDisplay.to && draftDisplay.to.length >= 10 && !toIsDate) || draftOrderInvalid;
  const openCalendar = (field: RangeField) => {
    const date = (field === "from" ? parsedDraftRange.from : parsedDraftRange.to) ?? range[field];
    setPickerMonth(monthStart(date));
    setOpenPicker((current) => (current === field ? null : field));
  };
  const commitDate = (field: RangeField, date: string) => {
    const next = {
      from: field === "from" ? date : (parsedDraftRange.from ?? range.from),
      to: field === "to" ? date : (parsedDraftRange.to ?? range.to),
    };
    const normalized = normalizeTimeRange(next);
    if (!normalized) return;
    setDraftDisplay(rangeToDisplay(normalized));
    setOpenPicker(null);
    if (normalized.from !== range.from || normalized.to !== range.to) onRange(normalized, null);
  };
  const picker = (field: RangeField) => {
    if (openPicker !== field) return null;
    const selectedDate = field === "from" ? parsedDraftRange.from : parsedDraftRange.to;
    const minDate = field === "to" ? (parsedDraftRange.from ?? range.from) : null;
    const maxDate = field === "from" ? (parsedDraftRange.to ?? range.to) : null;
    return (
      <div className="date-picker-popover" role="dialog" aria-label={`${field} date picker`}>
        <div className="date-picker-head">
          <button type="button" className="date-picker-nav" aria-label="Previous month" onMouseDown={(e) => e.preventDefault()} onClick={() => setPickerMonth((current) => shiftMonth(current, -1))}>
            <span aria-hidden="true">‹</span>
          </button>
          <span className="date-picker-month">{monthLabel(pickerMonth)}</span>
          <button type="button" className="date-picker-nav" aria-label="Next month" onMouseDown={(e) => e.preventDefault()} onClick={() => setPickerMonth((current) => shiftMonth(current, 1))}>
            <span aria-hidden="true">›</span>
          </button>
        </div>
        <div className="date-picker-grid date-picker-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
        </div>
        <div className="date-picker-grid">
          {calendarDates(pickerMonth).map((date) => {
            const disabled = (!!minDate && date < minDate) || (!!maxDate && date > maxDate);
            const outside = date.slice(0, 7) !== pickerMonth.slice(0, 7);
            const selected = date === selectedDate;
            return (
              <button
                key={date}
                type="button"
                className={`date-picker-day${outside ? " date-picker-day-outside" : ""}${selected ? " date-picker-day-selected" : ""}`}
                disabled={disabled}
                aria-pressed={selected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commitDate(field, date)}
              >
                {Number(date.slice(8, 10))}
              </button>
            );
          })}
        </div>
      </div>
    );
  };
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
  const rangeBody = (className: string) => (
    <div className={className}>
      <span className="muted time-range-label">range</span>
      <label className="date-filter">
        from
        <span className="date-input-wrap">
          <input
            className="date-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            pattern={DISPLAY_DATE_PATTERN}
            maxLength={10}
            value={draftDisplay.from}
            placeholder="YYYY/MM/DD"
            aria-invalid={fromInvalid}
            disabled={suspended}
            onBlur={() => resetInvalidDraft("from")}
            onChange={(e) => setDraft("from", e.target.value)}
            onKeyDown={resetOnEscape}
          />
          <button type="button" className="date-picker-button" aria-label="Open from calendar" aria-expanded={openPicker === "from"} disabled={suspended} onMouseDown={(e) => e.preventDefault()} onClick={() => openCalendar("from")}>
            <span className="date-picker-icon" aria-hidden="true" />
          </button>
        </span>
        {picker("from")}
      </label>
      <label className="date-filter">
        to
        <span className="date-input-wrap">
          <input
            className="date-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            pattern={DISPLAY_DATE_PATTERN}
            maxLength={10}
            value={draftDisplay.to}
            placeholder="YYYY/MM/DD"
            aria-invalid={toInvalid}
            disabled={suspended}
            onBlur={() => resetInvalidDraft("to")}
            onChange={(e) => setDraft("to", e.target.value)}
            onKeyDown={resetOnEscape}
          />
          <button type="button" className="date-picker-button" aria-label="Open to calendar" aria-expanded={openPicker === "to"} disabled={suspended} onMouseDown={(e) => e.preventDefault()} onClick={() => openCalendar("to")}>
            <span className="date-picker-icon" aria-hidden="true" />
          </button>
        </span>
        {picker("to")}
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
  return (
    <div
      ref={controlsRef}
      className={`time-range-controls${suspended ? " range-suspended" : ""}`}
      data-range-collapsed={collapsibleOnNarrow && !rangeOpen ? "true" : undefined}
      title={suspended ? "Time range doesn't apply while an item is focused in the graph — the focus view shows the item's full neighbourhood. Leave focus to re-enable." : undefined}
    >
      {collapsibleOnNarrow ? (
        <button
          type="button"
          className="filter-summary-disclosure range-disclosure"
          aria-expanded={rangeOpen}
          onClick={() => setRangeOpen(!rangeOpen)}
        >
          <span className="filter-summary-disclosure-label">range</span>
          <span className="filter-summary-disclosure-summary">{rangeSummary}</span>
          <span className="filter-summary-disclosure-caret" aria-hidden="true" />
        </button>
      ) : null}
      {rangeBody("time-range-inline")}
      {rangeOpen ? (
        <>
          <button type="button" className="mobile-control-backdrop" aria-label="Close controls" onClick={() => setRangeOpen(false)} />
          <div
            id="mobile-range-panel"
            className="mobile-control-sheet"
            data-panel="range"
            role="dialog"
            aria-modal="false"
            aria-labelledby="mobile-range-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") setRangeOpen(false);
            }}
          >
            <div className="mobile-control-sheet-head">
              <strong id="mobile-range-title" className="mobile-control-sheet-title">Range</strong>
              <button type="button" className="mobile-control-sheet-close" aria-label="Close controls" onClick={() => setRangeOpen(false)}>
                ×
              </button>
            </div>
            {rangeBody("time-range-sheet-body")}
          </div>
        </>
      ) : null}
    </div>
  );
}
