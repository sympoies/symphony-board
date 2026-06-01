// Orchestrate one source's sync: fetch -> store raw -> normalize -> reconcile
// edges -> upsert -> (full+complete only) soft-delete unseen. All writes run in
// one transaction. dry-run computes everything but writes nothing.

import type { DatabaseSync } from "node:sqlite";
import type { Source } from "./sources/types.ts";
import type { ItemState, CanonicalEdge, NormalizedBundle } from "./model/types.ts";
import { reconcileEdges, deriveLifecycle, type ReconciledEdge } from "./model/edges.ts";
import { refOf } from "./model/ref.ts";
import {
  ensureSource,
  upsertRaw,
  upsertItem,
  replaceLabels,
  upsertEdge,
  startRun,
  finishRun,
  updateSyncState,
  softDeleteUnseenItems,
} from "./db/repo.ts";

export interface SyncOptions {
  full: boolean;
  dryRun: boolean;
}

export interface SyncReport {
  sourceId: string;
  status: "ok" | "partial" | "error";
  itemsSeen: number;
  edgesSeen: number;
  softDeleted: number;
  watermark: string | null;
  error: string | null;
}

export async function syncSource(
  db: DatabaseSync,
  source: Source,
  prevWatermark: string | null,
  opts: SyncOptions,
): Promise<SyncReport> {
  const startedAt = new Date().toISOString();
  const sourceId = source.descriptor.sourceId;

  // --- fetch (impure) ---
  let result;
  try {
    result = await source.fetch({ since: prevWatermark, full: opts.full });
  } catch (err) {
    const msg = (err as Error).message;
    if (!opts.dryRun) {
      ensureSource(db, source.descriptor, startedAt);
      const runId = startRun(db, sourceId, opts.full ? "full" : "incremental", startedAt);
      finishRun(db, runId, "error", new Date().toISOString(), 0, 0, msg);
      updateSyncState(db, sourceId, null, "error", msg, startedAt);
    }
    return { sourceId, status: "error", itemsSeen: 0, edgesSeen: 0, softDeleted: 0, watermark: null, error: msg };
  }

  // --- normalize (pure) ---
  const bundles: NormalizedBundle[] = [];
  for (const r of result.records) {
    const b = source.normalize(r);
    if (b !== null) bundles.push(b);
  }
  const stateByRef = new Map<string, ItemState>();
  for (const b of bundles) {
    stateByRef.set(refOf(b.item.sourceId, b.item.externalId), b.item.state);
  }

  // collect edges with the side that reported them (the bundle's own item)
  const discovered: Array<{ edge: CanonicalEdge; side: "from" | "to" }> = [];
  for (const b of bundles) {
    const self = refOf(b.item.sourceId, b.item.externalId);
    for (const edge of b.edges) {
      const side = refOf(edge.from.sourceId, edge.from.externalId) === self ? "from" : "to";
      discovered.push({ edge, side });
    }
  }
  let edges: ReconciledEdge[] = reconcileEdges(discovered);
  // Refine endpoint states from items we actually saw this run, then re-derive.
  edges = edges.map((e) => {
    const fromState = stateByRef.get(refOf(e.from.sourceId, e.from.externalId)) ?? e.fromState;
    const toState = stateByRef.get(refOf(e.to.sourceId, e.to.externalId)) ?? e.toState;
    return { ...e, fromState, toState, lifecycle: deriveLifecycle(e.type, fromState, toState) };
  });

  const status: "ok" | "partial" = result.complete ? "ok" : "partial";
  const report: SyncReport = {
    sourceId,
    status,
    itemsSeen: bundles.length,
    edgesSeen: edges.length,
    softDeleted: 0,
    watermark: result.watermark,
    error: result.error,
  };

  if (opts.dryRun) return report;

  // --- write (one transaction) ---
  db.exec("BEGIN");
  try {
    ensureSource(db, source.descriptor, startedAt);
    const runId = startRun(db, sourceId, opts.full ? "full" : "incremental", startedAt);
    const payloadByExternalId = new Map(result.records.map((r) => [r.externalId, r]));
    for (const b of bundles) {
      const item = b.item;
      const raw = payloadByExternalId.get(item.externalId);
      const payloadJson = JSON.stringify(raw?.payload ?? null);
      upsertRaw(db, sourceId, item.kind, item.externalId, raw?.apiVersion ?? null, raw?.contentHash ?? null, startedAt, payloadJson);
      const itemId = upsertItem(db, item, source.normalizerVersion, startedAt);
      replaceLabels(db, itemId, b.labels);
    }
    for (const e of edges) upsertEdge(db, e, startedAt);

    // Disappearance handling: only a FULL + COMPLETE sweep may tombstone unseen
    // items (a partial fetch must never look like a mass deletion).
    if (opts.full && result.complete) {
      report.softDeleted = softDeleteUnseenItems(db, sourceId, startedAt, new Date().toISOString());
    }

    finishRun(db, runId, status, new Date().toISOString(), bundles.length, edges.length, result.error);
    updateSyncState(db, sourceId, result.watermark, status, result.error, startedAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    report.status = "error";
    report.error = (err as Error).message;
  }
  return report;
}
