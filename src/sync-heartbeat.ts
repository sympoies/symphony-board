// Board daemon health. The container healthcheck used to pass only while
// data/contract.json was recent, but a full sweep can run longer than that
// bound and emits only when it ends, so every long sweep flapped unhealthy.
//
// The daemon now also rewrites a heartbeat file next to the contract whenever a
// provider answered since its last tick. The board is healthy when a contract
// exists and either the contract or the heartbeat is recent: a progressing
// sweep stays healthy, while a sweep that stops getting provider answers turns
// unhealthy once the heartbeat bound passes.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HEARTBEAT_FILE = "sync-progress.json";
// A large project's page takes seconds and its whole fetch about half a
// minute, so ten minutes without any provider answer is a stall.
export const HEARTBEAT_MAX_AGE_MS = 10 * 60_000;
export const HEARTBEAT_TICK_MS = 60_000;
const CONTRACT_MIN_MAX_AGE_MS = 30 * 60_000;

export function heartbeatPath(contractOut: string): string {
  return join(dirname(contractOut), HEARTBEAT_FILE);
}

// Well inside one cadence for the default loop, and never shorter than two
// intervals for a slow one.
export function contractMaxAgeMs(intervalSeconds: number): number {
  return Math.max(CONTRACT_MIN_MAX_AGE_MS, 2 * intervalSeconds * 1000);
}

export function boardHealthy(input: {
  nowMs: number;
  contractMtimeMs: number | null;
  heartbeatMtimeMs: number | null;
  contractMaxAgeMs: number;
}): boolean {
  // Without a contract there is nothing to serve yet: `web` waits on this.
  if (input.contractMtimeMs === null) return false;
  if (input.nowMs - input.contractMtimeMs < input.contractMaxAgeMs) return true;
  return input.heartbeatMtimeMs !== null && input.nowMs - input.heartbeatMtimeMs < HEARTBEAT_MAX_AGE_MS;
}

// Rewrite the heartbeat on each tick where `progressAt` (the latest provider
// response, epoch ms) advanced. Returns a stop function.
export function startSyncHeartbeat(
  path: string,
  opts: { progressAt: () => number; tickMs?: number; onWrite?: () => void },
): () => void {
  let written = 0;
  const timer = setInterval(() => {
    const at = opts.progressAt();
    if (at <= written) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ last_provider_response_at: new Date(at).toISOString() })}\n`);
      renameSync(tmp, path);
      written = at;
      opts.onWrite?.();
    } catch {
      // A failed write leaves the heartbeat stale; the healthcheck reports it.
    }
  }, opts.tickMs ?? HEARTBEAT_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
