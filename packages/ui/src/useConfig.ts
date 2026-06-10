// UI client state for the writer-owned config control plane (Settings ->
// Sources editor). It probes the daemon once on mount; when the capability is
// enabled it exposes the live document, the secrets set/unset flags, and the
// save / setSecret actions. All validation stays server-side — save surfaces
// the daemon's field-level messages verbatim instead of re-validating.

import { useCallback, useEffect, useState } from "react";
import { fetchConfigControl, fetchSecrets, saveConfigDocument, saveSecretValue } from "./contract.ts";
import type { ConfigControlInfo, ConfigDocument, SecretsInfo } from "./model.ts";

export interface ConfigState {
  available: boolean; // the probe answered and the capability is enabled
  config: ConfigDocument | null; // live document; null = none yet or unreadable
  configError: string | null; // the daemon's read error for the unreadable case
  secrets: Record<string, boolean>; // token env name -> set?
  secretsWritable: boolean; // a secrets file backs the write surface
  busy: boolean; // a save is in flight
  saveErrors: string[]; // field-level validation messages from the last save
  saveError: string | null; // non-validation failure from the last save
  save: (next: ConfigDocument) => Promise<boolean>;
  // Resolves to null on success, otherwise the error message for inline display.
  setSecret: (env: string, value: string | null) => Promise<string | null>;
  refresh: () => void;
}

export function useConfig(serverBaseUrl: string | null): ConfigState {
  const [info, setInfo] = useState<ConfigControlInfo | null>(null);
  const [secretsInfo, setSecretsInfo] = useState<SecretsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchConfigControl(serverBaseUrl).then((next) => {
      if (cancelled) return;
      setInfo(next);
      if (next?.enabled) {
        void fetchSecrets(serverBaseUrl).then((s) => {
          if (!cancelled) setSecretsInfo(s);
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl, epoch]);

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);

  const save = useCallback(
    async (next: ConfigDocument): Promise<boolean> => {
      setBusy(true);
      setSaveErrors([]);
      setSaveError(null);
      try {
        const res = await saveConfigDocument(next, serverBaseUrl);
        if (res.ok) {
          refresh();
          return true;
        }
        setSaveErrors(res.errors);
        setSaveError(res.error);
        return false;
      } catch (err) {
        setSaveError((err as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [serverBaseUrl, refresh],
  );

  const setSecret = useCallback(
    async (env: string, value: string | null): Promise<string | null> => {
      try {
        const res = await saveSecretValue(env, value, serverBaseUrl);
        if (res.ok) {
          refresh();
          return null;
        }
        return res.error ?? `HTTP ${res.status}`;
      } catch (err) {
        return (err as Error).message;
      }
    },
    [serverBaseUrl, refresh],
  );

  return {
    available: info?.enabled === true,
    config: info?.config ?? null,
    configError: info?.error ?? null,
    secrets: secretsInfo?.secrets ?? {},
    secretsWritable: secretsInfo?.writable ?? false,
    busy,
    saveErrors,
    saveError,
    save,
    setSecret,
    refresh,
  };
}
