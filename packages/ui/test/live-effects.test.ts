// Effect-behavior acceptance for the Live page hook. The hook's transport
// effects compose a small set of PURE state-machine helpers (the repo's "test
// the pure logic, smoke the render" convention): the render smoke now walks
// #/live and exercises the live wiring end to end, while these unit tests pin
// the recovery decisions the effects delegate to — poll prune/restart reseed,
// the snapshot->stream cursor handoff, and the new SSE `reset` re-seed — using
// the same fetch/snapshot mocking style as live.test.ts.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchLiveSnapshot } from "../src/contract.ts";
import {
  appendCapped,
  liveStreamUrl,
  planPollIngest,
  planSseResetSnapshot,
  planSseResetSnapshotFailure,
  planSseResetStart,
  planLiveConnection,
  planSnapshotFold,
  resolveProbeFailure,
  reconcileReset,
  parseResetEvent,
} from "../src/useLive.ts";
import { safeHref } from "../src/url.ts";
import type { LiveEvent, LiveSnapshot } from "../src/model.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const ev = (seq: number): LiveEvent => ({ seq }) as LiveEvent;
const snap = (max_seq: number, events: LiveEvent[]): LiveSnapshot => ({
  schema: "live-snapshot/1",
  events,
  max_seq,
  generated_at: "2026-06-20T10:00:00Z",
});

// --- appendCapped incremental single-event inserts (perf path) ---------------
// The SSE branch appends one frame at a time; the optimized appendCapped must
// keep the kept list newest-first, deduped by seq, and capped on every single
// insert — including out-of-order and overlapping arrivals.
test("appendCapped: incremental single-event inserts keep order, dedupe, and cap", () => {
  let kept: { seq: number }[] = [];
  for (const seq of [1, 2, 3]) kept = appendCapped(kept, [{ seq }], 10);
  assert.deepEqual(kept.map((e) => e.seq), [3, 2, 1]);
  // A duplicate seq replaces in place, never grows the list or reorders it.
  kept = appendCapped(kept, [{ seq: 2 }], 10);
  assert.deepEqual(kept.map((e) => e.seq), [3, 2, 1]);
  // An out-of-order (older) seq slots into the right position.
  kept = appendCapped(kept, [{ seq: 5 }], 10);
  assert.deepEqual(kept.map((e) => e.seq), [5, 3, 2, 1]);
  // A gap-filling middle seq lands between its neighbours.
  kept = appendCapped(kept, [{ seq: 4 }], 10);
  assert.deepEqual(kept.map((e) => e.seq), [5, 4, 3, 2, 1]);
  // The cap drops the OLDEST entries (tail), keeping the newest.
  kept = appendCapped(kept, [{ seq: 6 }], 3);
  assert.deepEqual(kept.map((e) => e.seq), [6, 5, 4]);
});

// --- snapshot -> stream cursor handoff ---------------------------------------
// The first SSE connect must resume from the snapshot's max_seq via ?since= so
// an event appended between snapshot and connect is not skipped or re-shown.
test("snapshot->stream handoff carries max_seq into the SSE ?since=", () => {
  const s = snap(7, [ev(7), ev(6)]);
  assert.equal(liveStreamUrl(null, s.max_seq), "./api/live?since=7");
  // A fresh (empty) snapshot connects without a cursor.
  assert.equal(liveStreamUrl(null, snap(0, []).max_seq), "./api/live");
});

// --- poll prune/restart reseed -----------------------------------------------
// When the receiver restarts or prunes below our cursor (snapshot max_seq drops
// under lastSeq), the poll path must drop the stale kept list and reseed from
// the snapshot rather than silently ingesting nothing.
test("planPollIngest reseeds when max_seq drops below the cursor", () => {
  // Steady state: snapshot ahead of the cursor -> ingest only the new tail.
  const ahead = planPollIngest(5, snap(7, [ev(7), ev(6), ev(5)]));
  assert.equal(ahead.reset, false);
  assert.deepEqual(ahead.ingest.map((e) => e.seq), [7, 6]);
  assert.equal(ahead.nextCursor, 7);

  // Prune/restart: snapshot max_seq is BELOW the cursor -> reset + reseed from
  // the snapshot, cursor follows the snapshot down.
  const pruned = planPollIngest(9, snap(2, [ev(2), ev(1)]));
  assert.equal(pruned.reset, true);
  assert.deepEqual(pruned.ingest.map((e) => e.seq), [2, 1]);
  assert.equal(pruned.nextCursor, 2);
});

