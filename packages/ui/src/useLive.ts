// Live event stream hook for the #/live page. Browser/web: native EventSource
// (true streaming). Tauri thin clients: interval polling of the snapshot
// (plugin-http is request/response, not a live stream). Both seed from the
// snapshot first and carry its max_seq into the stream cursor so an event
// appended between snapshot and connect is not lost (EventSource cannot set
// Last-Event-ID on the initial connect). Contract-independent: depends on no
// loaded contract. The pure helpers are unit-tested (live.test.ts /
// live-effects.test.ts); the effects are walked by the render smoke (it drives
// #/live against a mocked /api/live-snapshot).
import { useEffect, useRef, useState } from "react";
import {
  endpointRequiresServerUrl,
  fetchLiveSnapshot,
  resolveEndpoint,
  LIVE_SNAPSHOT_PROBE_RETRIES,
} from "./contract.ts";
import { loadCachedLiveSnapshot, saveCachedLiveSnapshot } from "./live-cache.ts";
import { LIVE_EVENT_BUFFER_LIMIT } from "./live-config.ts";
import { isTauriRuntime } from "./runtime.ts";
import type { LiveEvent, LiveSnapshot } from "./model.ts";

const POLL_INTERVAL_MS = 3000;

// EventSource only streams in a real browser; under Tauri (plugin-http) and
// where EventSource is absent, fall back to polling.
export function pickLiveTransport(env: {
  tauri: boolean;
  hasEventSource: boolean;
}): "sse" | "poll" {
  return !env.tauri && env.hasEventSource ? "sse" : "poll";
}

// Merge new events into the kept list: dedupe by seq, newest-first, capped.
// Robust to snapshot/stream overlap and out-of-order arrival.
//
// The kept list is already sorted newest-first; the SSE branch appends one
// frame at a time, so the common case is a single event newer than everything
// kept. Rather than rebuild a Map and full-sort up to `max` entries on every
// frame, insert each incoming event at its sorted position (binary search) and
// dedupe in place. A run of in-order tail appends is then O(1) each; an
// out-of-order or overlapping arrival still lands in the right slot. The result
// is identical to a sort-by-seq-desc-then-cap, so existing callers/tests hold.
export function appendCapped<T extends { seq: number }>(
  prev: T[],
  incoming: T[],
  max: number,
): T[] {
  if (incoming.length === 0) return prev.length > max ? prev.slice(0, max) : prev;
  const out = prev.slice();
  for (const e of incoming) insertBySeqDesc(out, e);
  return out.length > max ? out.slice(0, max) : out;
}

// Insert one event into a seq-descending list, replacing an existing entry with
// the same seq (last write wins) instead of duplicating it.
function insertBySeqDesc<T extends { seq: number }>(list: T[], e: T): void {
  // Binary search for the first index whose seq is <= e.seq (the insert point).
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midEntry = list[mid]!; // mid < hi <= list.length
    if (midEntry.seq > e.seq) lo = mid + 1;
    else hi = mid;
  }
  const at = list[lo];
  if (at && at.seq === e.seq) list[lo] = e; // dedupe replace
  else list.splice(lo, 0, e);
}

