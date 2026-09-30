// Orchestrate one source's sync: fetch -> store raw -> normalize -> reconcile
// edges -> upsert -> (full+complete only) soft-delete unseen. All writes run in
// one transaction. dry-run computes everything but writes nothing.

import type { CommitFilesCandidate, FetchResult, RawRecord, RefreshCandidate, Source } from "./sources/types.ts";
import type { ItemState, CanonicalCommitFiles, CanonicalEdge, NormalizedBundle } from "./model/types.ts";
import { reconcileEdges, deriveLifecycle, reporterSide, type EdgeReporter, type ReconciledEdge } from "./model/edges.ts";
import { refOf } from "./model/ref.ts";
import type { CiRefreshCandidateRow, Store } from "./db/store.ts";

const DEFAULT_CI_REFRESH_GRACE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CI_REFRESH_LIMIT = 50;
// How far back the commit file pass looks for commits with no file list. A
// year covers the longest range the UI offers; older commits are never asked
// for, so the pass reaches a steady state instead of walking all of history.
const DEFAULT_COMMIT_FILES_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

export interface SyncOptions {
  full: boolean;
  dryRun: boolean;
  ciRefreshGraceMs?: number;
  ciRefreshLimit?: number;
  // How many commits the file pass may answer per sweep. Absent or 0 turns the
  // pass off: it costs one provider request per commit it reads, so it is on
  // only where the caller says how much to spend.
  commitFilesLimit?: number;
  commitFilesLookbackMs?: number;
  graphqlRequestCount?: () => number | null;
  graphqlCost?: () => number | null;
  graphqlCostUnknown?: () => number | null;
}

export interface SyncReport {
  sourceId: string;
  status: "ok" | "partial" | "error";
  itemsSeen: number;
  edgesSeen: number;
  activitiesSeen: number;
  softDeleted: number;
  softDeletedEdges: number;
  graphqlRequests: number | null;
  graphqlCost: number | null;
  graphqlCostUnknown: number | null;
  watermark: string | null;
  error: string | null;
  // Commits the file pass answered for after this sweep (file lists read, plus
  // merges and missing commits recorded as such), and why it stopped early if
  // it did. Neither ever changes `status` or `error`: file data is a
  // decoration, and a sweep marked incomplete over it would block the
  // soft-delete pass that only a complete sweep may run.
  commitFiles: number;
  commitFilesError: string | null;
}

function graphqlRequests(opts: SyncOptions): number | null {
  return opts.graphqlRequestCount?.() ?? null;
}

function graphqlCost(opts: SyncOptions): number | null {
  return opts.graphqlCost?.() ?? null;
}

function graphqlCostUnknown(opts: SyncOptions): number | null {
  return opts.graphqlCostUnknown?.() ?? null;
}

function refreshCutoffIso(startedAt: string, graceMs: number): string {
  return new Date(Date.parse(startedAt) - Math.max(0, graceMs)).toISOString();
}

function ciRefreshReason(row: CiRefreshCandidateRow): RefreshCandidate["reason"] {
  if (row.ci_state === "pending" || row.ci_state === "none") return "ci_unresolved";
  if (row.state === "open") return "open_change_request";
  return "recent_change_request";
}

function toRefreshCandidate(row: CiRefreshCandidateRow): RefreshCandidate {
  return {
    externalId: row.external_id,
    projectPath: row.project_path,
    iid: row.iid,
    reason: ciRefreshReason(row),
  };
}

function dedupeRecords(records: RawRecord[]): RawRecord[] {
  const byKey = new Map<string, RawRecord>();
  for (const record of records) byKey.set(`${record.entityKind}\0${record.externalId}`, record);
  return [...byKey.values()];
}

