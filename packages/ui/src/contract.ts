// Loading the contract (LAYER 3) for the UI to render. The UI is a pure
// CONSUMER: it reads the versioned JSON envelope and stays liberal in what it
// accepts (it does not re-validate — producers validate strictly; see
// docs/CONTRACT.md). Types come from @symphony-board/contract.

import type { ContractEnvelope } from "@symphony-board/contract";
import type { TimeRange, SyncControlInfo, SyncRunStatus, SyncRunRequest, ConfigControlInfo, ConfigDocument, SecretsInfo, StoreStats, DaemonLogsInfo } from "./model.ts";
import { appFetch } from "./runtime.ts";
import { currentClientKind, loadServerBaseUrl, requiresConfiguredServerBaseUrl } from "./viewconfig.ts";

// The major this UI understands. The contract versions independently; if a
// future emit bumps the MAJOR, the UI should branch (or warn) rather than
// silently mis-render. Minor/patch are backward compatible by contract rule.
export const SUPPORTED_MAJOR = 3;

export function majorOf(version: string): number {
  return Number(version.split(".")[0] ?? "0");
}

export function resolveEndpoint(url: string, serverBaseUrl: string | null = loadServerBaseUrl()): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
  if (!serverBaseUrl) return url;
  const path = url.startsWith("./") ? url.slice(2) : url.startsWith("/") ? url.slice(1) : url;
  return new URL(path, serverBaseUrl).toString();
}

export function endpointRequiresServerUrl(url: string, serverBaseUrl: string | null, clientKind: string | null = currentClientKind()): boolean {
  return !serverBaseUrl && requiresConfiguredServerBaseUrl(clientKind) && !/^[a-z][a-z\d+.-]*:\/\//i.test(url);
}

async function readJson(res: Response): Promise<unknown> {
  const body = (await res.json()) as unknown;
  return typeof body === "string" ? JSON.parse(body) : body;
}

function asContractEnvelope(body: unknown): ContractEnvelope {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items) || typeof (body as { contract_version?: unknown }).contract_version !== "string") {
    throw new Error("not a symphony-board contract (missing contract_version / items)");
  }
  return body as ContractEnvelope;
}

// Fetch the contract emitted alongside the app (the loop daemon writes
// data/contract.json; deploy it next to index.html). Relative URL so it works
// under any base path.
export async function fetchContract(url = "./contract.json", serverBaseUrl: string | null = loadServerBaseUrl(), clientKind: string | null = currentClientKind()): Promise<ContractEnvelope> {
  if (endpointRequiresServerUrl(url, serverBaseUrl, clientKind)) {
    throw new Error("Android client requires a server URL. Set Settings -> Server to a reachable Symphony Board HTTP(S) surface.");
  }
  const target = resolveEndpoint(url, serverBaseUrl);
  const res = await appFetch(target, { cache: "no-store" });
  if (!res.ok) throw new Error(`could not load ${target}: HTTP ${res.status}`);
  return asContractEnvelope(await readJson(res));
}

export async function fetchRangeContract(range: TimeRange, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<ContractEnvelope> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  return fetchContract(`./api/range?${params.toString()}`, serverBaseUrl);
}

// --- UI-triggered manual sync control plane client ---
// The board daemon serves these beside the contract; the web sidecar proxies
// them. All routes are relative so they work under any base path.

// Same-origin guard the daemon requires on the mutating POST. A custom header
// cannot be set by a cross-site simple form POST, so sending it proves the
// request came from this app.
export const SYNC_CONTROL_HEADER = "X-Symphony-Sync-Control";

// Availability probe. Returns null on ANY failure (route missing, network error,
// non-2xx) so the caller treats sync control as simply unavailable and hides the
// affordance — the common case for a static deploy without the daemon.
export async function fetchSyncControl(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SyncControlInfo | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/sync-control", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    return (await readJson(res)) as SyncControlInfo;
  } catch {
    return null;
  }
}

