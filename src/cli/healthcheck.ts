// Container healthcheck for the board daemon (see src/sync-heartbeat.ts):
// exits 0 when a contract exists and either it or the sync heartbeat is recent.
// Reads the daemon's own CONTRACT_OUT and INTERVAL so it judges the same files
// and cadence the daemon uses.
import { statSync } from "node:fs";
import { boardHealthy, contractMaxAgeMs, heartbeatPath } from "../sync-heartbeat.ts";

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

const contractOut = process.env.CONTRACT_OUT ?? "data/contract.json";
const intervalSeconds = Math.max(1, Number(process.env.INTERVAL ?? "120") || 120);
const healthy = boardHealthy({
  nowMs: Date.now(),
  contractMtimeMs: mtimeMs(contractOut),
  heartbeatMtimeMs: mtimeMs(heartbeatPath(contractOut)),
  contractMaxAgeMs: contractMaxAgeMs(intervalSeconds),
});
process.exit(healthy ? 0 : 1);
