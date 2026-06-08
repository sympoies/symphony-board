// Persistence operations over the canonical store. All writes use positional
// (?) parameters; node:sqlite forbids undefined and has no boolean type, so
// values are coerced via nz()/bint() before binding.

import type { DatabaseSync } from "node:sqlite";
import type { CanonicalActivity, CanonicalItem, CanonicalLabel } from "../model/types.ts";
import type { ReconciledEdge } from "../model/edges.ts";
import type { SourceDescriptor } from "../sources/types.ts";

const nz = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);
const bint = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0);

// ---- write paths ----------------------------------------------------------

export function ensureSource(db: DatabaseSync, d: SourceDescriptor, nowIso: string): void {
  db.prepare(
    `INSERT INTO source (source_id, kind, host, display_name, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(source_id) DO UPDATE SET
       kind=excluded.kind, host=excluded.host, display_name=excluded.display_name`,
  ).run(d.sourceId, d.kind, d.host, nz(d.displayName), nowIso);
}

// Upsert a raw record; returns true when the payload changed (content_hash
// differs from the stored one), so the engine can skip re-normalizing no-ops.
export function upsertRaw(
  db: DatabaseSync,
  sourceId: string,
  entityKind: string,
  externalId: string,
  apiVersion: string | null,
  contentHash: string | null,
  fetchedAt: string,
  payloadJson: string,
): boolean {
  const prev = db
    .prepare(`SELECT content_hash FROM raw WHERE source_id=? AND external_id=?`)
    .get(sourceId, externalId) as { content_hash: string | null } | undefined;
  db.prepare(
    `INSERT INTO raw (source_id, entity_kind, external_id, api_version, content_hash, fetched_at, payload)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(source_id, external_id) DO UPDATE SET
       entity_kind=excluded.entity_kind, api_version=excluded.api_version,
       content_hash=excluded.content_hash, fetched_at=excluded.fetched_at, payload=excluded.payload`,
  ).run(sourceId, entityKind, externalId, nz(apiVersion), nz(contentHash), fetchedAt, payloadJson);
  return prev?.content_hash !== contentHash;
}

// Upsert a canonical item and return its item_id. Re-seeing an item clears any
// soft-delete tombstone (deleted_at -> NULL).
export function upsertItem(
  db: DatabaseSync,
  item: CanonicalItem,
  normalizerVersion: string,
  seenAt: string,
): number {
  db.prepare(
    `INSERT INTO item (
       source_id, external_id, kind, project_path, iid, url, title, state, state_raw,
       state_reason, is_draft, author, created_at, updated_at, closed_at, merged_at,
       review_state, ci_state, merge_state, milestone, demand, normalized_with,
       last_seen_at, deleted_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(source_id, external_id) DO UPDATE SET
       kind=excluded.kind, project_path=excluded.project_path, iid=excluded.iid,
       url=excluded.url, title=excluded.title, state=excluded.state, state_raw=excluded.state_raw,
       state_reason=excluded.state_reason, is_draft=excluded.is_draft, author=excluded.author,
       created_at=excluded.created_at, updated_at=excluded.updated_at, closed_at=excluded.closed_at,
       merged_at=excluded.merged_at, review_state=excluded.review_state, ci_state=excluded.ci_state,
       merge_state=excluded.merge_state, milestone=excluded.milestone, demand=excluded.demand,
       normalized_with=excluded.normalized_with, last_seen_at=excluded.last_seen_at, deleted_at=NULL`,
  ).run(
    item.sourceId, item.externalId, item.kind, nz(item.projectPath), nz(item.iid), item.url,
    nz(item.title), item.state, nz(item.stateRaw), nz(item.stateReason), bint(item.isDraft),
    nz(item.author), nz(item.createdAt), nz(item.updatedAt), nz(item.closedAt), nz(item.mergedAt),
    nz(item.reviewState), nz(item.ciState), nz(item.mergeState), nz(item.milestone), nz(item.demand),
    normalizerVersion, seenAt,
  );
  const row = db
    .prepare(`SELECT item_id FROM item WHERE source_id=? AND external_id=?`)
    .get(item.sourceId, item.externalId) as { item_id: number };
  return row.item_id;
}

export function replaceLabels(db: DatabaseSync, itemId: number, labels: CanonicalLabel[]): void {
  db.prepare(`DELETE FROM item_label WHERE item_id=?`).run(itemId);
  const ins = db.prepare(`INSERT OR IGNORE INTO item_label (item_id, name, scope, color) VALUES (?,?,?,?)`);
  for (const l of labels) ins.run(itemId, l.name, nz(l.scope), nz(l.color));
}

