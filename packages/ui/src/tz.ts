// Timezone helpers for calendar-day bucketing (LAYER 3 consumer concern).
//
// The board compares absolute instants in UTC everywhere — that stays. These
// helpers answer the *other* question: which CALENDAR DAY an instant falls on
// in a configured IANA zone, and what UTC instants bound a local calendar day.
// The zone is the contract envelope's `timezone` (from config; "UTC" when
// unset). With it, the `today` / `this week` presets and the activity-heatmap
// day cells align to the viewer's local days instead of UTC.
//
// Intl.DateTimeFormat is the only dependency-free way to resolve an IANA zone's
// offset including DST, so we lean on it. Formatters are cached per zone because
// the heatmap calls these once per activity row.
//
// "UTC" short-circuits to the plain `toISOString()` path so behaviour and tests
// are byte-identical to the pre-3.1.0 board.

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
