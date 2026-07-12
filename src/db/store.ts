// The provider-agnostic persistence interface over the canonical store.
//
// `Store` is the internal seam between the sync engine / contract emit / server
// surfaces and whatever database holds the canonical model. Every method is
// async even though the current SQLite driver (src/db/sqlite.ts) is synchronous
// under the hood: any future driver (Postgres) is necessarily async, and the
// interface must not change when one arrives. A driver owns its SQL dialect,
// its DDL (schema/<driver>/*.sql), and its migration mechanism entirely — the
// interface is the contract, never the schema.
//
// Conformance: test/store-conformance.test.ts runs behavior tests against every
// registered driver. A new driver is acceptable when that suite passes — the
// suite, not the type signatures, is the swap guarantee.

import type { CanonicalActivity, CanonicalItem, CanonicalLabel, CanonicalReviewThread } from "../model/types.ts";
import type { ReconciledEdge } from "../model/edges.ts";
import type { SourceDescriptor } from "../sources/types.ts";

// ---- row shapes (driver-mapped, interface speaks JS types) -----------------

export interface ItemRow {
  item_id: number;
  source_id: string;
  external_id: string;
  kind: string;
  project_path: string | null;
  iid: number | null;
  url: string | null;
  title: string | null;
  body: string | null;
  state: string;
  state_raw: string | null;
  state_reason: string | null;
  is_draft: boolean | null;
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  review_state: string | null;
  ci_state: string | null;
  merge_state: string | null;
  open_review_threads: number | null;
  total_review_threads: number | null;
  comment_total: number | null;
  milestone: string | null;
  demand: number | null;
  last_seen_at: string | null;
}

export interface LabelRow {
  item_id: number;
  name: string;
  scope: string | null;
  color: string | null;
}

export interface EdgeRow {
  type: string;
  from_source_id: string;
  from_external_id: string;
  to_source_id: string;
  to_external_id: string;
  from_state: string | null;
  to_state: string | null;
  lifecycle: string | null;
}

export interface SourceRow {
  source_id: string;
  kind: string;
  host: string;
  display_name: string | null;
  last_success_at: string | null;
  last_status: string | null;
}

