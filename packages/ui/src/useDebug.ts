// UI client state for the hidden Diagnostics page (#/debug): store statistics
// (GET /api/stats, fetched on mount + manual/contract refresh) and the writer daemon's
// recent-log tail (GET /api/logs, polled with the last-seen seq so each tick
// ships only deltas). Both hooks live only while the page is mounted — the
// page is hidden, so nothing polls in normal use.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStoreStats, fetchDaemonLogs } from "./contract.ts";
import type { StoreStats, DaemonLogEntry } from "./model.ts";

const LOG_POLL_INTERVAL_MS = 2000;
// Client-side cap, matching the server buffer: the tail view never grows
// beyond what the daemon itself retains.
const MAX_CLIENT_LOG_ENTRIES = 1000;

export interface StoreStatsState {
  stats: StoreStats | null; // null after a failed probe = unavailable / no store yet
  loading: boolean;
  refresh: () => void;
}

export function useStoreStats(serverBaseUrl: string | null): StoreStatsState {
  const [stats, setStats] = useState<StoreStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchStoreStats(serverBaseUrl).then((next) => {
      if (cancelled) return;
      setStats(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl, epoch]);

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);
  return { stats, loading, refresh };
}

export interface DaemonLogsState {
  entries: DaemonLogEntry[];
  // null until the first probe answers; false = the endpoint is missing or
  // LOG_CONTROL_ENABLED is off on this deployment.
  enabled: boolean | null;
  clear: () => void;
}

export function useDaemonLogs(serverBaseUrl: string | null): DaemonLogsState {
  const [entries, setEntries] = useState<DaemonLogEntry[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    lastSeq.current = 0;
    setEntries([]);
    setEnabled(null);
    let cancelled = false;
    // Whether any probe has answered yet — a failure before the first answer
    // reads as "unavailable"; a failure after keeps the tail and retries.
    let probed = false;
    const tick = async () => {
      const next = await fetchDaemonLogs(lastSeq.current, serverBaseUrl);
      if (cancelled) return;
      if (!next) {
        if (!probed) setEnabled(false);
        return;
      }
      probed = true;
      setEnabled(next.enabled);
      if (!next.enabled) return;
      if (next.latest_seq < lastSeq.current) {
        // The daemon restarted (its seq space reset): drop the stale tail and
        // re-read from the top on the next tick.
        lastSeq.current = 0;
        setEntries([]);
        return;
      }
      const newest = next.entries.at(-1);
      if (newest) {
        lastSeq.current = newest.seq;
        setEntries((prev) => [...prev, ...next.entries].slice(-MAX_CLIENT_LOG_ENTRIES));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), LOG_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [serverBaseUrl]);

  const clear = useCallback(() => setEntries([]), []);
  return { entries, enabled, clear };
}
