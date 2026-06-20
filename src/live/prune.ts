// Retention policy for the live-event store: a TTL (default ~30 days) plus a
// hard row cap, run on an interval by the receiver. Pruning past the retained
// window also bounds the SSE replay backlog. Config is read from the
// environment by name (never inlined); the receiver owns the timer lifecycle.
import { log } from "../log.ts";
import type { LiveStore } from "./store.ts";

export const DEFAULT_TTL_DAYS = 30;
export const DEFAULT_MAX_ROWS = 50_000;
export const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

export interface PruneConfig {
  ttlDays: number;
  maxRows: number;
  intervalMs: number;
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolvePruneConfig(
  env: Record<string, string | undefined> = process.env,
): PruneConfig {
  return {
    ttlDays: intEnv(env.LIVE_EVENT_TTL_DAYS, DEFAULT_TTL_DAYS),
    maxRows: intEnv(env.LIVE_MAX_ROWS, DEFAULT_MAX_ROWS),
    intervalMs: intEnv(env.LIVE_PRUNE_INTERVAL_MS, DEFAULT_PRUNE_INTERVAL_MS),
  };
}

// Run prune on an interval. Returns a stop handle. The timer is unref'd so it
// never keeps the process alive on its own.
export function startPruneTimer(
  store: LiveStore,
  config: PruneConfig,
): () => void {
  const tick = (): void => {
    try {
      store.prune(config.ttlDays, config.maxRows);
    } catch (err) {
      log.warn(`live prune failed: ${(err as Error).message}`);
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