// A provider can return a max-updated watermark later than this run's start
// after fetching a subset first; keep mid-run updates eligible next time.
function capWatermarkAtRunStart(watermark: string | null, startedAt: string): string | null {
  if (watermark === null) return null;
  const watermarkMs = Date.parse(watermark);
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(watermarkMs) || Number.isNaN(startedAtMs)) return watermark;
  return watermarkMs > startedAtMs ? startedAt : watermark;
}

async function fetchWithRefresh(
  store: Store,
  source: Source,
  sourceId: string,
  prevWatermark: string | null,
  opts: SyncOptions,
  startedAt: string,
): Promise<FetchResult> {
  const result = await source.fetch({ since: prevWatermark, full: opts.full });
  if (opts.full || !source.fetchRefresh) return result;

  const graceMs = opts.ciRefreshGraceMs ?? DEFAULT_CI_REFRESH_GRACE_MS;
  const limit = opts.ciRefreshLimit ?? DEFAULT_CI_REFRESH_LIMIT;
  const candidates = (await store.listCiRefreshCandidates(sourceId, refreshCutoffIso(startedAt, graceMs), limit)).map(toRefreshCandidate);
  if (candidates.length === 0) return result;

  try {
    const refresh = await source.fetchRefresh(candidates, { since: null, full: false });
    return {
      records: dedupeRecords([...result.records, ...refresh.records]),
      watermark: result.watermark,
      complete: result.complete && refresh.complete,
      error: result.error ?? refresh.error,
    };
  } catch (err) {
    return {
      ...result,
      complete: false,
      error: result.error ?? `ci refresh: ${(err as Error).message}`,
    };
  }
}

// Persist a failed run + sync_state error (no-op on dry-run) and build the error
// report. Shared by the failed-fetch and crashed-normalize paths so both record
// the failure identically — and, by the disappearance rule, tombstone nothing.
async function recordFailedRun(
  store: Store,
  source: Source,
  opts: SyncOptions,
  startedAt: string,
  msg: string,
): Promise<SyncReport> {
  const sourceId = source.descriptor.sourceId;
  if (!opts.dryRun) {
    await store.ensureSource(source.descriptor, startedAt);
    const runId = await store.startRun(sourceId, opts.full ? "full" : "incremental", startedAt);
    await store.finishRun(runId, "error", new Date().toISOString(), 0, 0, 0, graphqlRequests(opts), graphqlCost(opts), graphqlCostUnknown(opts), msg);
    await store.updateSyncState(sourceId, null, "error", msg, startedAt);
  }
  return {
    sourceId,
    status: "error",
    itemsSeen: 0,
    edgesSeen: 0,
    activitiesSeen: 0,
    softDeleted: 0,
    softDeletedEdges: 0,
    graphqlRequests: graphqlRequests(opts),
    graphqlCost: graphqlCost(opts),
    graphqlCostUnknown: graphqlCostUnknown(opts),
    watermark: null,
    error: msg,
    commitFiles: 0,
    commitFilesError: null,
  };
}