// Resolve the SSE URL, carrying the initial cursor as ?since (the snapshot's
// max_seq) so the first connect resumes exactly where the snapshot ended.
export function liveStreamUrl(
  serverBaseUrl: string | null,
  sinceSeq: number,
): string {
  const base = resolveEndpoint("./api/live", serverBaseUrl);
  if (sinceSeq <= 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}since=${sinceSeq}`;
}

// The backend emits `event: reset` with `{"reason":"gap","max_seq":N}` when the
// client's resume cursor is ahead of the server (receiver restarted / pruned
// below the cursor) OR the backlog to replay exceeds the server's replay cap.
// Parse the sentinel defensively: junk yields null (ignored); a finite max_seq
// rides along, but the authoritative cursor comes from the snapshot the reset
// triggers a refetch of, so an absent/non-finite max_seq is tolerated.
export interface LiveResetSignal {
  reason: string;
  max_seq: number | null;
}

export function parseResetEvent(data: string): LiveResetSignal | null {
  try {
    const body = JSON.parse(data) as { reason?: unknown; max_seq?: unknown };
    if (!body || typeof body !== "object") return null;
    const reason = typeof body.reason === "string" ? body.reason : "gap";
    const max_seq = typeof body.max_seq === "number" && Number.isFinite(body.max_seq) ? body.max_seq : null;
    return { reason, max_seq };
  } catch {
    return null;
  }
}

export interface PollPlan {
  // True when the snapshot's max_seq fell BELOW the cursor (receiver restarted /
  // pruned): the kept list is stale and must be cleared before reseeding.
  reset: boolean;
  // The events to ingest after any reset (newest-first snapshot tail).
  ingest: LiveEvent[];
  // The cursor after applying this plan.
  nextCursor: number;
}

// Pure decision for one poll tick: given the current cursor and a fresh
// snapshot, decide whether to reseed (prune/restart) and which events to ingest.
// A reset reseeds from the whole snapshot and follows its max_seq down; the
// steady state ingests only the tail newer than the cursor.
export function planPollIngest(cursor: number, snap: LiveSnapshot): PollPlan {
  if (snap.max_seq < cursor) {
    return { reset: true, ingest: snap.events, nextCursor: snap.max_seq };
  }
  return {
    reset: false,
    ingest: snap.events.filter((ev) => ev.seq > cursor),
    nextCursor: Math.max(cursor, snap.max_seq),
  };
}

export interface ResetReconcileOptions {
  reseed?: boolean;
}

export interface SseResetStartPlan {
  // Cursor to use if the reset snapshot fetch fails. The reset frame may carry
  // an SSE id that advances the browser's native Last-Event-ID, so retry with
  // the UI-owned pre-reset cursor until reseed succeeds.
  retryCursor: number;
  nextCursor: number;
  clearBeforeFetch: boolean;
  reseedBeforeFetch: boolean;
}

export function planSseResetStart(
  cursor: number,
  reset: LiveResetSignal,
): SseResetStartPlan {
  const reseedBeforeFetch = reset.max_seq !== null && reset.max_seq < cursor;
  return {
    retryCursor: cursor,
    nextCursor: reseedBeforeFetch ? reset.max_seq ?? cursor : cursor,
    clearBeforeFetch: reseedBeforeFetch,
    reseedBeforeFetch,
  };
}

export interface SseResetSnapshotPlan {
  nextCursor: number;
  reconcileOptions: ResetReconcileOptions;
}

export function planSseResetSnapshot(
  cursorAtReset: number,
  currentCursor: number,
  snap: LiveSnapshot,
  resetStart: SseResetStartPlan,
): SseResetSnapshotPlan {
  const reseedAfterFetch =
    !resetStart.reseedBeforeFetch && snap.max_seq < cursorAtReset;
  const baseCursor = reseedAfterFetch ? snap.max_seq : currentCursor;
  return {
    nextCursor: Math.max(baseCursor, snap.max_seq),
    reconcileOptions: { reseed: reseedAfterFetch },
  };
}

export interface SseResetSnapshotFailurePlan {
  retryCursor: number;
  restoreCursor: number;
}

export function planSseResetSnapshotFailure(
  resetStart: SseResetStartPlan,
): SseResetSnapshotFailurePlan {
  return {
    retryCursor: resetStart.retryCursor,
    restoreCursor: resetStart.retryCursor,
  };
}

// Pure reconciliation for an SSE `reset`/gap sentinel. The server keeps
// streaming on the same connection after a reset, so the snapshot refetch races
// with concurrent `live` frames. Re-seed from the authoritative snapshot WITHOUT
// dropping a frame that arrived during the refetch: keep only events strictly
// newer than the snapshot's max_seq (the live frames; stale events the snapshot
// no longer covers are dropped), then merge the snapshot in. The caller advances
// the cursor to max(cursor, snap.max_seq) so it never regresses below a kept
// frame. When the receiver restarted into a lower seq space, `reseed` drops the
// old high-seq buffer first; the effect clears before the async refetch so
// frames that arrive after the reset can still be preserved by the default merge.
// Pure and unit-tested; the effect just applies it.
export function reconcileReset(
  prev: LiveEvent[],
  snap: LiveSnapshot,
  max: number,
  opts: ResetReconcileOptions = {},
): LiveEvent[] {
  return appendCapped(
    opts.reseed ? [] : prev.filter((ev) => ev.seq > snap.max_seq),
    snap.events,
    max,
  );
}

export interface LiveState {
  events: LiveEvent[];
  // null = probing/connecting (no open yet), false = unavailable on this
  // deployment (the snapshot probe never succeeded), true = up. A drop AFTER a
  // successful open is `reconnecting`, NOT `connected = false`: EventSource auto-
  // reconnects, so the UI shows "reconnecting…" rather than "Unavailable".
  connected: boolean | null;
  reconnecting: boolean;
  transport: "sse" | "poll" | null;
}

export type LiveConnectionMode = "off" | "snapshot" | "stream";

// One snapshot probe doubles as the availability check AND the buffer seed, gated
// solely on the user's `enabled` opt-in (the Live tab is off by default):
//   • disabled, or an endpoint with no server URL to reach -> "off": never
//     connect, never probe (Settings opt-out and a server-less Android client both
//     cost zero requests).
//   • the visible Live tab (active) -> "stream": the normal SSE/poll lifecycle.
//   • enabled but not currently shown -> "snapshot": one cold-start prewarm seed,
//     no SSE and no poll timer.
export function planLiveConnection(opts: {
  enabled: boolean;
  active: boolean;
  endpointBlocked: boolean;
}): LiveConnectionMode {
  if (!opts.enabled || opts.endpointBlocked) return "off";
  return opts.active ? "stream" : "snapshot";
}

// App mounts this hook once at the always-present shell so the event BUFFER
// survives tab switches (instant, current return to Live). It owns the WHOLE Live
// lifecycle — availability, seed, stream, and the offline cache — off two gates:
//   • `enabled`   — the user's Settings opt-in (the Live tab is off by default).
//       When false, the hook NEVER probes or connects and reports `connected:
//       false` (unavailable), so the tab is hidden and a stale #/live bounces
//       away — opting out costs zero requests. This replaces the old separate
//       availability probe: the single snapshot the hook fetches doubles as the
//       reachability check, so `connected` IS the availability tri-state (null
//       probing / false unavailable / true reachable).
//   • `active`    — whether the Live tab is currently shown. The full stream (SSE
//       or poll) opens only while active, so a polling transport (Tauri thin
//       clients) does NOT keep a 3s /api/live-snapshot interval running on
//       background tabs. While enabled-but-inactive it performs exactly one
//       cold-start prewarm snapshot. The buffer is retained across active toggles.
export function useLive(serverBaseUrl: string | null, enabled = true, active = true): LiveState {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [transport, setTransport] = useState<"sse" | "poll" | null>(null);
  const lastSeq = useRef(0);
  // Latches once the stream has opened (or a snapshot probe has succeeded) at
  // least once. After that, a drop is a transient reconnect — NOT a deployment
  // without the receiver — so onerror surfaces "reconnecting…", not
  // "Unavailable" (EventSource auto-reconnects in the background).
  const everOpened = useRef(false);
  // True while the buffer holds only PROVISIONAL stale-cache rows that the first
  // authoritative snapshot must replace (so a cached row the server no longer
  // returns cannot linger and push live rows past the cap).
  const seededFromCache = useRef(false);

  // Buffer lifecycle. Re-seeds the in-memory buffer + cursor ONLY when the
  // deployment or the enabled opt-in changes — never on an `active` toggle — so
  // the buffer is retained across tab switches. Also owns the disabled / probing
  // state: disabled in Settings (or Android with no server URL) reads as
  // unavailable (false) with no request; an enabled host as connecting (null).
  useEffect(() => {
    everOpened.current = false;
    seededFromCache.current = false;
    setReconnecting(false);
    setTransport(null);
    lastSeq.current = 0;
    if (!enabled || endpointRequiresServerUrl("./api/live", serverBaseUrl, null)) {
      setEvents([]);
      setConnected(false);
      return;
    }
    // Enabled: paint the last known events instantly from the per-server cache
    // (stale-while-revalidate) so a cold start is never an empty "Connecting…"
    // frame. The cursor stays 0 so the first snapshot is fetched in FULL and
    // REPLACES these provisional rows (see seedSnapshot); `connected` stays null
    // — the cached rows show under a "Connecting…" badge until the receiver
    // confirms.
    const cached = loadCachedLiveSnapshot(serverBaseUrl);
    if (cached) {
      seededFromCache.current = true;
      setEvents(cached.events.slice(0, LIVE_EVENT_BUFFER_LIMIT));
    } else {
      setEvents([]);
    }
    setConnected(null);
  }, [serverBaseUrl, enabled]);

  // Persist the live buffer to the per-server cache so the NEXT cold start paints
  // instantly. Both snapshot-derived ingests and SSE frames flow through
  // `events`, so watching it captures the whole buffer. Skipped when Live is
  // disabled (no connection, nothing worth caching).
  useEffect(() => {
    if (!enabled || events.length === 0) return;
    saveCachedLiveSnapshot(serverBaseUrl, events, lastSeq.current);
  }, [enabled, serverBaseUrl, events]);

  // Connection lifecycle. Opens the SSE / poll stream only while Live is enabled
  // AND the tab is active. When enabled but inactive it performs exactly one
  // snapshot seed and stops: no SSE, no Tauri poll interval.
  // The cleanup tears down any active transport when the tab is left WITHOUT
  // clearing the buffer above. On (re)open it seeds from the snapshot and
  // advances the cursor, so returning renders the retained buffer instantly and
  // catches up missed events with no duplicates (appendCapped keys by seq; the
  // cursor never regresses).
  useEffect(() => {
    const mode = planLiveConnection({
      enabled,
      active,
      endpointBlocked: endpointRequiresServerUrl("./api/live", serverBaseUrl, null),
    });
    if (mode === "off") return;
    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let sseResetRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const markUp = (): void => {
      if (cancelled) return;
      everOpened.current = true;
      setConnected(true);
      setReconnecting(false);
    };

    // The first AUTHORITATIVE snapshot replaces the provisional stale-cache seed:
    // drop the cached rows and reset the cursor so planPollIngest re-seeds from
    // the server's full snapshot. A no-op once revalidated (or when nothing was
    // seeded from cache), so steady-state poll/SSE ingest is untouched.
    const dropStaleCacheSeed = (): void => {
      if (!seededFromCache.current) return;
      seededFromCache.current = false;
      lastSeq.current = 0;
      setEvents([]);
    };

    const ingest = (incoming: LiveEvent[]): void => {
      if (incoming.length === 0) return;
      const maxIn = incoming.reduce((m, e) => Math.max(m, e.seq), 0);
      if (maxIn > lastSeq.current) lastSeq.current = maxIn;
      setEvents((prev) => appendCapped(prev, incoming, LIVE_EVENT_BUFFER_LIMIT));
    };

    const transportKind = pickLiveTransport({
      tauri: isTauriRuntime(),
      hasEventSource: typeof EventSource !== "undefined",
    });
    if (mode === "stream") setTransport(transportKind);

    const startSse = (sinceSeq: number): void => {
      const es = new EventSource(liveStreamUrl(serverBaseUrl, sinceSeq));
      source = es;
      es.onopen = () => {
        markUp();
      };
      const ingestEventSourceFrame = (e: Event): void => {
        if (cancelled) return;
        try {
          ingest([JSON.parse((e as MessageEvent).data) as LiveEvent]);
        } catch {
          /* skip a malformed frame */
        }
      };
      es.addEventListener("live", ingestEventSourceFrame);
      // Profile enrichment updates are id-less SSE frames, so they can replace
      // already-delivered rows without moving the browser's Last-Event-ID
      // cursor backwards.
      es.addEventListener("live-update", ingestEventSourceFrame);
      // Reset/gap sentinel: the client cursor is ahead of the server (receiver
      // restarted / pruned below it) or the replay backlog exceeds the cap. The
      // server does NOT close on a reset — it keeps streaming from its head on the
      // SAME connection — so the reseed must not clobber `live` frames that arrive
      // during the async snapshot refetch. reconcileReset() drops stale events the
      // snapshot no longer covers, KEEPS any frame newer than the snapshot, and
      // never regresses the cursor, so a concurrent live frame is preserved
      // instead of being lost to a blind setEvents([]).
      es.addEventListener("reset", (e) => {
        if (cancelled) return;
        const reset = parseResetEvent((e as MessageEvent).data);
        if (reset === null) return;
        const cursorAtReset = lastSeq.current;
        const resetStart = planSseResetStart(cursorAtReset, reset);
        if (resetStart.clearBeforeFetch) {
          lastSeq.current = resetStart.nextCursor;
          setEvents([]);
        }
        void (async () => {
          const snap = await fetchLiveSnapshot(serverBaseUrl, LIVE_EVENT_BUFFER_LIMIT);
          if (cancelled) return;
          if (!snap) {
            const retry = planSseResetSnapshotFailure(resetStart);
            // The reset frame carries `id: max_seq` for native EventSource
            // clients. If the authoritative snapshot reseed fails, discard this
            // EventSource instance so its native Last-Event-ID cannot skip the
            // missing snapshot window; reconnect from the UI-owned pre-reset
            // cursor and let the receiver send another reset.
            lastSeq.current = retry.restoreCursor;
            setReconnecting(true);
            es.close();
            if (source === es) source = null;
            if (sseResetRetryTimer) clearTimeout(sseResetRetryTimer);
            sseResetRetryTimer = setTimeout(() => {
              sseResetRetryTimer = null;
              if (!cancelled) startSse(retry.retryCursor);
            }, POLL_INTERVAL_MS);
            return;
          }
          const plan = planSseResetSnapshot(
            cursorAtReset,
            lastSeq.current,
            snap,
            resetStart,
          );
          lastSeq.current = plan.nextCursor;
          setEvents((prev) =>
            reconcileReset(prev, snap, LIVE_EVENT_BUFFER_LIMIT, plan.reconcileOptions),
          );
        })();
      });
      es.onerror = () => {
        if (cancelled) return;
        // A drop after a successful open is a transient reconnect (EventSource
        // retries on its own); only a stream that NEVER opened is unavailable.
        if (everOpened.current) setReconnecting(true);
        else setConnected(false);
      };
    };

    const pollOnce = async (): Promise<void> => {
      const snap = await fetchLiveSnapshot(
        serverBaseUrl,
        LIVE_EVENT_BUFFER_LIMIT,
        lastSeq.current > 0 ? lastSeq.current : undefined,
      );
      if (cancelled) return;
      if (!snap) {
        // A probe that NEVER succeeded is unavailable; a drop after a prior
        // success is a transient gap the next tick recovers from.
        if (everOpened.current) setReconnecting(true);
        else setConnected(false);
        return;
      }
      markUp();
      dropStaleCacheSeed();
      const plan = planPollIngest(lastSeq.current, snap);
      if (plan.reset) {
        // Receiver restarted / pruned below our cursor — reset and reseed.
        lastSeq.current = 0;
        setEvents([]);
      }
      lastSeq.current = plan.nextCursor;
      ingest(plan.ingest);
    };

    const seedSnapshot = async (): Promise<LiveSnapshot | null> => {
      // The cold-start seed is the patient one-shot probe: a transient blip on a
      // cold link retries a couple of times (bounded) rather than failing the tab
      // out on the first stall. The steady-state poll below stays retry-free — its
      // 3s interval is its own retry.
      const snap = await fetchLiveSnapshot(serverBaseUrl, LIVE_EVENT_BUFFER_LIMIT, undefined, {
        retries: LIVE_SNAPSHOT_PROBE_RETRIES,
      });
      if (cancelled) return null;
      if (!snap) return null;
      markUp();
      dropStaleCacheSeed();
      const plan = planPollIngest(lastSeq.current, snap);
      if (plan.reset) {
        lastSeq.current = 0;
        setEvents([]);
      }
      lastSeq.current = plan.nextCursor;
      ingest(plan.ingest);
      return snap;
    };

    void (async () => {
      const snap = await seedSnapshot();
      if (cancelled) return;
      if (mode === "snapshot") {
        if (!snap) {
          if (everOpened.current) setReconnecting(true);
          else setConnected(false);
        }
        return;
      }
      if (transportKind === "sse") {
        startSse(lastSeq.current);
      } else {
        if (!snap) setConnected(false);
        pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
      }
    })();

    return () => {
      cancelled = true;
      if (sseResetRetryTimer) clearTimeout(sseResetRetryTimer);
      if (source) source.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [serverBaseUrl, enabled, active]);

  return { events, connected, reconnecting, transport };
}