// Availability is no longer a separate probe: `useLive` owns the one snapshot
// that both decides reachability AND seeds the buffer, gated solely on the user's
// `enabled` opt-in. An enabled-but-inactive tab still prewarms a single snapshot;
// a disabled tab (or a server-less Android client) issues NO request at all.
test("planLiveConnection gates the single live probe on the enabled opt-in", () => {
  assert.equal(
    planLiveConnection({ enabled: true, active: false, endpointBlocked: false }),
    "snapshot",
    "Live enabled but not currently shown -> seed once for cold-start readiness",
  );
  assert.equal(
    planLiveConnection({ enabled: true, active: true, endpointBlocked: false }),
    "stream",
    "the visible Live tab opens the normal stream/poll lifecycle",
  );
  assert.equal(
    planLiveConnection({ enabled: false, active: false, endpointBlocked: false }),
    "off",
    "Live disabled in Settings -> never connect, never probe",
  );
  assert.equal(
    planLiveConnection({ enabled: false, active: true, endpointBlocked: false }),
    "off",
    "a stale #/live with Live disabled must not open a connection",
  );
  assert.equal(
    planLiveConnection({ enabled: true, active: false, endpointBlocked: true }),
    "off",
    "Android without a configured server URL must not issue a relative request",
  );
});

// The cold-start regression guard: `connected` is the availability signal that
// hides the Live tab and bounces a stale #/live, so a TRANSIENT probe failure on
// the cold-start path must stay "Connecting…" (the poll loop recovers) and must
// NOT resolve to unavailable and bounce the user off a genuinely-Live deploy.
test("resolveProbeFailure keeps a transient cold-start failure connecting, not unavailable", () => {
  assert.equal(
    resolveProbeFailure({ everOpened: false, transient: true }),
    "keep-connecting",
    "first-probe transient failure (cold link) -> stay Connecting, let the loop retry",
  );
  assert.equal(
    resolveProbeFailure({ everOpened: false, transient: false }),
    "unavailable",
    "first-probe definitive failure (no receiver) -> unavailable (hides tab / bounces)",
  );
  assert.equal(
    resolveProbeFailure({ everOpened: true, transient: true }),
    "reconnecting",
    "a drop after a successful open is a transient reconnect, never unavailable",
  );
  assert.equal(
    resolveProbeFailure({ everOpened: true, transient: false }),
    "reconnecting",
    "even a definitive failure after a prior open is a reconnect, not a fresh unavailable",
  );
});

// The stale-while-revalidate cache handoff: the FIRST authoritative snapshot
// REPLACES the provisional cache seed wholesale so a cached row the server no
// longer returns cannot linger; otherwise it folds normally (merge / reseed).
test("planSnapshotFold replaces a cache seed but merges/reseeds otherwise", () => {
  // Replace: a cached-only event (seq 99, absent from the server snapshot) must
  // NOT survive the first authoritative snapshot.
  const replace = planSnapshotFold({
    cursor: 99,
    snapshot: snap(7, [ev(7), ev(6)]),
    seededFromCache: true,
    cap: 10,
  });
  assert.equal(replace.kind, "replace");
  if (replace.kind === "replace") {
    assert.deepEqual(replace.events.map((e) => e.seq), [7, 6], "buffer is exactly the server snapshot");
    assert.equal(replace.cursor, 7, "cursor follows the snapshot, not the stale cache");
  }

  // Replace honors the cap (newest-first).
  const capped = planSnapshotFold({
    cursor: 0,
    snapshot: snap(5, [ev(5), ev(4), ev(3)]),
    seededFromCache: true,
    cap: 2,
  });
  assert.equal(capped.kind === "replace" && capped.events.length, 2);

  // Merge (steady state): snapshot ahead of the cursor -> ingest only the tail.
  const merge = planSnapshotFold({
    cursor: 5,
    snapshot: snap(7, [ev(7), ev(6), ev(5)]),
    seededFromCache: false,
    cap: 10,
  });
  assert.equal(merge.kind, "merge");
  if (merge.kind === "merge") {
    assert.equal(merge.reset, false);
    assert.deepEqual(merge.ingest.map((e) => e.seq), [7, 6]);
    assert.equal(merge.cursor, 7);
  }

  // Reseed: snapshot behind the cursor (receiver restarted/pruned) -> reset.
  const reseed = planSnapshotFold({
    cursor: 9,
    snapshot: snap(2, [ev(2), ev(1)]),
    seededFromCache: false,
    cap: 10,
  });
  assert.equal(reseed.kind === "merge" && reseed.reset, true);
});

// --- SSE reset re-seed -------------------------------------------------------
// The backend emits `event: reset` with `{"reason":"gap","max_seq":N}` when the
// client cursor is ahead of the server or the replay backlog exceeds the cap.
// The server keeps streaming on the same connection, so the UI re-seeds from a
// fresh snapshot WITHOUT clobbering a frame that arrived during the refetch.
test("parseResetEvent reads the gap sentinel and tolerates junk", () => {
  assert.deepEqual(parseResetEvent('{"reason":"gap","max_seq":12}'), { reason: "gap", max_seq: 12 });
  // Missing/!finite max_seq -> a reset with no usable cursor (still triggers a
  // snapshot refetch; the snapshot supplies the authoritative max_seq).
  assert.deepEqual(parseResetEvent('{"reason":"gap"}'), { reason: "gap", max_seq: null });
  assert.equal(parseResetEvent("not json"), null);
});

