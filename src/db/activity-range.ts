// Index-friendly bounds for a date-bounded activity read.
//
// `activity.occurred_at` is TEXT that PRESERVES the provider's original UTC
// offset (GitLab emits +08:00 and friends), so a raw text comparison is NOT
// instant-monotonic at the boundary — two rows with the same wall-clock but
// different offsets sort differently by text than by instant. The drivers
// therefore bound in two layers:
//
//   1. a COARSE text band (`occurred_at >= coarseFrom AND occurred_at <=
//      coarseTo`) that the existing `activity_by_time (occurred_at DESC)` index
//      can range-scan, so the query never reads the whole table; and
//   2. a PRECISE instant predicate (`julianday(occurred_at)` in SQLite,
//      `occurred_at::timestamptz` in Postgres) that trims the band's slop to the
//      exact [from, to] instants.
//
// The coarse band is widened by COARSE_MARGIN_HOURS — comfortably more than any
// real-world UTC offset (max ±14h) — so the text band can never exclude a row
// whose instant is in range (no false negatives); the precise predicate removes
// the false positives. The result is exactly the rows a JS `from <= t <= to`
// instant filter would keep.
const COARSE_MARGIN_HOURS = 48;

export interface ActivityRangeBounds {
  /** Lower text bound for the index range scan (UTC `Z`, widened). */
  coarseFrom: string;
  /** Upper text bound for the index range scan (UTC `Z`, widened). */
  coarseTo: string;
  /** Exact lower instant bound, as passed. */
  from: string;
  /** Exact upper instant bound, as passed. */
  to: string;
}

export function activityRangeBounds(fromIso: string, toIso: string): ActivityRangeBounds {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error(`activityRangeBounds: unparseable range (from=${fromIso}, to=${toIso})`);
  }
  const marginMs = COARSE_MARGIN_HOURS * 3_600_000;
  return {
    coarseFrom: new Date(fromMs - marginMs).toISOString(),
    coarseTo: new Date(toMs + marginMs).toISOString(),
    from: fromIso,
    to: toIso,
  };
}
