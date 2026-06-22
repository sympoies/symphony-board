// Bounded-concurrency map. Runs `fn` over `items` with at most `limit` tasks in
// flight at once and returns the results in INPUT order (not completion order).
//
// The provider sources use this to overlap their independent per-item resolve
// round-trips — each issue/MR/PR needs its own extra GraphQL/REST call after the
// bulk page fetch (an N+1) — without firing an unbounded burst that would trip a
// provider's secondary rate limit / abuse detection. Page fetches stay
// sequential by nature (each cursor-chains off the previous page's endCursor);
// only these mutually independent per-item calls overlap, capped by `limit`.
//
// `fn` owns its own error handling: a throw rejects the whole map (mirroring
// Promise.all), so a caller that must keep going on a per-item failure should
// catch inside `fn` and return a sentinel — which is exactly what the sources do
// to preserve their "one bad item degrades to complete:false, never aborts the
// sweep" invariant.
//
// `limit` is clamped to a sane worker count: a value below 1 (or non-finite)
// runs sequentially, and a value above `items.length` never spawns idle workers.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workers = Math.max(1, Math.min(requested, items.length));

  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

// Per-item resolve concurrency for the provider sources. Conservative by
// default: a handful of overlapping requests cuts wall-clock on the per-item
// resolve pass without approaching a provider's burst threshold. Override with
// SYNC_RESOLVE_CONCURRENCY (a positive integer); anything unset or invalid falls
// back to the default. Read at call time so the daemon and tests pick up the env
// without a restart.
export const DEFAULT_RESOLVE_CONCURRENCY = 4;

export function resolveConcurrency(): number {
  const raw = Number(process.env.SYNC_RESOLVE_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_RESOLVE_CONCURRENCY;
}
