// Reusable "sync the selected sources, then emit the contract" runner. The board
// loop daemon and the standalone sync CLI both go through here, so manual and
// scheduled syncs share one definition of a run and one emit-gating rule.
//
// Network lives in the sources (src/sources/*); this module only orchestrates the
// engine + emit and reports structured, per-source results suitable for the UI
// sync status. The emit rule is deliberately single-sourced: emit the contract
// only after a non-dry run that did not fail — a dry-run must never write a
// contract, and a failed run must never present stale derived data as fresh.

import type { AppConfig, SourceConfig } from "./config.ts";
import { projectPaths, sourceEnabled, sourceTokenEnvNames } from "./config.ts";
import { createAuthTokenResolver, type AuthTokenResolver } from "./auth.ts";
import type { Store } from "./db/store.ts";
import { openConfiguredStore } from "./db/factory.ts";
import { buildSource as defaultBuildSource } from "./sources/registry.ts";
import { syncSource } from "./sync-engine.ts";
import type { Source, SourceRunTelemetry } from "./sources/types.ts";
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
  rest_requests?: number | null;
  graphql_requests?: number | null;
  graphql_cost?: number | null;
  graphql_cost_unknown?: number | null;
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
  // "skipped": another live writer held the store's writer lease, so the
  // whole run was skipped before touching any source; benign, not a failure
  // (the loop daemon's next tick simply tries again).
  status: "ok" | "partial" | "error" | "skipped";
  sources: SourceRunResult[];
  totals: SyncRunTotals;
  emitted: boolean;
  error: string | null;
}

export interface PreparedSource {
  config: SourceConfig;
  source: Source;
  telemetry?: SourceRunTelemetry | null;
}

// Mid-run progress for a live run status (the daemon's RunStatus): the
// per-source results so far (skipped + finished, in run order) and the source
// currently being fetched. Reported before each source starts and after it
// finishes; `sources` is a snapshot, safe to hold across later reports.
export interface SyncRunProgress {
  sources: SourceRunResult[];
  active_source_id: string | null;
}

export type SyncProgressReporter = (progress: SyncRunProgress) => void;

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