export function upsertEdge(db: DatabaseSync, e: ReconciledEdge, nowIso: string): void {
  db.prepare(
    `INSERT INTO edge (
       type, from_source_id, from_external_id, to_source_id, to_external_id,
       from_state, to_state, lifecycle, discovered_from, first_seen_at, last_seen_at, deleted_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(type, from_source_id, from_external_id, to_source_id, to_external_id) DO UPDATE SET
       from_state=excluded.from_state, to_state=excluded.to_state, lifecycle=excluded.lifecycle,
       discovered_from=excluded.discovered_from, last_seen_at=excluded.last_seen_at, deleted_at=NULL`,
  ).run(
    e.type, e.from.sourceId, e.from.externalId, e.to.sourceId, e.to.externalId,
    nz(e.fromState), nz(e.toState), nz(e.lifecycle), e.discoveredFrom, nowIso, nowIso,
  );
}

export function upsertActivity(db: DatabaseSync, a: CanonicalActivity, nowIso: string): void {
  const details = a.details === null ? null : JSON.stringify(a.details);
  db.prepare(
    `INSERT INTO activity (
       source_id, external_id, kind, action, project_path, target_kind,
       target_source_id, target_external_id, target_iid, title, url, actor,
       occurred_at, summary, details, first_seen_at, last_seen_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source_id, external_id) DO UPDATE SET
       kind=excluded.kind, action=excluded.action, project_path=excluded.project_path,
       target_kind=excluded.target_kind, target_source_id=excluded.target_source_id,
       target_external_id=excluded.target_external_id, target_iid=excluded.target_iid,
       title=excluded.title, url=excluded.url, actor=excluded.actor,
       occurred_at=excluded.occurred_at, summary=excluded.summary,
       details=excluded.details, last_seen_at=excluded.last_seen_at`,
  ).run(
    a.sourceId,
    a.externalId,
    a.kind,
    a.action,
    nz(a.projectPath),
    nz(a.targetKind),
    nz(a.target?.sourceId),
    nz(a.target?.externalId),
    nz(a.targetIid),
    nz(a.title),
    nz(a.url),
    nz(a.actor),
    a.occurredAt,
    nz(a.summary),
    details,
    nowIso,
    nowIso,
  );
}

// ---- run bookkeeping & disappearance handling -----------------------------

// Open a run row (status defaults to 'partial' so a crash mid-run never enables
// a soft-delete sweep). Returns the run_id.
export function startRun(db: DatabaseSync, sourceId: string, mode: "full" | "incremental", startedAt: string): number {
  const r = db
    .prepare(`INSERT INTO sync_run (source_id, mode, status, started_at) VALUES (?,?, 'partial', ?)`)
    .run(sourceId, mode, startedAt);
  return Number(r.lastInsertRowid);
}

export function finishRun(
  db: DatabaseSync,
  runId: number,
  status: "ok" | "partial" | "error",
  finishedAt: string,
  itemsSeen: number,
  edgesSeen: number,
  activitiesSeen: number,
  error: string | null,
): void {
  db.prepare(
    `UPDATE sync_run SET status=?, finished_at=?, items_seen=?, edges_seen=?, activities_seen=?, error=? WHERE run_id=?`,
  ).run(status, finishedAt, itemsSeen, edgesSeen, activitiesSeen, nz(error), runId);
}

export function updateSyncState(
  db: DatabaseSync,
  sourceId: string,
  watermark: string | null,
  status: "ok" | "partial" | "error",
  error: string | null,
  nowIso: string,
): void {
  const lastSuccess = status === "ok" ? nowIso : null;
  db.prepare(
    `INSERT INTO sync_state (source_id, watermark, last_run_at, last_success_at, last_status, last_error)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(source_id) DO UPDATE SET
       watermark=COALESCE(excluded.watermark, sync_state.watermark),
       last_run_at=excluded.last_run_at,
       last_success_at=COALESCE(excluded.last_success_at, sync_state.last_success_at),
       last_status=excluded.last_status, last_error=excluded.last_error`,
  ).run(sourceId, nz(watermark), nowIso, nz(lastSuccess), status, nz(error));
}

// The disappearance rule: tombstone live items of `sourceId` not observed since
// `cutoff`. CALLER MUST gate this on a full + complete run (never on a partial
// fetch). Returns the number of items tombstoned.
export function softDeleteUnseenItems(db: DatabaseSync, sourceId: string, cutoff: string, nowIso: string): number {
  const r = db
    .prepare(`UPDATE item SET deleted_at=? WHERE source_id=? AND deleted_at IS NULL AND last_seen_at < ?`)
    .run(nowIso, sourceId, cutoff);
  return Number(r.changes);
}

// The disappearance rule for edges, symmetric to items: tombstone live edges not
// re-seen this run. An edge is re-seen when either endpoint still asserts it, so
// it is only safe to tombstone when the sweep that would re-discover it was a
// full + complete sweep of BOTH its endpoints' sources. We scope to edges whose
// `from` AND `to` are in `sourceId` (intra-source) — the only edges the current
// normalizers produce, and the only ones a single-source sweep can fully
// confirm. A cross-source edge (an endpoint in an untracked/other source) is
// left untouched: we cannot prove the other side stopped asserting it. CALLER
// MUST gate this on a full + complete run. Returns the number tombstoned.
export function softDeleteUnseenEdges(db: DatabaseSync, sourceId: string, cutoff: string, nowIso: string): number {
  const r = db
    .prepare(
      `UPDATE edge SET deleted_at=?
       WHERE from_source_id=? AND to_source_id=? AND deleted_at IS NULL AND last_seen_at < ?`,
    )
    .run(nowIso, sourceId, sourceId, cutoff);
  return Number(r.changes);
}

