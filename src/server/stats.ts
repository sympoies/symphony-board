// Read-only store statistics for the UI Diagnostics page (GET /api/stats),
// shared by the Docker `api` sidecar (src/cli/range-api.ts) and the standalone
// app server (src/cli/app-server.ts). Same access discipline as range.ts: every
// call opens the store read-only and closes it before returning, so the
// hosting process never holds a second writable handle.
//
// This is an operational surface, NOT part of the versioned contract — it
// describes the store (sizes, row counts, sync-run history), never the
// work-item data model, so it carries no contract_version and needs no bump.
// The portable parts (row counts, breakdowns, run history) come from
// Store.overview(); the `db` block is Store.diagnostics(), passed through
// verbatim — its keys are driver-specific by design.

import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { AppConfig } from "../config.ts";
import type { Store, StoreDiagnostics, StoreOverview } from "../db/store.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";

export type { StoreSyncRunRow as StatsSyncRunRow } from "../db/store.ts";

export interface StoreStats extends StoreOverview {
  generated_at: string;
  db: StoreDiagnostics;
}

const DEFAULT_RUNS = 20;
const MAX_RUNS = 200;

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function buildStoreStats(store: Store, runsLimit = DEFAULT_RUNS): Promise<StoreStats> {
  const overview = await store.overview(runsLimit);
  return {
    generated_at: new Date().toISOString(),
    db: await store.diagnostics(),
    ...overview,
  };
}

export async function storeStats(cfg: AppConfig, runsLimit = DEFAULT_RUNS): Promise<StoreStats> {
  const store = await openConfiguredStoreReadOnly(cfg);
  try {
    return await buildStoreStats(store, runsLimit);
  } finally {
    await store.close();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body) + "\n");
}

// Serve one GET /api/stats request. "?runs=<n>" bounds the sync-run history
// (default 20, capped). A SQLite store that does not exist yet — a fresh
// deployment before the first sync — is a 404 the UI maps to "no data yet",
// not an error. The file precheck is meaningless under Postgres (db_path is
// unused there); a pg store the writer has not migrated yet fails loudly at
// open instead.
export async function handleStatsRequest(cfg: AppConfig, url: URL, res: ServerResponse): Promise<void> {
  const runsRaw = Number(url.searchParams.get("runs") ?? String(DEFAULT_RUNS));
  const runs = Number.isFinite(runsRaw) && runsRaw > 0 ? Math.min(Math.trunc(runsRaw), MAX_RUNS) : DEFAULT_RUNS;
  if (!cfg.db_url_env?.trim() && cfg.db_path !== ":memory:" && fileSize(cfg.db_path) === 0) {
    json(res, 404, { error: "no_database", message: `no store at ${cfg.db_path} (run a sync first)` });
    return;
  }
  try {
    json(res, 200, await storeStats(cfg, runs));
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
}
