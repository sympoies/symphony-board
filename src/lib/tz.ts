// Timezone helpers for the read-only range API (producer side).
//
// The range API expands a `YYYY-MM-DD` query into the UTC instants that bound
// that local calendar day in the configured zone (the `timezone` from config;
// "UTC" when unset). It mirrors the UI's packages/ui/src/tz.ts day-boundary
// math so server-side windowing matches the zoned preset the UI computed.
//
// This is duplicated rather than shared because @symphony-board/contract is
// type-only at runtime (no runtime exports, so consumers under Node's
// type-stripping never resolve it) and the backend must not import UI code.
// Both copies are tiny and only cover the day-boundary conversion.

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

// The zone's UTC offset in ms (east-positive) at instant `ms`.
function offsetMsAt(ms: number, tz: string): number {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = field("hour");
  if (hour === 24) hour = 0;
  const asIfUtc = Date.UTC(field("year"), field("month") - 1, field("day"), hour, field("minute"), field("second"));
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

// Convert a wall-clock moment in `tz` to its UTC instant (ms), refined once for
// DST-transition correctness (no-op for a no-DST zone).
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

// Validate config-provided zones once; throws RangeError on a bad IANA name.
export function isValidTimezone(tz: string): boolean {
  if (tz === "UTC") return true;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
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

// "YYYY-MM-DD" — the calendar date of `ms` as seen in `tz`.
export function zonedDateOnly(ms: number, tz: string): string {
  if (tz === "UTC") return new Date(ms).toISOString().slice(0, 10);
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const field = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "00";
  return `${field("year").padStart(4, "0")}-${field("month")}-${field("day")}`;
}

// Calendar arithmetic on a "YYYY-MM-DD" string: shift by whole days, with month
// and year roll-over handled by Date.UTC normalization. Zone-independent.
export function shiftDateOnly(dateStr: string, deltaDays: number): string {
  const parts = dateStr.split("-");
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + deltaDays)).toISOString().slice(0, 10);
}
