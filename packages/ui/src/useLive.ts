// Live event stream hook for the #/live page. Browser/web: native EventSource
// (true streaming). Tauri thin clients: interval polling of the snapshot
// (plugin-http is request/response, not a live stream). Both seed from the
// snapshot first and carry its max_seq into the stream cursor so an event
// appended between snapshot and connect is not lost (EventSource cannot set
// Last-Event-ID on the initial connect). Contract-independent: depends on no
// loaded contract. The pure helpers are unit-tested; the effects are smoke-
// tested by the render harness.
import { useEffect, useRef, useState } from "react";
import {
  endpointRequiresServerUrl,
  fetchLiveSnapshot,
  resolveEndpoint,
} from "./contract.ts";
import { isTauriRuntime } from "./runtime.ts";
import type { LiveEvent } from "./model.ts";

const POLL_INTERVAL_MS = 3000;
const MAX_EVENTS = 500;

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
export function appendCapped<T extends { seq: number }>(
  prev: T[],
  incoming: T[],
  max: number,
): T[] {
  const bySeq = new Map<number, T>();
  for (const e of prev) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, max);
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

export interface LiveState {
  events: LiveEvent[];
  // null = probing/connecting, false = unavailable on this deployment, true = up
  connected: boolean | null;
  transport: "sse" | "poll" | null;
}

export function useLive(serverBaseUrl: string | null): LiveState {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [transport, setTransport] = useState<"sse" | "poll" | null>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    lastSeq.current = 0;
    setEvents([]);
    setConnected(null);
    setTransport(null);
    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const ingest = (incoming: LiveEvent[]): void => {
      if (incoming.length === 0) return;
      const maxIn = incoming.reduce((m, e) => Math.max(m, e.seq), 0);
      if (maxIn > lastSeq.current) lastSeq.current = maxIn;
      setEvents((prev) => appendCapped(prev, incoming, MAX_EVENTS));
    };

    // Android with no server URL configured: same guard the contract loader uses.
    if (endpointRequiresServerUrl("./api/live", serverBaseUrl, null)) {
      setConnected(false);
      return;
    }

    const transportKind = pickLiveTransport({
      tauri: isTauriRuntime(),
      hasEventSource: typeof EventSource !== "undefined",
    });
    setTransport(transportKind);

    const startSse = (sinceSeq: number): void => {
      const es = new EventSource(liveStreamUrl(serverBaseUrl, sinceSeq));
      source = es;
      es.onopen = () => {
        if (!cancelled) setConnected(true);
      };
      es.addEventListener("live", (e) => {
        if (cancelled) return;
        try {
          ingest([JSON.parse((e as MessageEvent).data) as LiveEvent]);
        } catch {
          /* skip a malformed frame */
        }
      });
      es.onerror = () => {
        // EventSource auto-reconnects; surface a reconnecting state.
        if (!cancelled) setConnected(false);
      };
    };

    const pollOnce = async (): Promise<void> => {
      const snap = await fetchLiveSnapshot(serverBaseUrl);
      if (cancelled) return;
      if (!snap) {
        setConnected(false);
        return;
      }
      setConnected(true);
      if (snap.max_seq < lastSeq.current) {
        // Receiver restarted / pruned below our cursor — reset and reseed.
        lastSeq.current = 0;
        setEvents([]);
      }
      ingest(snap.events.filter((ev) => ev.seq > lastSeq.current));
    };

    void (async () => {
      const snap = await fetchLiveSnapshot(serverBaseUrl);
      if (cancelled) return;
      if (snap) {
        setConnected(true);
        ingest(snap.events);
      }
      if (transportKind === "sse") {
        startSse(snap?.max_seq ?? 0);
      } else {
        if (!snap) setConnected(false);
        pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
      }
    })();

    return () => {
      cancelled = true;
      if (source) source.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [serverBaseUrl]);

  return { events, connected, transport };
}

// One-shot capability probe for App-level nav gating: the Live tab is shown only
// when the receiver answers (so a deployment without it — e.g. the standalone
// app — never shows a dead tab). null = still probing.
export function useLiveAvailable(serverBaseUrl: string | null): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    if (endpointRequiresServerUrl("./api/live-snapshot", serverBaseUrl, null)) {
      setAvailable(false);
      return;
    }
    void fetchLiveSnapshot(serverBaseUrl).then((snap) => {
      if (!cancelled) setAvailable(snap !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl]);
  return available;
}
