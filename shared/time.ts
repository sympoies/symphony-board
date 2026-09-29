// Pure calendar and timestamp helpers shared by producer and consumer.
// No UI, provider, storage, or runtime package dependencies.

const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = FMT_CACHE.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FMT_CACHE.set(tz, fmt);
  }
  return fmt;
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    formatterFor(value);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

// The wall-clock fields observed in `tz` at instant `ms`.
function wallClockOf(ms: number, tz: string): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = field("hour");
  if (hour === 24) hour = 0; // some engines render midnight as 24 under h23
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour,
    minute: field("minute"),
    second: field("second"),
  };
}

// The zone's UTC offset in ms (east-positive) at instant `ms`. Derived by
// reinterpreting the zone wall clock as if it were UTC and differencing.
function offsetMsAt(ms: number, tz: string): number {
  const wc = wallClockOf(ms, tz);
  const asIfUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  // The wall clock has no sub-second component, so compare against `ms` floored
  // to whole seconds; the remainder is the (whole-minute) zone offset.
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pad4 = (n: number): string => String(n).padStart(4, "0");

// Convert a wall-clock moment in `tz` to its UTC instant (ms). One offset
// lookup, refined once so a wall clock that straddles a DST transition resolves
// to the correct instant; for a no-DST zone (e.g. Asia/Taipei) the refine is a
// no-op.
function zonedWallToInstantMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const off = offsetMsAt(guess, tz);
  const instant = guess - off;
  const off2 = offsetMsAt(instant, tz);
  return off2 === off ? instant : guess - off2;
}

// "YYYY-MM-DD" — the calendar date of `ms` as seen in `tz`.
export function zonedDateOnly(ms: number, tz: string): string {
  if (tz === "UTC") return new Date(ms).toISOString().slice(0, 10);
  const wc = wallClockOf(ms, tz);
  return `${pad4(wc.year)}-${pad2(wc.month)}-${pad2(wc.day)}`;
}

// Weekday (0 = Sunday … 6 = Saturday) of the calendar date of `ms` in `tz`.
export function zonedWeekday(ms: number, tz: string): number {
  if (tz === "UTC") return new Date(ms).getUTCDay();
  const wc = wallClockOf(ms, tz);
  return new Date(Date.UTC(wc.year, wc.month - 1, wc.day)).getUTCDay();
}

// Hour of day (0-23) of the instant as seen in `tz`.
export function zonedHour(ms: number, tz: string): number {
  if (tz === "UTC") return new Date(ms).getUTCHours();
  return wallClockOf(ms, tz).hour;
}

// UTC ISO instant for the START of local day `dateStr` (00:00:00.000) in `tz`.
export function zonedDayStartIso(dateStr: string, tz: string): string {
  if (tz === "UTC") return `${dateStr}T00:00:00.000Z`;
  const parts = dateStr.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return new Date(zonedWallToInstantMs(y, m, d, 0, 0, 0, 0, tz)).toISOString();
}

// UTC ISO instant for the END of local day `dateStr` (23:59:59.999) in `tz`.
export function zonedDayEndIso(dateStr: string, tz: string): string {
  if (tz === "UTC") return `${dateStr}T23:59:59.999Z`;
  const parts = dateStr.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return new Date(zonedWallToInstantMs(y, m, d, 23, 59, 59, 999, tz)).toISOString();
}

// Calendar arithmetic on a "YYYY-MM-DD" string: shift by whole days, with month
// and year roll-over handled by Date.UTC normalization. Zone-independent — a
// calendar date plus N days is the same date in any zone.
export function shiftDateOnly(dateStr: string, deltaDays: number): string {
  const parts = dateStr.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

export function zonedHourStartIso(dateStr: string, hour: number, tz: string): string {
  if (hour >= 24) return zonedDayStartIso(shiftDateOnly(dateStr, 1), tz);
  if (tz === "UTC") return `${dateStr}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const parts = dateStr.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return new Date(zonedWallToInstantMs(y, m, d, hour, 0, 0, 0, tz)).toISOString();
}

export function timestampMs(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

export function timestampInRange(value: string | null | undefined, range: { from: string; to: string }): boolean {
  const valueMs = timestampMs(value);
  const fromMs = timestampMs(range.from);
  const toMs = timestampMs(range.to);
  return valueMs !== null && fromMs !== null && toMs !== null && valueMs >= fromMs && valueMs <= toMs;
}

export function compareTimestampDesc(a: string | null | undefined, b: string | null | undefined): number {
  const aMs = timestampMs(a);
  const bMs = timestampMs(b);
  if (aMs !== null && bMs !== null && aMs !== bMs) return bMs - aMs;
  if (aMs !== null && bMs === null) return -1;
  if (aMs === null && bMs !== null) return 1;
  return 0;
}