// The commit file pass: ask the source for the changed files of recent commits
// the store has no answer for, and store the answers.
//
// It runs AFTER the sweep's own transaction, in one of its own, because what it
// reads is a consequence of that sweep (the commits it just stored) and because
// nothing about it may fail the sweep. The store is the queue: newest commits
// first, at most `limit` per sweep, within a lookback. Every row the queue
// returns is answered somehow, or the same rows would come back forever and
// starve the rest:
//   - a merge is recorded as one without a request (its diff is against the
//     first parent, which is the merged branch's work again);
//   - a row with no usable sha is recorded as unavailable;
//   - the rest go to the source, which answers with a file list or a note that
//     the provider no longer has the commit.
// A commit the source could NOT answer (a transport or rate-limit failure
// stopped the pass) gets no row and is asked for again next sweep.
async function enrichCommitFiles(store: Store, source: Source, opts: SyncOptions, startedAt: string): Promise<{ written: number; error: string | null }> {
  const limit = Math.max(0, Math.trunc(opts.commitFilesLimit ?? 0));
  if (limit === 0 || opts.dryRun || !source.fetchCommitFiles) return { written: 0, error: null };
  const sourceId = source.descriptor.sourceId;
  try {
    const since = new Date(Date.parse(startedAt) - (opts.commitFilesLookbackMs ?? DEFAULT_COMMIT_FILES_LOOKBACK_MS)).toISOString();
    const rows = await store.listCommitFileCandidates(sourceId, since, limit);
    if (rows.length === 0) return { written: 0, error: null };

    const direct: CanonicalCommitFiles[] = [];
    const ask: CommitFilesCandidate[] = [];
    for (const row of rows) {
      const details = parseCommitDetails(row.details);
      const sha = typeof details?.sha === "string" ? details.sha.trim() : "";
      const answer = (state: "merge" | "unavailable"): CanonicalCommitFiles => ({
        sourceId,
        externalId: row.external_id,
        projectPath: row.project_path,
        sha,
        state,
        truncated: false,
        files: [],
      });
      if (details?.merge === true) direct.push(answer("merge"));
      else if (!sha) direct.push(answer("unavailable"));
      else ask.push({ externalId: row.external_id, projectPath: row.project_path, sha });
    }

    const fetched = ask.length > 0 ? await source.fetchCommitFiles(ask) : { records: [], stopped: null };
    const normalized: CanonicalCommitFiles[] = [];
    for (const raw of fetched.records) normalized.push(...(source.normalize(raw)?.commitFiles ?? []));

    const now = new Date().toISOString();
    await store.transaction(async (tx) => {
      for (const raw of fetched.records) {
        await tx.upsertRaw(sourceId, raw.entityKind, raw.externalId, raw.apiVersion ?? null, raw.contentHash ?? null, raw.fetchedAt, JSON.stringify(raw.payload ?? null));
      }
      for (const files of [...direct, ...normalized]) await tx.upsertCommitFiles(files, now);
    });
    return { written: direct.length + normalized.length, error: fetched.stopped };
  } catch (err) {
    return { written: 0, error: (err as Error).message };
  }
}

function parseCommitDetails(raw: string | null): { sha?: unknown; merge?: unknown } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { sha?: unknown; merge?: unknown }) : null;
  } catch {
    return null;
  }
}

