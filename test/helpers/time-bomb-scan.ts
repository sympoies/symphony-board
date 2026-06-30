// Detector for "clock-relative time-bomb" fixtures.
//
// A hardcoded FUTURE date literal assigned to a TTL/timestamp key (e.g.
// `expires_at`) is dangerous when production compares that field to the REAL
// wall clock — `src/live/store.ts` filters `expires_at >= now` with a default
// `now = new Date()`. The fixture passes until its calendar date arrives, then
// silently flips to expired and reddens CI with no code change. That is exactly
// how three live-store tests broke on 2026-06-28 (#527).
//
// This scanner catches the literal at write time, while it is still in the
// future. Scope is deliberately narrow to stay false-positive-free:
//   - only date literals ASSIGNED to a known TTL/timestamp key (`expires_at:
//     "…"`, JSON `"expires_at": "…"`) — never bare literals or `obj.expires_at`
//     reads in assertions;
//   - only when the date is "now-ish or near-future" (default now-1d … now+400d),
//     so clearly-past fixtures (the intentionally-expired prune cases) and
//     far-future sentinels (9999-…) are ignored.
// A legitimate fixed-clock fixture (one gated by an INJECTED clock, not the real
// one) opts out with a `// fixed-clock: <reason>` comment on the same line.

// Timestamp keys that production code compares against the real clock.
export const TTL_KEYS = ["expires_at", "expires", "valid_until", "fetched_at", "received_at"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// `expires_at: "<iso>"` (JS) or `"expires_at": "<iso>"` (JSON). The optional
// quote after the key absorbs the JSON closing quote; requiring `:` or `=` right
// after rules out `obj.expires_at,` reads in assertions.
const KEY_DATE_RE = new RegExp(
  String.raw`\b(${TTL_KEYS.join("|")})\b["']?\s*[:=]\s*["'](\d{4}-\d{2}-\d{2}[T0-9:.+Zz-]*)["']`,
);

export interface TimeBombViolation {
  line: number; // 1-based
  key: string;
  date: string; // the matched ISO literal
  text: string; // the offending line, trimmed
}

export interface ScanOptions {
  now?: number; // wall clock to compare against (default Date.now())
  pastGraceDays?: number; // also flag dates newer than now - this (default 1)
  futureHorizonDays?: number; // flag dates up to now + this (default 400)
}

// Return the time-bomb violations in one file's text. Pure: deterministic given
// `text` and `opts.now`.
export function scanTimeBombFixtures(text: string, opts: ScanOptions = {}): TimeBombViolation[] {
  const now = opts.now ?? Date.now();
  const earliest = now - (opts.pastGraceDays ?? 1) * DAY_MS;
  const latest = now + (opts.futureHorizonDays ?? 400) * DAY_MS;
  const violations: TimeBombViolation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("fixed-clock:")) continue; // explicit opt-out
    const m = KEY_DATE_RE.exec(line);
    const key = m?.[1];
    const dateLit = m?.[2];
    if (key === undefined || dateLit === undefined) continue;
    const ts = Date.parse(dateLit);
    if (Number.isNaN(ts)) continue;
    if (ts >= earliest && ts <= latest) {
      violations.push({ line: i + 1, key, date: dateLit, text: line.trim() });
    }
  }
  return violations;
}
