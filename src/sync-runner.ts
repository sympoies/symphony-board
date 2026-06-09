// Reusable "sync the selected sources, then emit the contract" runner. The board
// loop daemon and the standalone sync CLI both go through here, so manual and
// scheduled syncs share one definition of a run and one emit-gating rule.
//
// Network lives in the sources (src/sources/*); this module only orchestrates the
// engine + emit and reports structured, per-source results suitable for the UI
// sync status. The emit rule is deliberately single-sourced: emit the contract
// only after a non-dry run that did not fail — a dry-run must never write a
// contract, and a failed run must never present stale derived data as fresh.

import type { DatabaseSync } from "node:sqlite";
import type { AppConfig, SourceConfig } from "./config.ts";
import { tokenFor } from "./config.ts";
import { openDb as defaultOpenDb } from "./db/open.ts";
import { getWatermark } from "./db/repo.ts";
import { buildSource as defaultBuildSource } from "./sources/registry.ts";
import { syncSource } from "./sync-engine.ts";
import type { Source } from "./sources/types.ts";
import { emitContractToFile } from "./contract/emit.ts";
import { log } from "./log.ts";

export type SyncMode = "incremental" | "full";

export interface SyncRunOptions {
  mode: SyncMode;
  dryRun: boolean;
  // Restrict the run to one configured source by its `source_id`; null = every
  // configured source. An out-of-scope source is excluded entirely (not reported
  // as skipped); only an in-scope source whose token env is unset is "skipped".
  sourceId: string | null;
}

export interface SourceRunResult {
  source_id: string;
  status: "ok" | "partial" | "error" | "skipped";
  items: number;
  edges: number;
  activities: number;
  soft_deleted: number;
  soft_deleted_edges: number;
  error: string | null;
}

export interface SyncRunTotals {
  items: number;
  edges: number;
  activities: number;
  soft_deleted: number;
  soft_deleted_edges: number;
}

export interface SyncRunResult {
  status: "ok" | "partial" | "error";
  sources: SourceRunResult[];
  totals: SyncRunTotals;
  emitted: boolean;
  error: string | null;
}

export interface PreparedSource {
  config: SourceConfig;
  source: Source;
}

// Worst-of reduction over the per-source statuses (a skipped source does not
// count as a failure): error > partial > ok.
function overallStatus(sources: SourceRunResult[]): "ok" | "partial" | "error" {
  if (sources.some((s) => s.status === "error")) return "error";
  if (sources.some((s) => s.status === "partial")) return "partial";
  return "ok";
}

function emptyTotals(): SyncRunTotals {
  return { items: 0, edges: 0, activities: 0, soft_deleted: 0, soft_deleted_edges: 0 };
}

// Core run over already-built sources and an open DB — no network setup, no
// config/token resolution — so it is unit-testable with fake sources and an
// in-memory DB. The optional `emit` callback is invoked only on a non-dry,
// non-failed run; that gating is the single definition of "emit unless dry-run or
// failed". `emit` throwing (e.g. a contract that fails producer validation)
// fails the whole run rather than silently shipping nothing.
export async function executeSyncRun(
  db: DatabaseSync,
  prepared: PreparedSource[],
  skipped: string[],
  opts: SyncRunOptions,
  emit?: () => void,
): Promise<SyncRunResult> {
  const full = opts.mode === "full";
  const results: SourceRunResult[] = skipped.map((id) => ({
    source_id: id,
    status: "skipped",
    items: 0,
    edges: 0,
    activities: 0,
    soft_deleted: 0,
    soft_deleted_edges: 0,
    error: null,
  }));

  for (const { config, source } of prepared) {
    const prev = full ? null : getWatermark(db, config.source_id);
    // Announce the in-flight source before the (possibly slow) fetch so a tail of
    // the logs shows which source is currently syncing — the prior line, if it has
    // no matching result, is where a stall is happening.
    log.info(`[${config.source_id}] syncing…`);
    const rep = await syncSource(db, source, prev, { full, dryRun: opts.dryRun });
    log.info(
      `[${rep.sourceId}] status=${rep.status} items=${rep.itemsSeen} edges=${rep.edgesSeen} activities=${rep.activitiesSeen} ` +
        `softDeleted=${rep.softDeleted}items/${rep.softDeletedEdges}edges${rep.error ? ` error=${rep.error}` : ""}`,
    );
    results.push({
      source_id: rep.sourceId,
      status: rep.status,
      items: rep.itemsSeen,
      edges: rep.edgesSeen,
      activities: rep.activitiesSeen,
      soft_deleted: rep.softDeleted,
      soft_deleted_edges: rep.softDeletedEdges,
      error: rep.error,
    });
  }

  const status = overallStatus(results);
  const totals = results.reduce<SyncRunTotals>((acc, r) => {
    acc.items += r.items;
    acc.edges += r.edges;
    acc.activities += r.activities;
    acc.soft_deleted += r.soft_deleted;
    acc.soft_deleted_edges += r.soft_deleted_edges;
    return acc;
  }, emptyTotals());

  let emitted = false;
  let error: string | null = status === "error" ? "one or more sources failed to sync" : null;
  if (emit && !opts.dryRun && status !== "error") {
    try {
      emit();
      emitted = true;
    } catch (err) {
      return {
        status: "error",
        sources: results,
        totals,
        emitted: false,
        error: `contract emit failed: ${(err as Error).message}`,
      };
    }
  }
  return { status, sources: results, totals, emitted, error };
}

export interface RunConfiguredSyncDeps {
  openDb?: typeof defaultOpenDb;
  buildSource?: typeof defaultBuildSource;
  now?: () => string;
}

// CLI/daemon entry: resolve tokens, build the configured sources, open the DB,
// run the engine, and (when `out` is a path) emit the contract there. A source
// whose token env is unset is skipped with a warning, exactly like the standalone
// sync CLI did. When `out` is null the run is sync-only (no emit), preserving the
// `pnpm run sync` contract.
export async function runConfiguredSync(
  cfg: AppConfig,
  opts: SyncRunOptions,
  out: string | null,
  deps: RunConfiguredSyncDeps = {},
): Promise<SyncRunResult> {
  const openDb = deps.openDb ?? defaultOpenDb;
  const buildSource = deps.buildSource ?? defaultBuildSource;
  const now = deps.now ?? (() => new Date().toISOString());

  const prepared: PreparedSource[] = [];
  const skipped: string[] = [];
  for (const sc of cfg.sources) {
    if (opts.sourceId && sc.source_id !== opts.sourceId) continue; // out of scope, not reported
    const token = tokenFor(sc);
    if (!token) {
      log.warn(`skip ${sc.source_id}: env ${sc.token_env} not set`);
      skipped.push(sc.source_id);
      continue;
    }
    prepared.push({ config: sc, source: buildSource(sc, token) });
  }

  const db = openDb(cfg.db_path);
  try {
    const emit = out
      ? () => {
          const counts = emitContractToFile(db, cfg, out, now());
          log.info(
            `emit wrote ${counts.items}/${counts.totalItems} items / ${counts.edges} edges / ${counts.activities} activities -> ${out}`,
          );
        }
      : undefined;
    return await executeSyncRun(db, prepared, skipped, opts, emit);
  } finally {
    db.close();
  }
}