export interface ActivityRow {
  source_id: string;
  external_id: string;
  kind: string;
  action: string;
  project_path: string | null;
  target_kind: string | null;
  target_source_id: string | null;
  target_external_id: string | null;
  target_iid: number | null;
  title: string | null;
  url: string | null;
  actor: string | null;
  actor_key: string | null;
  occurred_at: string;
  summary: string | null;
  details: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface ReviewThreadRow {
  source_id: string;
  external_id: string;
  project_path: string | null;
  target_source_id: string;
  target_external_id: string;
  target_iid: number | null;
  title: string | null;
  url: string | null;
  is_resolved: boolean;
  is_outdated: boolean | null;
  resolved_by: string | null;
  path: string | null;
  line: number | null;
  start_line: number | null;
  comments_total: number;
  comments_json: string;
  // True newest-comment instant (ISO), independent of the `comments_json`
  // preview window. Nullable: pre-4.3.0 rows (and rows from a source that
  // reported no datable comment) carry null until the thread is re-synced.
  last_comment_at: string | null;
  last_seen_at: string | null;
}

// Cached all-time activity bounds for one repo (source_id, project_path): the
// earliest and latest occurred_at INSTANT observed across the whole activity
// history, independent of any range window. One row per repo that has at least
// one parseable activity instant. See Store.listRepoActivityBounds.
export interface RepoActivityBoundsRow {
  source_id: string;
  project_path: string | null;
  observed_since: string | null;
  last_activity_at: string | null;
}

export interface CiRefreshCandidateRow {
  source_id: string;
  external_id: string;
  project_path: string;
  iid: number;
  state: string;
  ci_state: string | null;
  updated_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  last_seen_at: string | null;
}

// ---- operational surface ---------------------------------------------------

export interface StoreSyncRunRow {
  run_id: number;
  source_id: string;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  items_seen: number;
  edges_seen: number;
  activities_seen: number;
  graphql_requests: number | null;
  graphql_cost: number | null;
  graphql_cost_unknown: number | null;
  error: string | null;
}

// Portable store summary backing GET /api/stats: every driver can answer these
// (row counts, breakdowns, run history) from the canonical model.
export interface StoreOverview {
  tables: Record<string, number>;
  items: {
    live: number;
    tombstoned: number;
    by_kind: Record<string, number>;
    by_state: Record<string, number>;
    by_source: Record<string, number>;
  };
  edges: {
    live: number;
    tombstoned: number;
    by_type: Record<string, number>;
    by_lifecycle: Record<string, number>;
  };
  activities: {
    total: number;
    by_kind: Record<string, number>;
    earliest: string | null;
    latest: string | null;
  };
  sync_runs: StoreSyncRunRow[];
}

// Driver-specific health/size facts (file sizes and page counts for SQLite;
// whatever the engine exposes elsewhere). Keys are NOT part of any contract —
// the stats endpoint passes them through verbatim as an operational surface.
export type StoreDiagnostics = Record<string, string | number>;

// ---- the interface ----------------------------------------------------------

export interface Store {
  // -- write paths (run inside transaction() when multi-statement atomicity
  //    matters; a bare call autocommits) --
  ensureSource(d: SourceDescriptor, nowIso: string): Promise<void>;
  // Upsert a raw record; resolves true when the payload changed (content_hash
  // differs from the stored one), so the engine can skip re-normalizing no-ops.
  upsertRaw(
    sourceId: string,
    entityKind: string,
    externalId: string,
    apiVersion: string | null,
    contentHash: string | null,
    fetchedAt: string,
    payloadJson: string,
  ): Promise<boolean>;
  // Upsert a canonical item and resolve its item_id. Re-seeing an item clears
  // any soft-delete tombstone (deleted_at -> NULL).
  upsertItem(item: CanonicalItem, normalizerVersion: string, seenAt: string): Promise<number>;
  replaceLabels(itemId: number, labels: CanonicalLabel[]): Promise<void>;
  upsertEdge(e: ReconciledEdge, nowIso: string): Promise<void>;
  upsertActivity(a: CanonicalActivity, nowIso: string): Promise<void>;
  upsertReviewThread(thread: CanonicalReviewThread, nowIso: string): Promise<void>;
  // Open a run row (status starts 'partial' so a crash mid-run never enables a
  // soft-delete sweep). Resolves the run_id.
  startRun(sourceId: string, mode: "full" | "incremental", startedAt: string): Promise<number>;
  finishRun(
    runId: number,
    status: "ok" | "partial" | "error",
    finishedAt: string,
    itemsSeen: number,
    edgesSeen: number,
    activitiesSeen: number,
    graphqlRequests: number | null,
    graphqlCost: number | null,
    graphqlCostUnknown: number | null,
    error: string | null,
  ): Promise<void>;
  updateSyncState(
    sourceId: string,
    watermark: string | null,
    status: "ok" | "partial" | "error",
    error: string | null,
    nowIso: string,
  ): Promise<void>;
  // The disappearance rule: tombstone live items of `sourceId` not observed
  // since `cutoff`. CALLER MUST gate this on a full + complete run (never on a
  // partial fetch). Resolves the number of items tombstoned.
  softDeleteUnseenItems(sourceId: string, cutoff: string, nowIso: string): Promise<number>;
  // Disappearance rule for edges, scoped to intra-source edges (both endpoints
  // in `sourceId`) — a single-source sweep cannot confirm a cross-source edge
  // disappeared. CALLER MUST gate this on a full + complete run.
  softDeleteUnseenEdges(sourceId: string, cutoff: string, nowIso: string): Promise<number>;
  // Same disappearance rule for review-thread detail rows: only a full +
  // complete source sweep may tombstone threads that were not observed.
  softDeleteUnseenReviewThreads(sourceId: string, cutoff: string, nowIso: string): Promise<number>;

