// Read-only endpoint serving the FULL-history `activity_daily` aggregate from the
// emitted contract file. The Activity Overview is fixed to the trailing 12 months,
// but a device with a windowed Board data scope loads a `/api/range` projection as
// its primary env, whose `activity_daily` covers only that window (see
// docs/CONTRACT.md "Activity Daily"). This route hands back the full aggregate the
// static `contract.json` carries — independent of any board window — so the overview
// stays a true 12 months without the device downloading the whole contract.
//
// Source is the daemon-emitted contract file (the same one `/contract.json`
// serves), NOT a store query: the full-history aggregate is already computed at
// emit, so reading it back is cheap and adds no Store/driver/schema surface. Shared
// by the standalone app-server (src/cli/app-server.ts) and the Docker `api` sidecar
// (src/cli/range-api.ts), both of which have the contract file on disk.

import { readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { ActivityDailyDTO } from "@symphony-board/contract";
import { sendJsonMaybeGzip } from "./http.ts";

// mtime-keyed cache of the parsed aggregate. The contract file is large (~5–6 MB)
// and only changes when the writer emits a new one, so parse it once per emit
// rather than per request. Keyed by path too: tests (and any multi-store host) run
// several servers in one process.
const cache = new Map<string, { mtimeMs: number; daily: ActivityDailyDTO | null }>();

// Read `activity_daily` from the emitted contract file. Returns `null` (no result)
// when the file does not exist yet (no emit), or `{ daily }` where `daily` is the
// aggregate or `null` for a pre-4.0.0 contract that carries none. A corrupt/partial
// read (a concurrent emit) is treated as `null` and re-attempted on the next request
// once the mtime advances.
export function readActivityDaily(contractPath: string): { daily: ActivityDailyDTO | null } | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(contractPath).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(contractPath);
  if (hit && hit.mtimeMs === mtimeMs) return { daily: hit.daily };
  let daily: ActivityDailyDTO | null = null;
  try {
    const parsed = JSON.parse(readFileSync(contractPath, "utf8")) as { activity_daily?: ActivityDailyDTO | null };
    daily = parsed.activity_daily ?? null;
  } catch {
    return null;
  }
  cache.set(contractPath, { mtimeMs, daily });
  return { daily };
}

// Serve one GET /api/activity-daily request. 404 until the first emit (like
// /contract.json); otherwise 200 with `{ activity_daily }` — `null` for a pre-4.0.0
// contract, which the UI falls back from to its primary env's aggregate.
export function handleActivityDailyRequest(
  contractPath: string,
  res: ServerResponse,
  acceptEncoding: string | string[] | undefined,
): void {
  const result = readActivityDaily(contractPath);
  if (!result) {
    sendJsonMaybeGzip(res, 404, { error: "no_contract", message: "no contract emitted yet" }, acceptEncoding);
    return;
  }
  sendJsonMaybeGzip(res, 200, { activity_daily: result.daily }, acceptEncoding);
}
