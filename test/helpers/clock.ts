// Test clock helpers.
//
// Use `relativeExpiry()` for any fixture whose `expires_at` (or similar TTL
// field) round-trips a real-`Date.now()` comparison — e.g. `live_actor_profile`
// rows, which `src/live/store.ts` filters with `expires_at >= now`. NEVER
// hardcode a near-future date in such a fixture: a literal like "2026-06-28"
// expires against the wall clock once that day passes and silently reddens CI
// with no code change (the #527 regression). The `no-time-bomb-fixtures` guard
// enforces this. The alternative, when a test asserts exact expiry math, is to
// inject a fixed clock into the code under test (see the prune tests in
// test/live-store.test.ts).
const DAY_MS = 24 * 60 * 60 * 1000;

// An ISO expiry `daysFromNow` in the future (default one year), computed from the
// real clock so it can never go stale. Returns a literal-free value the guard
// never flags.
export function relativeExpiry(daysFromNow = 365): string {
  return new Date(Date.now() + daysFromNow * DAY_MS).toISOString();
}