// Prior incremental watermark for a source (max updated_at seen), or null.
export function getWatermark(db: DatabaseSync, sourceId: string): string | null {
  const row = db.prepare(`SELECT watermark FROM sync_state WHERE source_id=?`).get(sourceId) as
    | { watermark: string | null }
    | undefined;
  return row?.watermark ?? null;
}

// ---- read paths (for contract emission) -----------------------------------

export interface ItemRow {
  item_id: number;
  source_id: string;
  external_id: string;
  kind: string;
  project_path: string | null;
  iid: number | null;
  url: string | null;
  title: string | null;
  state: string;
  state_raw: string | null;
  state_reason: string | null;
  is_draft: number | null;
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  review_state: string | null;
  ci_state: string | null;
  merge_state: string | null;
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
  occurred_at: string;
  summary: string | null;
  details: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
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

export function listLiveItems(db: DatabaseSync): ItemRow[] {
  return db
    .prepare(
      `SELECT item_id, source_id, external_id, kind, project_path, iid, url, title, state,
              state_raw, state_reason, is_draft, author, created_at, updated_at, closed_at,
              merged_at, review_state, ci_state, merge_state, milestone, demand, last_seen_at
       FROM item WHERE deleted_at IS NULL
       -- Order by a provider-agnostic "most recently resolved" key: a closed item
       -- by closed_at, a merged item by merged_at, an open item by updated_at
       -- (created_at as a last resort). merged_at MUST be in the COALESCE: GitLab
       -- carries merged_at (NOT closed_at) for a merged MR, so keying on closed_at
       -- alone — or floating closed_at-IS-NULL rows to the top — would scatter every
       -- GitLab merged MR ahead of dated items in the board's Closed/Trailing
       -- columns (the UI partitions this order without re-sorting).
       ORDER BY COALESCE(closed_at, merged_at, updated_at, created_at) DESC, item_id DESC`,
    )
    .all() as unknown as ItemRow[];
}

export function listCiRefreshCandidates(
  db: DatabaseSync,
  sourceId: string,
  cutoffIso: string,
  limit: number,
): CiRefreshCandidateRow[] {
  const safeLimit = Math.max(0, Math.trunc(Number.isFinite(limit) ? limit : 0));
  if (safeLimit === 0) return [];
  return db
    .prepare(
      `SELECT source_id, external_id, project_path, iid, state, ci_state,
              updated_at, closed_at, merged_at, last_seen_at
       FROM item
       WHERE deleted_at IS NULL
         AND source_id=?
         AND kind='change_request'
         AND project_path IS NOT NULL
         AND iid IS NOT NULL
         AND (
           state='open'
           OR COALESCE(merged_at, closed_at, updated_at, created_at) >= ?
         )
       ORDER BY
         CASE
           WHEN ci_state IN ('pending', 'none') THEN 0
           WHEN state='open' THEN 1
           ELSE 2
         END,
         julianday(COALESCE(merged_at, closed_at, updated_at, created_at)) DESC,
         item_id DESC
       LIMIT ?`,
    )
    .all(sourceId, cutoffIso, safeLimit) as unknown as CiRefreshCandidateRow[];
}

export function listActivities(db: DatabaseSync): ActivityRow[] {
  return db
    .prepare(
      `SELECT source_id, external_id, kind, action, project_path, target_kind,
              target_source_id, target_external_id, target_iid, title, url, actor,
              occurred_at, summary, details, first_seen_at, last_seen_at
       FROM activity
       ORDER BY julianday(occurred_at) DESC, activity_id DESC`,
    )
    .all() as unknown as ActivityRow[];
}

export function listLabels(db: DatabaseSync): LabelRow[] {
  return db
    .prepare(`SELECT item_id, name, scope, color FROM item_label`)
    .all() as unknown as LabelRow[];
}

export function listLiveEdges(db: DatabaseSync): EdgeRow[] {
  return db
    .prepare(
      `SELECT type, from_source_id, from_external_id, to_source_id, to_external_id,
              from_state, to_state, lifecycle
       FROM edge WHERE deleted_at IS NULL`,
    )
    .all() as unknown as EdgeRow[];
}

export function listSources(db: DatabaseSync): SourceRow[] {
  return db
    .prepare(
      `SELECT s.source_id, s.kind, s.host, s.display_name,
              ss.last_success_at AS last_success_at, ss.last_status AS last_status
       FROM source s LEFT JOIN sync_state ss ON ss.source_id = s.source_id
       ORDER BY s.source_id`,
    )
    .all() as unknown as SourceRow[];
}
