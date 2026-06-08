// Loading the contract (LAYER 3) for the UI to render. The UI is a pure
// CONSUMER: it reads the versioned JSON envelope and stays liberal in what it
// accepts (it does not re-validate — producers validate strictly; see
// docs/CONTRACT.md). Types come from @symphony-board/contract.

import type { ContractEnvelope } from "@symphony-board/contract";
import type { TimeRange, SyncControlInfo, SyncRunStatus, SyncRunRequest } from "./model.ts";

// The major this UI understands. The contract versions independently; if a
// future emit bumps the MAJOR, the UI should branch (or warn) rather than
// silently mis-render. Minor/patch are backward compatible by contract rule.
export const SUPPORTED_MAJOR = 2;

export function majorOf(version: string): number {
  return Number(version.split(".")[0] ?? "0");
}

// Fetch the contract emitted alongside the app (the loop daemon writes
// data/contract.json; deploy it next to index.html). Relative URL so it works
// under any base path.
export async function fetchContract(url = "./contract.json"): Promise<ContractEnvelope> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status}`);
  return (await res.json()) as ContractEnvelope;
}

export async function fetchRangeContract(range: TimeRange): Promise<ContractEnvelope> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  return fetchContract(`./api/range?${params.toString()}`);
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
export async function fetchSyncControl(): Promise<SyncControlInfo | null> {
  try {
    const res = await fetch("./api/sync-control", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SyncControlInfo;
  } catch {
    return null;
  }
}

export async function fetchCurrentSyncRun(): Promise<SyncRunStatus | null> {
  const res = await fetch("./api/sync-runs/current", { cache: "no-store" });
  if (!res.ok) throw new Error(`sync status: HTTP ${res.status}`);
  const body = (await res.json()) as { current: SyncRunStatus | null };
  return body.current ?? null;
}

export async function fetchLastSyncRun(): Promise<SyncRunStatus | null> {
  const res = await fetch("./api/sync-runs/last", { cache: "no-store" });
  if (!res.ok) throw new Error(`sync status: HTTP ${res.status}`);
  const body = (await res.json()) as { last: SyncRunStatus | null };
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

export async function startSyncRun(req: SyncRunRequest): Promise<StartSyncResult> {
  const res = await fetch("./api/sync-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify(req),
  });
  let body: { current?: SyncRunStatus | null; error?: string } | null = null;
  try {
    body = (await res.json()) as { current?: SyncRunStatus | null; error?: string };
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

// Parse a contract the user dropped in via the file picker.
export function parseContract(text: string): ContractEnvelope {
  const env = JSON.parse(text) as ContractEnvelope;
  if (!env || !Array.isArray(env.items) || typeof env.contract_version !== "string") {
    throw new Error("not a symphony-board contract (missing contract_version / items)");
  }
  return env;
}