export async function syncSource(
  store: Store,
  source: Source,
  prevWatermark: string | null,
  opts: SyncOptions,
): Promise<SyncReport> {
  const startedAt = new Date().toISOString();
  const sourceId = source.descriptor.sourceId;

  // --- fetch (impure) ---
  let result: FetchResult;
  try {
    result = await fetchWithRefresh(store, source, sourceId, prevWatermark, opts, startedAt);
  } catch (err) {
    return recordFailedRun(store, source, opts, startedAt, (err as Error).message);
  }

  // --- normalize + reconcile (pure) ---
  // A normalizer crash (a malformed payload tripping a normalizer bug) is a
  // SOURCE failure, not a process crash: record it exactly like a failed fetch
  // so one bad payload cannot take down a multi-source run — and, by the same
  // invariant, never tombstone.
  let bundles: NormalizedBundle[];
  let edges: ReconciledEdge[];
  try {
    bundles = [];
    for (const r of result.records) {
      const b = source.normalize(r);
      if (b !== null) bundles.push(b);
    }
    const stateByRef = new Map<string, ItemState>();
    for (const b of bundles) {
      if (b.item === null) continue;
      stateByRef.set(refOf(b.item.sourceId, b.item.externalId), b.item.state);
    }

    // collect edges with the side that reported them (the bundle's own item,
    // which is neither endpoint of a tracker's `blocks` edge)
    const discovered: Array<{ edge: CanonicalEdge; side: EdgeReporter }> = [];
    for (const b of bundles) {
      if (b.item === null) continue;
      for (const edge of b.edges) discovered.push({ edge, side: reporterSide(edge, b.item) });
    }
    edges = reconcileEdges(discovered);
    // Refine endpoint states from items we actually saw this run, then re-derive.
    edges = edges.map((e) => {
      const fromState = stateByRef.get(refOf(e.from.sourceId, e.from.externalId)) ?? e.fromState;
      const toState = stateByRef.get(refOf(e.to.sourceId, e.to.externalId)) ?? e.toState;
      return { ...e, fromState, toState, lifecycle: deriveLifecycle(e.type, fromState, toState) };
    });
  } catch (err) {
    return recordFailedRun(store, source, opts, startedAt, `normalize: ${(err as Error).message}`);
  }

  const status: "ok" | "partial" = result.complete ? "ok" : "partial";
  const itemBundles = bundles.filter((b) => b.item !== null);
  const activities = bundles.flatMap((b) => b.activities);
  const reviewThreads = bundles.flatMap((b) => b.reviewThreads ?? []);
  const watermark = capWatermarkAtRunStart(result.watermark, startedAt);
  const report: SyncReport = {
    sourceId,
    status,
    itemsSeen: itemBundles.length,
    edgesSeen: edges.length,
    activitiesSeen: activities.length,
    softDeleted: 0,
    softDeletedEdges: 0,
    graphqlRequests: graphqlRequests(opts),
    graphqlCost: graphqlCost(opts),
    graphqlCostUnknown: graphqlCostUnknown(opts),
    watermark,
    error: result.error,
    commitFiles: 0,
    commitFilesError: null,
  };

  if (opts.dryRun) return report;

  // --- write (one transaction) ---
  try {
    await store.transaction(async (tx) => {
      await tx.ensureSource(source.descriptor, startedAt);
      const runId = await tx.startRun(sourceId, opts.full ? "full" : "incremental", startedAt);
      for (const raw of result.records) {
        await tx.upsertRaw(
          sourceId,
          raw.entityKind,
          raw.externalId,
          raw.apiVersion ?? null,
          raw.contentHash ?? null,
          raw.fetchedAt,
          JSON.stringify(raw.payload ?? null),
        );
      }
      for (const b of bundles) {
        if (b.item === null) continue;
        const item = b.item;
        const itemId = await tx.upsertItem(item, source.normalizerVersion, startedAt);
        await tx.replaceLabels(itemId, b.labels);
      }
      for (const e of edges) await tx.upsertEdge(e, startedAt);
      for (const a of activities) await tx.upsertActivity(a, startedAt);
      for (const thread of reviewThreads) await tx.upsertReviewThread(thread, startedAt);

      // Disappearance handling: only a FULL + COMPLETE sweep may tombstone unseen
      // items AND edges (a partial fetch must never look like a mass deletion).
      // Both are gated identically; an incremental run (opts.full=false) never
      // deletes, and a re-seen item/edge revives on its next upsert.
      if (opts.full && result.complete) {
        const sweepAt = new Date().toISOString();
        report.softDeleted = await tx.softDeleteUnseenItems(sourceId, startedAt, sweepAt);
        report.softDeletedEdges = await tx.softDeleteUnseenEdges(sourceId, startedAt, sweepAt);
        await tx.softDeleteUnseenReviewThreads(sourceId, startedAt, sweepAt);
      }

      await tx.finishRun(
        runId,
        status,
        new Date().toISOString(),
        itemBundles.length,
        edges.length,
        activities.length,
        report.graphqlRequests,
        report.graphqlCost,
        report.graphqlCostUnknown,
        result.error,
      );
      await tx.updateSyncState(sourceId, watermark, status, result.error, startedAt);
    });
  } catch (err) {
    report.status = "error";
    report.error = (err as Error).message;
    return report;
  }

  const files = await enrichCommitFiles(store, source, opts, startedAt);
  report.commitFiles = files.written;
  report.commitFilesError = files.error;
  return report;
}
