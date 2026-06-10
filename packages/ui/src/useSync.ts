// UI client state for the writer-owned sync control plane. It probes the daemon
// on mount, polls the active run fast while one is in flight, and re-probes at a
// slow idle cadence (plus on tab focus) so daemon-scheduled background runs show
// up without a manual click. Any newly observed finished run that emitted a
// contract triggers `onFreshData` exactly once (the App reloads the contract /
// range in place). All daemon ownership stays server-side; this is only the thin
// client and its polling lifecycle.

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
// Idle cadence only has to catch a scheduled run mid-flight (a run takes
// seconds; the loop default is INTERVAL=120s), so 15s is plenty and cheap —
// the probe is one in-memory status GET. Focus/visibility re-probes cover the
// "came back to the tab" case instantly.
const IDLE_PROBE_INTERVAL_MS = 15_000;

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
  // The last finished run_id already seen, so a run observed both by the active
  // poll and an idle probe reloads the data once, and the mount snapshot never
  // re-fires for data the App just loaded anyway.
  const seenFinishedRef = useRef<string | null>(null);

  // Adopt a finished run: record it, surface it as `last`, clear any stale
  // start error (the newest outcome supersedes it), and reload the data once
  // if the run actually emitted a fresh contract.
  const adoptFinished = useCallback((finished: SyncRunStatus | null) => {
    if (!finished) return;
    const isNew = finished.run_id !== seenFinishedRef.current;
    seenFinishedRef.current = finished.run_id;
    setLast(finished);
    if (!isNew) return;
    setError(null);
    if (syncProducedFreshData(finished)) freshRef.current();
  }, []);

  // Availability probe, once on mount. A null result means no control surface —
  // a static deploy without the daemon — so the affordance stays hidden.
  useEffect(() => {
    let cancelled = false;
    void fetchSyncControl(serverBaseUrl).then((next) => {
      if (cancelled || !next) return;
      setInfo(next);
      setCurrent(next.current);
      setLast(next.last);
      // The mount snapshot is the baseline: the App fetched the contract
      // alongside it, so this run must not trigger a redundant reload.
      if (next.last) seenFinishedRef.current = next.last.run_id;
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl]);

  // Poll fast only while a run is active. Re-subscribes when the active run id
  // changes (a new run) or clears (the run finished), never on every status tick.
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
        adoptFinished(finished);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeRunId, serverBaseUrl, adoptFinished]);

  // Idle re-probe: while no run is known to be active, watch for daemon-scheduled
  // runs so the button disables, the status line reports them, and a finished
  // background run refreshes the stale board. Skipped while the tab is hidden;
  // focus/visibility events re-probe immediately on return.
  const available = info !== null;
  useEffect(() => {
    if (!available || activeRunId) return;
    let cancelled = false;
    const probe = async () => {
      const next = await fetchSyncControl(serverBaseUrl);
      if (cancelled || !next) return;
      setInfo(next); // keeps enabled/sources fresh after config edits too
      if (isSyncRunActive(next.current)) {
        setCurrent(next.current);
        return;
      }
      adoptFinished(next.last);
    };
    const wake = () => {
      if (document.visibilityState === "visible") void probe();
    };
    const id = setInterval(wake, IDLE_PROBE_INTERVAL_MS);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [available, activeRunId, serverBaseUrl, adoptFinished]);

  const start = useCallback((req: SyncRunRequest) => {
    setBusy(true);
    setError(null);
    startSyncRun(req, serverBaseUrl)
      .then((res) => {
        // 202 carries the started run; 409 carries the already-active run — adopt
        // either so the poll picks it up instead of starting a second writer. An
        // adopted 409 is not an error: the status line reports the in-flight run.
        if (res.run) setCurrent(res.run);
        if (!res.ok && res.status === 409) {
          if (!res.run) setError("a sync is already running");
        } else if (!res.ok) {
          setError(res.error ?? "sync failed to start");
        }
      })
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setBusy(false));
  }, [serverBaseUrl]);

  return {
    available,
    enabled: info?.enabled ?? false,
    sources: info?.sources ?? [],
    current,
    last,
    busy,
    error,
    start,
  };
}
