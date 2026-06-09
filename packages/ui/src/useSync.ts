// UI client state for the writer-owned sync control plane. It probes the daemon
// once on mount, polls the active run while one is in flight, and on a successful
// non-dry run that emitted a contract it triggers `onFreshData` (the App reloads
// the contract / range in place). All daemon ownership stays server-side; this is
// only the thin client and its polling lifecycle.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSyncControl, fetchCurrentSyncRun, fetchLastSyncRun, startSyncRun } from "./contract.ts";
import {
  isSyncRunActive,
  syncProducedFreshData,
  type SyncControlInfo,
  type SyncRunStatus,
  type SyncRunRequest,
  type SyncSourceOption,
} from "./model.ts";

const POLL_INTERVAL_MS = 1500;

export interface SyncState {
  available: boolean; // the control surface answered the availability probe
  enabled: boolean; // manual runs are enabled on this deployment
  sources: SyncSourceOption[];
  current: SyncRunStatus | null; // the active run, while one is in flight
  last: SyncRunStatus | null; // the last finished run
  busy: boolean; // a start request is in flight
  error: string | null;
  start: (req: SyncRunRequest) => void;
}

export function useSync(onFreshData: () => void, serverBaseUrl: string | null): SyncState {
  const [info, setInfo] = useState<SyncControlInfo | null>(null);
  const [current, setCurrent] = useState<SyncRunStatus | null>(null);
  const [last, setLast] = useState<SyncRunStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hold the latest reload callback without making it a poll-effect dependency.
  const freshRef = useRef(onFreshData);
  freshRef.current = onFreshData;

  // Availability probe, once on mount. A null result means no control surface —
  // a static deploy without the daemon — so the affordance stays hidden.
  useEffect(() => {
    let cancelled = false;
    void fetchSyncControl(serverBaseUrl).then((next) => {
      if (cancelled || !next) return;
      setInfo(next);
      setCurrent(next.current);
      setLast(next.last);
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl]);

  // Poll only while a run is active. Re-subscribes when the active run id changes
  // (a new run) or clears (the run finished), never on every status tick.
  const activeRunId = isSyncRunActive(current) ? current!.run_id : null;
  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchCurrentSyncRun(serverBaseUrl);
        if (cancelled) return;
        if (next && next.status === "running") {
          setCurrent(next);
          return;
        }
        // The slot cleared: the run finished. /last carries the terminal status.
        const finished = next ?? (await fetchLastSyncRun(serverBaseUrl));
        if (cancelled) return;
        setCurrent(null);
        if (finished) {
          setLast(finished);
          if (syncProducedFreshData(finished)) freshRef.current();
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeRunId, serverBaseUrl]);

  const start = useCallback((req: SyncRunRequest) => {
    setBusy(true);
    setError(null);
    startSyncRun(req, serverBaseUrl)
      .then((res) => {
        // 202 carries the started run; 409 carries the already-active run — adopt
        // either so the poll picks it up instead of starting a second writer.
        if (res.run) setCurrent(res.run);
        if (!res.ok && res.status === 409) setError("a sync is already running");
        else if (!res.ok) setError(res.error ?? "sync failed to start");
      })
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setBusy(false));
  }, [serverBaseUrl]);

  return {
    available: info !== null,
    enabled: info?.enabled ?? false,
    sources: info?.sources ?? [],
    current,
    last,
    busy,
    error,
    start,
  };
}
