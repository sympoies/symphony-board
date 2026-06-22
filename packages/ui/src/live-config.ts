// Max events retained in the in-memory live buffer (the eviction cap).
export const LIVE_EVENT_BUFFER_LIMIT = 1000;

// Events fetched for the COLD-START seed (and an SSE reset reseed). Far smaller
// than the buffer cap on purpose: a full 1000-event snapshot is ~26MB because
// each event carries its full `raw` webhook payload (~30KB/event), which a phone
// must download and JSON.parse before the feed can paint — the dominant cause of
// a long cold-start "Connecting…". The feed only needs recent events; the buffer
// still grows toward the cap as new events stream in (poll/SSE), and steady-state
// polls are already small (they pass `?since=<cursor>`).
export const LIVE_SEED_LIMIT = 200;
