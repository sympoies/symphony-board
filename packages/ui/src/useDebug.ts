// UI client state for the hidden Diagnostics page (#/debug): store statistics
// (GET /api/stats, fetched on mount + manual/contract refresh) and the writer daemon's
// recent-log tail (GET /api/logs, polled with the last-seen seq so each tick
// ships only deltas). Both hooks live only while the page is mounted — the
// page is hidden, so nothing polls in normal use.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStoreStats, fetchDaemonLogs, fetchLiveSnapshot, fetchTokenRateLimits } from "./contract.ts";
import { LIVE_EVENT_BUFFER_LIMIT } from "./live-config.ts";
import { actorKey, categoryCounts, distinctCount, eventInstant, eventRepo } from "./live-stats.ts";
import type { StoreStats, DaemonLogEntry, TokenRateLimitsInfo } from "./model.ts";

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

export interface TokenRateLimitsState {
  info: TokenRateLimitsInfo | null; // null after a failed probe = endpoint unavailable on this deployment
  loading: boolean;
  refresh: () => void;
}

// The GitHub token GraphQL rate-limit probe. Unlike the store/log hooks this is
// truly on-demand: it fires ONLY while its tab is active (and on a manual
// Refresh), because each probe reaches out to the provider once per token —
// opening the Diagnostics page on another tab must not spend that. Passing
// `active` (tab === "ratelimit") gates the effect; switching to the tab triggers
// a fresh probe, which is exactly when the operator wants the current budget.
export function useTokenRateLimits(serverBaseUrl: string | null, active: boolean): TokenRateLimitsState {
  const [info, setInfo] = useState<TokenRateLimitsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    void fetchTokenRateLimits(serverBaseUrl).then((next) => {
      if (cancelled) return;
      setInfo(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl, active, epoch]);

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);
  return { info, loading, refresh };
}

// A one-shot snapshot probe of the live receiver for the Diagnostics page — the
// same reference data the Live tab shows (buffer depth, cursor, active
// repos/people, category mix), without opening a streaming connection.
export interface LiveSnapshotInfo {
  available: boolean | null; // null = still probing
  maxSeq: number | null;
  events: number;
  repos: number;
  people: number;
  categories: { category: string; count: number }[];
  generatedAt: string | null;
  newestAt: string | null;
}

const EMPTY_LIVE_INFO: LiveSnapshotInfo = {
  available: null,
  maxSeq: null,
  events: 0,
  repos: 0,
  people: 0,
  categories: [],
  generatedAt: null,
  newestAt: null,
};

export interface LiveSnapshotState {
  info: LiveSnapshotInfo;
  loading: boolean;
  refresh: () => void;
}

export function useLiveSnapshotInfo(serverBaseUrl: string | null): LiveSnapshotState {
  const [info, setInfo] = useState<LiveSnapshotInfo>(EMPTY_LIVE_INFO);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchLiveSnapshot(serverBaseUrl, LIVE_EVENT_BUFFER_LIMIT).then((snap) => {
      if (cancelled) return;
      if (!snap) {
        setInfo({ ...EMPTY_LIVE_INFO, available: false });
      } else {
        const newest = snap.events[0] ? eventInstant(snap.events[0]) : null;
        setInfo({
          available: true,
          maxSeq: snap.max_seq,
          events: snap.events.length,
          repos: distinctCount(snap.events, eventRepo),
          people: distinctCount(snap.events, actorKey),
          categories: categoryCounts(snap.events, []),
          generatedAt: snap.generated_at,
          newestAt: newest != null ? new Date(newest).toISOString() : null,
        });
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl, epoch]);

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);
  return { info, loading, refresh };
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