// Core run over already-built sources and an open store — no network setup, no
// config/token resolution — so it is unit-testable with fake sources and an
// in-memory store. The optional `emit` callback is invoked only on a non-dry,
// non-failed run; that gating is the single definition of "emit unless dry-run or
// failed". `emit` rejecting (e.g. a contract that fails producer validation)
// fails the whole run rather than silently shipping nothing.
export async function executeSyncRun(
  store: Store,
  prepared: PreparedSource[],
  skipped: string[],
  opts: SyncRunOptions,
  emit?: () => Promise<void> | void,
  onProgress?: SyncProgressReporter,
  // Pre-resolved per-source error results (e.g. a source whose GitHub App token
  // mint hard-failed before any fetch). They count toward overallStatus, so a
  // hard auth failure blocks emit exactly like an in-flight fetch failure.
  errored: SourceRunResult[] = [],
): Promise<SyncRunResult> {
  const full = opts.mode === "full";
  // The writer lease guards the whole non-dry run: when another live writer
  // holds it, skip everything before touching any source — non-blocking, like a
  // scheduled tick skipping while a manual run is active. A dry-run
  // writes nothing and runs leaseless, so inspecting a live deployment whose
  // daemon is mid-run stays possible.
  if (!opts.dryRun && !(await store.acquireWriterLease())) {
    log.warn("another sync writer holds the lease; skipping this run");
    return { status: "skipped", sources: [], totals: emptyTotals(), emitted: false, error: null };
  }
  try {
    const results: SourceRunResult[] = [
      ...skipped.map((id) => ({
        source_id: id,
        status: "skipped" as const,
        items: 0,
        edges: 0,
        activities: 0,
        rest_requests: null,
        graphql_requests: null,
        graphql_cost: null,
        graphql_cost_unknown: null,
        soft_deleted: 0,
        soft_deleted_edges: 0,
        error: null,
      })),
      ...errored,
    ];

    for (const { config, source, telemetry } of prepared) {
      const prev = full ? null : await store.getWatermark(config.source_id);
      // Announce the in-flight source before the (possibly slow) fetch so a tail of
      // the logs shows which source is currently syncing — the prior line, if it has
      // no matching result, is where a stall is happening.
      log.info(`[${config.source_id}] syncing…`);
      onProgress?.({ sources: [...results], active_source_id: config.source_id });
      const rep = await syncSource(store, source, prev, {
        full,
        dryRun: opts.dryRun,
        graphqlRequestCount: () => telemetry?.graphqlRequests ?? null,
        graphqlCost: () => telemetry?.graphqlCost ?? null,
        graphqlCostUnknown: () => telemetry?.graphqlCostUnknown ?? null,
      });
      log.info(
        `[${rep.sourceId}] status=${rep.status} items=${rep.itemsSeen} edges=${rep.edgesSeen} activities=${rep.activitiesSeen} ` +
          `graphqlReq=${rep.graphqlRequests ?? "-"} graphqlCost=${rep.graphqlCost ?? "-"} graphqlCostUnknown=${rep.graphqlCostUnknown ?? "-"} ` +
          `restReq=${telemetry?.restRequests ?? "-"} ` +
          `softDeleted=${rep.softDeleted}items/${rep.softDeletedEdges}edges${rep.error ? ` error=${rep.error}` : ""}`,
      );
      results.push({
        source_id: rep.sourceId,
        status: rep.status,
        items: rep.itemsSeen,
        edges: rep.edgesSeen,
        activities: rep.activitiesSeen,
        rest_requests: telemetry?.restRequests ?? null,
        graphql_requests: rep.graphqlRequests,
        graphql_cost: rep.graphqlCost,
        graphql_cost_unknown: rep.graphqlCostUnknown,
        soft_deleted: rep.softDeleted,
        soft_deleted_edges: rep.softDeletedEdges,
        error: rep.error,
      });
      onProgress?.({ sources: [...results], active_source_id: null });
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
        await emit();
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
  } finally {
    if (!opts.dryRun) await store.releaseWriterLease();
  }
}

export interface RunConfiguredSyncDeps {
  // Store opener taking the whole config: the default (src/db/factory.ts)
  // selects the driver from it (db_url_env -> Postgres, else SQLite db_path).
  openStore?: (cfg: AppConfig) => Promise<Store>;
  buildSource?: typeof defaultBuildSource;
  authTokenResolver?: AuthTokenResolver;
  now?: () => string;
  // Mid-run progress hook for a live run status; see SyncRunProgress.
  onProgress?: SyncProgressReporter;
}

// CLI/daemon entry: resolve tokens, build the configured sources, open the
// store, run the engine, and (when `out` is a path) emit the contract there. A
// source whose token env is unset is skipped with a warning, exactly like the
// standalone sync CLI did. When `out` is null the run is sync-only (no emit),
// preserving the `pnpm run sync` contract.
export async function runConfiguredSync(
  cfg: AppConfig,
  opts: SyncRunOptions,
  out: string | null,
  deps: RunConfiguredSyncDeps = {},
): Promise<SyncRunResult> {
  const openStore = deps.openStore ?? openConfiguredStore;
  const buildSource = deps.buildSource ?? defaultBuildSource;
  const authTokenResolver = deps.authTokenResolver ?? createAuthTokenResolver();
  const now = deps.now ?? (() => new Date().toISOString());

  const prepared: PreparedSource[] = [];
  const skipped: string[] = [];
  const errored: SourceRunResult[] = [];
  for (const sc of cfg.sources) {
    if (opts.sourceId && sc.source_id !== opts.sourceId) continue; // out of scope, not reported
    if (!sourceEnabled(sc)) {
      log.warn(`skip ${sc.source_id}: disabled in config`);
      skipped.push(sc.source_id);
      continue;
    }
    const tokens = await authTokenResolver.tokensForSource(sc);
    const projectTokens = sc.kind === "github"
      ? new Map(await Promise.all(projectPaths(sc).map(async (projectPath) => [projectPath, await authTokenResolver.tokensForProject(sc, projectPath)] as const)))
      : new Map<string, typeof tokens>();
    // A configured GitHub App mint that hard-failed (no usable fallback token in
    // its pool) is an actionable auth error, not a benign "token unset" skip:
    // surface it so the run fails and does not silently re-emit a stale contract
    // or fetch the repo with credentials outside its selected pool.
    const mintFailure = authTokenResolver.hardMintFailure?.(sc) ?? null;
    if (mintFailure) {
      const error = `GitHub App token mint failed with no usable fallback token: ${mintFailure}`;
      log.error(`error ${sc.source_id}: ${error}`);
      errored.push({
        source_id: sc.source_id,
        status: "error",
        items: 0,
        edges: 0,
        activities: 0,
        rest_requests: null,
        graphql_requests: null,
        graphql_cost: null,
        graphql_cost_unknown: null,
        soft_deleted: 0,
        soft_deleted_edges: 0,
        error,
      });
      continue;
    }
    const hasAnyTokens = tokens.length > 0 || (sc.kind === "github" && [...projectTokens.values()].some((projectTokenSet) => projectTokenSet.length > 0));
    if (!hasAnyTokens) {
      const envNames = sourceTokenEnvNames(sc).join(", ");
      log.warn(`skip ${sc.source_id}: none of token envs [${envNames}] are set`);
      skipped.push(sc.source_id);
      continue;
    }
    const telemetry: SourceRunTelemetry = {
      graphqlRequests: 0,
      restRequests: 0,
      graphqlCost: sc.kind === "github" ? 0 : null,
      graphqlCostUnknown: sc.kind === "github" ? 0 : null,
    };
    prepared.push({ config: sc, source: buildSource(sc, tokens, projectTokens, telemetry), telemetry });
  }

  const store = await openStore(cfg);
  try {
    const emit = out
      ? async () => {
          const counts = await emitContractToFile(store, cfg, out, now());
          log.info(
            `emit wrote ${counts.items}/${counts.totalItems} items / ${counts.edges} edges / ${counts.activities} activities -> ${out}`,
          );
        }
      : undefined;
    return await executeSyncRun(store, prepared, skipped, opts, emit, deps.onProgress, errored);
  } finally {
    await store.close();
  }
}
