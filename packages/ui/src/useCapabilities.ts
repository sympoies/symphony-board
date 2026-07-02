import { useCallback, useEffect, useState } from "react";
import { fetchCapabilities, fetchLiveSnapshot } from "./contract.ts";
import { capabilitiesFromLiveSnapshot } from "./live-capabilities.ts";
import type { ServerCapabilities } from "./model.ts";

export interface CapabilitiesState {
  info: ServerCapabilities | null;
  loading: boolean;
  refresh: () => void;
}

export function useCapabilities(serverBaseUrl: string | null): CapabilitiesState {
  const [info, setInfo] = useState<ServerCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const capabilities = await fetchCapabilities(serverBaseUrl);
      if (capabilities) return capabilities;
      const snapshot = await fetchLiveSnapshot(serverBaseUrl, 1, undefined, { retries: 0 });
      return snapshot ? capabilitiesFromLiveSnapshot(snapshot) : null;
    })().then((next) => {
      if (cancelled) return;
      setInfo(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl, epoch]);

  const refresh = useCallback(() => {
    setLoading(true);
    setEpoch((e) => e + 1);
  }, []);
  return { info, loading, refresh };
}
