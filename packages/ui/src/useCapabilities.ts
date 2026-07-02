import { useCallback, useEffect, useState } from "react";
import { fetchCapabilities, fetchLiveSnapshot } from "./contract.ts";
import { capabilitiesFromLiveSnapshot } from "./live-capabilities.ts";
import type { ServerCapabilities } from "./model.ts";

export interface CapabilitiesState {
  info: ServerCapabilities | null;
  loading: boolean;
  refresh: () => void;
}

export async function loadCapabilities(serverBaseUrl: string | null): Promise<ServerCapabilities | null> {
  const capabilities = await fetchCapabilities(serverBaseUrl);
  if (capabilities) return capabilities;
  const snapshot = await fetchLiveSnapshot(serverBaseUrl, 1, undefined, { retries: 0 });
  return snapshot ? capabilitiesFromLiveSnapshot(snapshot) : null;
}

export function useCapabilities(serverBaseUrl: string | null, enabled = true): CapabilitiesState {
  const [info, setInfo] = useState<ServerCapabilities | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setInfo(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadCapabilities(serverBaseUrl).then((next) => {
      if (cancelled) return;
      setInfo(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl, epoch, enabled]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setEpoch((e) => e + 1);
  }, [enabled]);
  return { info, loading, refresh };
}