export async function fetchCurrentSyncRun(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SyncRunStatus | null> {
  const res = await appFetch(resolveEndpoint("./api/sync-runs/current", serverBaseUrl), { cache: "no-store" });
  if (!res.ok) throw new Error(`sync status: HTTP ${res.status}`);
  const body = (await readJson(res)) as { current: SyncRunStatus | null };
  return body.current ?? null;
}

export async function fetchLastSyncRun(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SyncRunStatus | null> {
  const res = await appFetch(resolveEndpoint("./api/sync-runs/last", serverBaseUrl), { cache: "no-store" });
  if (!res.ok) throw new Error(`sync status: HTTP ${res.status}`);
  const body = (await readJson(res)) as { last: SyncRunStatus | null };
  return body.last ?? null;
}

export interface StartSyncResult {
  // ok: a new run was accepted (202). status 409: a run is already active and
  // `run` carries it, so the caller can adopt and poll it rather than erroring.
  ok: boolean;
  status: number;
  run: SyncRunStatus | null;
  error: string | null;
}

export async function startSyncRun(req: SyncRunRequest, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<StartSyncResult> {
  const res = await appFetch(resolveEndpoint("./api/sync-runs", serverBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify(req),
  });
  let body: { current?: SyncRunStatus | null; error?: string } | null = null;
  try {
    body = (await readJson(res)) as { current?: SyncRunStatus | null; error?: string };
  } catch {
    body = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    run: body?.current ?? null,
    error: res.ok ? null : (body?.error ?? `HTTP ${res.status}`),
  };
}

// --- writer-owned config control plane client (Settings -> Sources editor) ---
// Same shape as the sync control client above: GET probes return null on any
// failure so the editor simply stays hidden, and mutations carry the shared
// same-origin guard header. Server-side validation is authoritative.

// Capability probe + current document. `enabled: false` (or null) hides the
// editor; `enabled: true` with `config: null` is the not-configured-yet state
// the first-run onboarding starts from.
export async function fetchConfigControl(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<ConfigControlInfo | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/config", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as ConfigControlInfo | null;
    return body && typeof body.enabled === "boolean" ? body : null;
  } catch {
    return null;
  }
}

export interface SaveConfigResult {
  ok: boolean;
  status: number;
  errors: string[]; // the daemon's per-field validation messages on a 400 invalid_config
  error: string | null; // any other failure
}

export async function saveConfigDocument(config: ConfigDocument, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SaveConfigResult> {
  const res = await appFetch(resolveEndpoint("./api/config", serverBaseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify(config),
  });
  let body: { error?: string; errors?: string[] } | null = null;
  try {
    body = (await readJson(res)) as { error?: string; errors?: string[] };
  } catch {
    body = null;
  }
  const errors = body?.errors ?? [];
  return {
    ok: res.ok,
    status: res.status,
    errors,
    error: res.ok || errors.length > 0 ? null : (body?.error ?? `HTTP ${res.status}`),
  };
}

// Which token env names are set (booleans only — values never cross this
// surface). Null on any failure, mirroring the capability probes.
export async function fetchSecrets(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SecretsInfo | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/secrets", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as SecretsInfo | null;
    return body && typeof body.enabled === "boolean" ? body : null;
  } catch {
    return null;
  }
}

export interface SaveSecretResult {
  ok: boolean;
  status: number;
  error: string | null;
}

// Write-only: set/replace a token for an env name, or remove it with null.
// The value rides in the request body once and is never echoed or stored.
export async function saveSecretValue(env: string, value: string | null, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SaveSecretResult> {
  const res = await appFetch(resolveEndpoint("./api/secrets", serverBaseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify({ env, value }),
  });
  let body: { error?: string; message?: string } | null = null;
  try {
    body = (await readJson(res)) as { error?: string; message?: string };
  } catch {
    body = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    error: res.ok ? null : (body?.message ?? body?.error ?? `HTTP ${res.status}`),
  };
}

// --- diagnostics client (the hidden #/debug page) ---
// Probe-pattern GETs like the control planes above: null on ANY failure (route
// missing, no store yet, network error) so the page renders "unavailable"
// instead of erroring — the common case for a static deploy.

export async function fetchStoreStats(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<StoreStats | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/stats", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as StoreStats | null;
    return body && typeof body === "object" && typeof (body as { db?: unknown }).db === "object" ? body : null;
  } catch {
    return null;
  }
}

// The writer daemon's recent-log tail. `after` is the caller's last-seen seq
// (0 = full buffer), so the poll loop ships deltas, not the whole buffer.
export async function fetchDaemonLogs(after: number, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<DaemonLogsInfo | null> {
  try {
    const path = after > 0 ? `./api/logs?after=${after}` : "./api/logs";
    const res = await appFetch(resolveEndpoint(path, serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as DaemonLogsInfo | null;
    return body && typeof body.enabled === "boolean" ? body : null;
  } catch {
    return null;
  }
}

// Parse a contract the user dropped in via the file picker.
export function parseContract(text: string): ContractEnvelope {
  return asContractEnvelope(JSON.parse(text));
}