test("reconcileReset re-seeds from the snapshot, drops stale rows, keeps newer frames", () => {
  // Before the reset the kept list holds a stale event (seq 9, no longer in the
  // snapshot) and a live frame (seq 12) that arrived on the SAME connection while
  // the snapshot refetch was in flight.
  const prev = [ev(12), ev(9)];
  const merged = reconcileReset(prev, snap(11, [ev(11), ev(10)]), 500);
  // seq 9 (<= max_seq 11 and absent from the snapshot) is dropped; seq 12
  // (> max_seq) survives the race; the snapshot's 11/10 merge in, newest-first.
  assert.deepEqual(
    merged.map((e) => e.seq),
    [12, 11, 10],
    "a frame newer than the snapshot is never lost to the reseed",
  );
});

test("reconcileReset can reseed when a reset lowers the stream sequence space", () => {
  // Receiver restart / store replacement: the snapshot's seq space is lower
  // than the kept buffer. Old high seq rows are stale and must not survive.
  const prev = [ev(100), ev(99)];
  const merged = reconcileReset(prev, snap(2, [ev(2), ev(1)]), 500, { reseed: true });
  assert.deepEqual(merged.map((e) => e.seq), [2, 1]);
});

test("SSE reset planning lowers stale cursors while preserving post-reset live frames", () => {
  const start = planSseResetStart(100, { reason: "stale_cursor", max_seq: 2 });
  assert.deepEqual(start, {
    retryCursor: 100,
    nextCursor: 2,
    clearBeforeFetch: true,
    reseedBeforeFetch: true,
  });

  // A live frame seq=3 arrived on the same EventSource after the reset and
  // before the snapshot refetch completed. Because the reset max_seq was known
  // before fetch, the stale high rows were already cleared and the frame is
  // preserved across the snapshot reseed.
  const snapshotPlan = planSseResetSnapshot(
    100,
    3,
    snap(2, [ev(2), ev(1)]),
    start,
  );
  assert.equal(snapshotPlan.nextCursor, 3);
  assert.deepEqual(snapshotPlan.reconcileOptions, { reseed: false });
  const merged = reconcileReset([ev(3)], snap(2, [ev(2), ev(1)]), 500, snapshotPlan.reconcileOptions);
  assert.deepEqual(merged.map((e) => e.seq), [3, 2, 1]);
});

test("SSE reset snapshot failure retries from the pre-reset cursor", () => {
  const start = planSseResetStart(100, { reason: "gap", max_seq: 25 });
  const retry = planSseResetSnapshotFailure(start);
  assert.deepEqual(retry, {
    retryCursor: 100,
    restoreCursor: 100,
  });
});

// --- safeHref scheme guard (defense-in-depth for webhook-sourced URLs) --------
// Event/target URLs originate from the webhook payload; only web/mail schemes may
// become a clickable href so a javascript:/data: value can never reach the DOM.
test("safeHref allows only http/https/mailto and drops dangerous schemes", () => {
  assert.equal(
    safeHref("https://github.com/sympoies/symphony-board/pull/305"),
    "https://github.com/sympoies/symphony-board/pull/305",
  );
  assert.equal(safeHref("http://example.com"), "http://example.com");
  assert.equal(safeHref("mailto:a@b.com"), "mailto:a@b.com");
  // eslint-disable-next-line no-script-url
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>1</script>"), null);
  assert.equal(safeHref("not a url"), null);
  assert.equal(safeHref(null), null);
  assert.equal(safeHref(undefined), null);
});

// fetchLiveSnapshot is the re-seed source for both the reset listener and the
// poll loop; confirm the stricter validation accepts a well-formed snapshot.
test("fetchLiveSnapshot accepts a well-formed live-snapshot/1 payload", async () => {
  stubFetch(200, snap(2, [ev(2), ev(1)]));
  const got = await fetchLiveSnapshot(null);
  assert.ok(got);
  assert.equal(got.max_seq, 2);
});

test("fetchLiveSnapshot requests the Live UI retention window when supplied", async () => {
  let requested = "";
  globalThis.fetch = (async (url) => {
    requested = String(url);
    return new Response(JSON.stringify(snap(2, [ev(2), ev(1)])), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const got = await fetchLiveSnapshot(null, 1000);
  assert.ok(got);
  assert.equal(requested, "./api/live-snapshot?limit=1000");
});

test("fetchLiveSnapshot carries the polling cursor when supplied", async () => {
  let requested = "";
  globalThis.fetch = (async (url) => {
    requested = String(url);
    return new Response(JSON.stringify(snap(7, [])), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const got = await fetchLiveSnapshot(null, 1000, 7);
  assert.ok(got);
  assert.equal(requested, "./api/live-snapshot?limit=1000&since=7");
});