  // -- read paths --
  // Prior incremental watermark for a source (max updated_at seen), or null.
  getWatermark(sourceId: string): Promise<string | null>;
  // Live items ordered by most-recent resolution: COALESCE(closed_at,
  // merged_at, updated_at, created_at) DESC. merged_at MUST participate —
  // GitLab carries merged_at (not closed_at) for a merged MR.
  listLiveItems(): Promise<ItemRow[]>;
  // Bounded Graph focus reads. Callers batch the current BFS frontier by
  // source; drivers must keep these predicates on indexed immutable refs and
  // enforce the supplied edge limit in SQL.
  listLiveItemsBySourceRefs(sourceId: string, externalIds: string[]): Promise<ItemRow[]>;
  listLabelsByItemIds(itemIds: number[]): Promise<LabelRow[]>;
  listLiveEdgesForSourceRefs(sourceId: string, externalIds: string[], limit: number): Promise<EdgeRow[]>;
  // Run related reads against one database snapshot. SQLite holds one deferred
  // read transaction; Postgres uses REPEATABLE READ READ ONLY.
  readSnapshot<T>(fn: (snapshot: Store) => Promise<T>): Promise<T>;
  // Change requests worth a CI re-check: unresolved ci_state first, then open,
  // then recently resolved (>= cutoff), ordered by resolution recency.
  listCiRefreshCandidates(sourceId: string, cutoffIso: string, limit: number): Promise<CiRefreshCandidateRow[]>;
  // Activities ordered newest-first BY INSTANT: occurred_at preserves the
  // provider's original UTC offset (GitLab emits +08:00 and friends), so a
  // driver must order by the parsed instant, not by string comparison.
  listActivities(): Promise<ActivityRow[]>;
  // Activities whose occurred_at INSTANT is within [fromIso, toIso] inclusive,
  // newest-first by instant. Bounded at the SQL layer so a range request does
  // not read the whole activity table (the /api/range hot path). Membership is
  // by parsed instant, identical to a JS `from <= t <= to` filter — NOT by raw
  // text, which is offset-sensitive. See src/db/activity-range.ts.
  listActivitiesInRange(fromIso: string, toIso: string): Promise<ActivityRow[]>;
  listLiveReviewThreads(): Promise<ReviewThreadRow[]>;
  // Cached all-time per-repo activity bounds (earliest/latest occurred_at
  // INSTANT), independent of any range window. The /api/range path uses these
  // for documented all-time data_quality coverage (observed_since /
  // last_activity_at / activity_available) while its response activity list
  // stays range-bounded — so a repo with history but no in-range events still
  // reports its true coverage. Bounds are maintained on writes and read without
  // scanning the full activity table. Bounds are by parsed instant, not raw text
  // (offset-sensitive). One row per repo with at least one parseable activity.
  listRepoActivityBounds(): Promise<RepoActivityBoundsRow[]>;
  listLabels(): Promise<LabelRow[]>;
  listLiveEdges(): Promise<EdgeRow[]>;
  listSources(): Promise<SourceRow[]>;

  // -- writer lease --
  // Try-acquire the store's single-sync-writer lease: "exactly one sync writer
  // per store" enforced by the database, not by deployment topology.
  // Non-blocking: resolves false when another live handle (any process) holds
  // it — the caller skips its run rather than waiting. Idempotent on the
  // holding handle. Released by releaseWriterLease() or close(); a holder that
  // dies without either is freed by the engine/OS (session/file locking) —
  // there is deliberately no TTL or heartbeat.
  acquireWriterLease(): Promise<boolean>;
  // Release a held lease; a no-op when this handle does not hold it.
  releaseWriterLease(): Promise<void>;

  // -- operational surface --
  overview(runsLimit: number): Promise<StoreOverview>;
  diagnostics(): Promise<StoreDiagnostics>;

  // -- lifecycle --
  // Run `fn` atomically: commit on resolve, roll back on reject (the rejection
  // propagates). Drivers serialize concurrent transactions; nesting is invalid.
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Opener signature shared by drivers and injectable into the sync runner.
export type StoreOpener = (path: string) => Promise<Store>;
