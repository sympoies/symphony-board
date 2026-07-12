// SQLite driver for the Store interface, on Node's built-in node:sqlite
// (DatabaseSync). No native build step, no external dependency — it ships with
// Node 24, matching the project's "pin Node, no build" stance. node:sqlite is
// still flagged experimental; runs silence the warning with
// --disable-warning=ExperimentalWarning.
//
// Driver-owned facts (see src/db/store.ts for the interface contract):
// - DDL lives in schema/sqlite/*.sql (the human-readable, normative artifact)
//   and is applied verbatim; migrations are tracked with PRAGMA user_version.
// - node:sqlite is synchronous, so every method resolves immediately; the
//   async signatures exist for driver parity, not concurrency.
// - All writes use positional (?) parameters; node:sqlite forbids undefined
//   and has no boolean type, so values are coerced via nz()/bint() before
//   binding and is_draft is mapped back to boolean on read.
// - julianday() orders activities by instant: occurred_at preserves the
//   provider's original UTC offset, so string order is not instant order.
// - The writer lease is a sibling lock database (`<path>-lease`) held under
//   BEGIN EXCLUSIVE on a dedicated connection. SQLite's file locking makes the
//   lease cross-process (and container/host across a bind mount), and the OS
//   frees it when the holder dies — the same auto-release-on-death semantics a
//   Postgres session advisory lock provides. A `:memory:` store is private to
//   its handle (no second handle can exist), so the lease is trivially granted.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { CanonicalActivity, CanonicalItem, CanonicalLabel, CanonicalReviewThread } from "../model/types.ts";
import type { ReconciledEdge } from "../model/edges.ts";
import type { SourceDescriptor } from "../sources/types.ts";
import { activityRangeBounds } from "./activity-range.ts";
import {
  repoActivityBoundsBucket,
  repoActivityBoundsBucketId,
  type RepoActivityBoundsBucket,
} from "./repo-activity-bounds.ts";
import type {
  ActivityRow,
  RepoActivityBoundsRow,
  CiRefreshCandidateRow,
  EdgeRow,
  ItemRow,
  LabelRow,
  ReviewThreadRow,
  SourceRow,
  Store,
  StoreDiagnostics,
  StoreOverview,
  StoreSyncRunRow,
} from "./store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, "..", "..", "schema", "sqlite");

interface Migration {
  version: number;
  file: string;
}

// Ordered list of migrations. Append future ones; never edit an applied file
// (write a new migration that rebuilds the affected table).
const MIGRATIONS: Migration[] = [
  { version: 1, file: "0001_init.sql" },
  { version: 2, file: "0002_activity.sql" },
  { version: 3, file: "0003_actor_identity.sql" },
  { version: 4, file: "0004_review_threads.sql" },
  { version: 5, file: "0005_repo_activity_bounds.sql" },
  { version: 6, file: "0006_review_thread_detail.sql" },
  { version: 7, file: "0007_review_thread_target_iid_bigint.sql" },
  { version: 8, file: "0008_review_thread_last_comment_at.sql" },
  { version: 9, file: "0009_item_body.sql" },
  { version: 10, file: "0010_item_comment_total.sql" },
  { version: 11, file: "0011_sync_run_graphql_requests.sql" },
  { version: 12, file: "0012_sync_run_graphql_cost.sql" },
];
const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

const nz = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);
const bint = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0);

// SQLITE_BUSY (5) / SQLITE_LOCKED (6): another connection holds the lock. The
// message check covers node:sqlite versions that don't expose errcode.
function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string };
  return e.errcode === 5 || e.errcode === 6 || /database is locked/i.test(e.message ?? "");
}

// Open the store read-write, creating and migrating it as needed.
export async function openSqliteStore(path: string): Promise<Store> {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // WAL lets the UI sidecar and read-only inspection helpers read while the
  // single sync daemon writes.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return new SqliteStore(db, path);
}

// Open the store read-only. Never migrates: an older-than-expected schema is an
// error (the writer owns migrations), and writes through the handle fail.
export async function openSqliteStoreReadOnly(path: string): Promise<Store> {
  const db = new DatabaseSync(readOnlyLocation(path));
  db.exec("PRAGMA query_only = ON;");
  db.exec("PRAGMA foreign_keys = ON;");
  const have = currentVersion(db);
  if (have < CURRENT_SCHEMA_VERSION) {
    db.close();
    throw new Error(`database schema version ${have} is older than expected ${CURRENT_SCHEMA_VERSION}`);
  }
  return new SqliteStore(db, path);
}

function readOnlyLocation(path: string): string {
  if (path === ":memory:") return path;
  const url = pathToFileURL(resolve(path));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: DatabaseSync): void {
  const have = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= have) continue;
    const ddl = readFileSync(resolve(SCHEMA_DIR, m.file), "utf8");
    applyMigration(db, m, ddl);
  }
}

function applyMigration(db: DatabaseSync, m: Migration, ddl: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!migrationAlreadyApplied(db, m)) {
      db.exec(ddl);
    }
    // user_version takes an integer literal; m.version is a trusted constant.
    db.exec(`PRAGMA user_version = ${m.version}`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // If SQLite already rolled the transaction back, preserve the original
      // migration failure.
    }
    throw err;
  }
}

function migrationAlreadyApplied(db: DatabaseSync, m: Migration): boolean {
  if (m.version === 9) return sqliteColumnExists(db, "item", "body");
  if (m.version === 11) return sqliteColumnExists(db, "sync_run", "graphql_requests");
  if (m.version === 12) return sqliteColumnExists(db, "sync_run", "graphql_cost") && sqliteColumnExists(db, "sync_run", "graphql_cost_unknown");
  return false;
}

function sqliteColumnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #path: string;
  // Serializes transaction() calls: the engine architecture is single-writer,
  // but an async transaction body must never interleave with another BEGIN.
  #txQueue: Promise<unknown> = Promise.resolve();
  #inTransaction = false;
  #repoActivityBoundsDirty = new Map<string, RepoActivityBoundsBucket>();
  // The dedicated lock-database connection while this handle holds the writer
  // lease; null when not held.
  #lease: DatabaseSync | null = null;

  constructor(db: DatabaseSync, path: string) {
    this.#db = db;
    this.#path = path;
  }

  // ---- write paths ---------------------------------------------------------

  async ensureSource(d: SourceDescriptor, nowIso: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO source (source_id, kind, host, display_name, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(source_id) DO UPDATE SET
           kind=excluded.kind, host=excluded.host, display_name=excluded.display_name`,
      )
      .run(d.sourceId, d.kind, d.host, nz(d.displayName), nowIso);
  }

  async upsertRaw(
    sourceId: string,
    entityKind: string,
    externalId: string,
    apiVersion: string | null,
    contentHash: string | null,
    fetchedAt: string,
    payloadJson: string,
  ): Promise<boolean> {
    const prev = this.#db
      .prepare(`SELECT content_hash FROM raw WHERE source_id=? AND external_id=?`)
      .get(sourceId, externalId) as { content_hash: string | null } | undefined;
    this.#db
      .prepare(
        `INSERT INTO raw (source_id, entity_kind, external_id, api_version, content_hash, fetched_at, payload)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
           entity_kind=excluded.entity_kind, api_version=excluded.api_version,
           content_hash=excluded.content_hash, fetched_at=excluded.fetched_at, payload=excluded.payload`,
      )
      .run(sourceId, entityKind, externalId, nz(apiVersion), nz(contentHash), fetchedAt, payloadJson);
    return prev?.content_hash !== contentHash;
  }

  async upsertItem(item: CanonicalItem, normalizerVersion: string, seenAt: string): Promise<number> {
    const row = this.#db
      .prepare(
        `INSERT INTO item (
           source_id, external_id, kind, project_path, iid, url, title, body, state, state_raw,
           state_reason, is_draft, author, created_at, updated_at, closed_at, merged_at,
           review_state, ci_state, merge_state, open_review_threads, total_review_threads,
           comment_total, milestone, demand, normalized_with,
           last_seen_at, deleted_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
           kind=excluded.kind, project_path=excluded.project_path, iid=excluded.iid,
           url=excluded.url, title=excluded.title, body=excluded.body, state=excluded.state, state_raw=excluded.state_raw,
           state_reason=excluded.state_reason, is_draft=excluded.is_draft, author=excluded.author,
           created_at=excluded.created_at, updated_at=excluded.updated_at, closed_at=excluded.closed_at,
           merged_at=excluded.merged_at, review_state=excluded.review_state, ci_state=excluded.ci_state,
           merge_state=excluded.merge_state, open_review_threads=excluded.open_review_threads,
           total_review_threads=excluded.total_review_threads, comment_total=excluded.comment_total,
           milestone=excluded.milestone, demand=excluded.demand,
           normalized_with=excluded.normalized_with, last_seen_at=excluded.last_seen_at, deleted_at=NULL
         RETURNING item_id`,
      )
      .get(
        item.sourceId, item.externalId, item.kind, nz(item.projectPath), nz(item.iid), item.url,
        nz(item.title), nz(item.body), item.state, nz(item.stateRaw), nz(item.stateReason), bint(item.isDraft),
        nz(item.author), nz(item.createdAt), nz(item.updatedAt), nz(item.closedAt), nz(item.mergedAt),
        nz(item.reviewState), nz(item.ciState), nz(item.mergeState), nz(item.openReviewThreads),
        nz(item.totalReviewThreads), nz(item.commentTotal), nz(item.milestone), nz(item.demand),
        normalizerVersion, seenAt,
      ) as { item_id: number };
    return row.item_id;
  }

  async replaceLabels(itemId: number, labels: CanonicalLabel[]): Promise<void> {
    this.#db.prepare(`DELETE FROM item_label WHERE item_id=?`).run(itemId);
    const ins = this.#db.prepare(
      `INSERT INTO item_label (item_id, name, scope, color) VALUES (?,?,?,?)
       ON CONFLICT(item_id, name) DO NOTHING`,
    );
    for (const l of labels) ins.run(itemId, l.name, nz(l.scope), nz(l.color));
  }

  async upsertEdge(e: ReconciledEdge, nowIso: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO edge (
           type, from_source_id, from_external_id, to_source_id, to_external_id,
           from_state, to_state, lifecycle, discovered_from, first_seen_at, last_seen_at, deleted_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(type, from_source_id, from_external_id, to_source_id, to_external_id) DO UPDATE SET
           from_state=excluded.from_state, to_state=excluded.to_state, lifecycle=excluded.lifecycle,
           discovered_from=excluded.discovered_from, last_seen_at=excluded.last_seen_at, deleted_at=NULL`,
      )
      .run(
        e.type, e.from.sourceId, e.from.externalId, e.to.sourceId, e.to.externalId,
        nz(e.fromState), nz(e.toState), nz(e.lifecycle), e.discoveredFrom, nowIso, nowIso,
      );
  }

  async upsertActivity(a: CanonicalActivity, nowIso: string): Promise<void> {
    const details = a.details === null ? null : JSON.stringify(a.details);
    const projectPath = nz(a.projectPath);
    const prev = this.#db
      .prepare(`SELECT project_path FROM activity WHERE source_id=? AND external_id=?`)
      .get(a.sourceId, a.externalId) as { project_path: string | null } | undefined;
    this.#db
      .prepare(
        `INSERT INTO activity (
           source_id, external_id, kind, action, project_path, target_kind,
           target_source_id, target_external_id, target_iid, title, url, actor,
           actor_key, occurred_at, summary, details, first_seen_at, last_seen_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
           kind=excluded.kind, action=excluded.action, project_path=excluded.project_path,
           target_kind=excluded.target_kind, target_source_id=excluded.target_source_id,
           target_external_id=excluded.target_external_id, target_iid=excluded.target_iid,
           title=excluded.title, url=excluded.url, actor=excluded.actor,
           actor_key=excluded.actor_key,
           occurred_at=excluded.occurred_at, summary=excluded.summary,
           details=excluded.details, last_seen_at=excluded.last_seen_at`,
      )
      .run(
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
        nz(a.actorKey),
        a.occurredAt,
        nz(a.summary),
        details,
        nowIso,
        nowIso,
      );
    this.#markRepoActivityBoundsDirty(a.sourceId, projectPath, nowIso);
    if (prev !== undefined && prev.project_path !== projectPath) {
      this.#markRepoActivityBoundsDirty(a.sourceId, prev.project_path, nowIso);
    }
    if (!this.#inTransaction) this.#flushRepoActivityBoundsDirty();
  }

  async upsertReviewThread(thread: CanonicalReviewThread, nowIso: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO review_thread (
           source_id, external_id, project_path, target_source_id, target_external_id,
           target_iid, title, url, is_resolved, is_outdated, resolved_by, path,
           line, start_line, comments_total, comments_json, last_comment_at, last_seen_at, deleted_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
           project_path=excluded.project_path,
           target_source_id=excluded.target_source_id,
           target_external_id=excluded.target_external_id,
           target_iid=excluded.target_iid,
           title=excluded.title,
           url=excluded.url,
           is_resolved=excluded.is_resolved,
           is_outdated=excluded.is_outdated,
           resolved_by=excluded.resolved_by,
           path=excluded.path,
           line=excluded.line,
           start_line=excluded.start_line,
           comments_total=excluded.comments_total,
           comments_json=excluded.comments_json,
           last_comment_at=excluded.last_comment_at,
           last_seen_at=excluded.last_seen_at,
           deleted_at=NULL`,
      )
      .run(
        thread.sourceId,
        thread.externalId,
        nz(thread.projectPath),
        thread.target.sourceId,
        thread.target.externalId,
        nz(thread.targetIid),
        nz(thread.title),
        nz(thread.url),
        bint(thread.isResolved),
        bint(thread.isOutdated),
        nz(thread.resolvedBy),
        nz(thread.path),
        nz(thread.line),
        nz(thread.startLine),
        thread.commentsTotal,
        JSON.stringify(thread.comments),
        nz(thread.lastCommentAt),
        nowIso,
      );
  }

  #markRepoActivityBoundsDirty(sourceId: string, projectPath: string | null, updatedAt: string): void {
    const bucket = repoActivityBoundsBucket(sourceId, projectPath, updatedAt);
    this.#repoActivityBoundsDirty.set(repoActivityBoundsBucketId(sourceId, bucket.projectKey), bucket);
  }

  #flushRepoActivityBoundsDirty(): void {
    const buckets = [...this.#repoActivityBoundsDirty.values()];
    this.#repoActivityBoundsDirty.clear();
    for (const bucket of buckets) this.#refreshRepoActivityBounds(bucket);
  }

  #refreshRepoActivityBounds(bucket: RepoActivityBoundsBucket): void {
    const row = this.#db
      .prepare(
        `SELECT observed_since, last_activity_at
         FROM (
           SELECT
             FIRST_VALUE(occurred_at) OVER (
               ORDER BY julianday(occurred_at) ASC, activity_id ASC
             ) AS observed_since,
             FIRST_VALUE(occurred_at) OVER (
               ORDER BY julianday(occurred_at) DESC, activity_id DESC
             ) AS last_activity_at
           FROM activity
           WHERE source_id = ?
             AND project_path IS ?
             AND julianday(occurred_at) IS NOT NULL
         )
         LIMIT 1`,
      )
      .get(bucket.sourceId, bucket.projectPath) as { observed_since: string | null; last_activity_at: string | null } | undefined;

    if (!row) {
      this.#db
        .prepare(`DELETE FROM repo_activity_bounds WHERE source_id=? AND project_key=?`)
        .run(bucket.sourceId, bucket.projectKey);
      return;
    }

    this.#db
      .prepare(
        `INSERT INTO repo_activity_bounds (
           source_id, project_path, project_key, observed_since, last_activity_at, updated_at
         ) VALUES (?,?,?,?,?,?)
         ON CONFLICT(source_id, project_key) DO UPDATE SET
           project_path=excluded.project_path,
           observed_since=excluded.observed_since,
           last_activity_at=excluded.last_activity_at,
           updated_at=excluded.updated_at`,
      )
      .run(bucket.sourceId, bucket.projectPath, bucket.projectKey, row.observed_since, row.last_activity_at, bucket.updatedAt);
  }

  async startRun(sourceId: string, mode: "full" | "incremental", startedAt: string): Promise<number> {
    const row = this.#db
      .prepare(`INSERT INTO sync_run (source_id, mode, status, started_at) VALUES (?,?, 'partial', ?) RETURNING run_id`)
      .get(sourceId, mode, startedAt) as { run_id: number };
    return row.run_id;
  }

  async finishRun(
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
  ): Promise<void> {
    this.#db
      .prepare(
        `UPDATE sync_run SET status=?, finished_at=?, items_seen=?, edges_seen=?, activities_seen=?,
           graphql_requests=?, graphql_cost=?, graphql_cost_unknown=?, error=? WHERE run_id=?`,
      )
      .run(status, finishedAt, itemsSeen, edgesSeen, activitiesSeen, nz(graphqlRequests), nz(graphqlCost), nz(graphqlCostUnknown), nz(error), runId);
  }

  async updateSyncState(
    sourceId: string,
    watermark: string | null,
    status: "ok" | "partial" | "error",
    error: string | null,
    nowIso: string,
  ): Promise<void> {
    const lastSuccess = status === "ok" ? nowIso : null;
    this.#db
      .prepare(
        `INSERT INTO sync_state (source_id, watermark, last_run_at, last_success_at, last_status, last_error)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(source_id) DO UPDATE SET
           watermark=COALESCE(excluded.watermark, sync_state.watermark),
           last_run_at=excluded.last_run_at,
           last_success_at=COALESCE(excluded.last_success_at, sync_state.last_success_at),
           last_status=excluded.last_status, last_error=excluded.last_error`,
      )
      .run(sourceId, nz(watermark), nowIso, nz(lastSuccess), status, nz(error));
  }

  async softDeleteUnseenItems(sourceId: string, cutoff: string, nowIso: string): Promise<number> {
    const r = this.#db
      .prepare(`UPDATE item SET deleted_at=? WHERE source_id=? AND deleted_at IS NULL AND last_seen_at < ?`)
      .run(nowIso, sourceId, cutoff);
    return Number(r.changes);
  }

  async softDeleteUnseenEdges(sourceId: string, cutoff: string, nowIso: string): Promise<number> {
    const r = this.#db
      .prepare(
        `UPDATE edge SET deleted_at=?
         WHERE from_source_id=? AND to_source_id=? AND deleted_at IS NULL AND last_seen_at < ?`,
      )
      .run(nowIso, sourceId, sourceId, cutoff);
    return Number(r.changes);
  }

  async softDeleteUnseenReviewThreads(sourceId: string, cutoff: string, nowIso: string): Promise<number> {
    const r = this.#db
      .prepare(`UPDATE review_thread SET deleted_at=? WHERE source_id=? AND deleted_at IS NULL AND last_seen_at < ?`)
      .run(nowIso, sourceId, cutoff);
    return Number(r.changes);
  }

  // ---- read paths ----------------------------------------------------------

  async getWatermark(sourceId: string): Promise<string | null> {
    const row = this.#db.prepare(`SELECT watermark FROM sync_state WHERE source_id=?`).get(sourceId) as
      | { watermark: string | null }
      | undefined;
    return row?.watermark ?? null;
  }

  async listLiveItems(): Promise<ItemRow[]> {
    const rows = this.#db
      .prepare(
        `SELECT item_id, source_id, external_id, kind, project_path, iid, url, title, body, state,
                state_raw, state_reason, is_draft, author, created_at, updated_at, closed_at,
                merged_at, review_state, ci_state, merge_state, open_review_threads,
                total_review_threads, comment_total, milestone, demand, last_seen_at
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
      .all() as unknown as Array<Omit<ItemRow, "is_draft"> & { is_draft: number | null }>;
    return rows.map((r) => ({ ...r, is_draft: r.is_draft === null ? null : r.is_draft !== 0 }));
  }

  async listLiveItemsBySourceRefs(sourceId: string, externalIds: string[]): Promise<ItemRow[]> {
    const refs = [...new Set(externalIds.filter(Boolean))].sort();
    if (refs.length === 0) return [];
    const placeholders = refs.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT item_id, source_id, external_id, kind, project_path, iid, url, title, NULL AS body, state,
                state_raw, state_reason, is_draft, author, created_at, updated_at, closed_at,
                merged_at, review_state, ci_state, merge_state, open_review_threads,
                total_review_threads, comment_total, milestone, demand, last_seen_at
         FROM item
         WHERE deleted_at IS NULL AND source_id=? AND external_id IN (${placeholders})
         ORDER BY external_id`,
      )
      .all(sourceId, ...refs) as unknown as Array<Omit<ItemRow, "is_draft"> & { is_draft: number | null }>;
    return rows.map((row) => ({ ...row, is_draft: row.is_draft === null ? null : row.is_draft !== 0 }));
  }

  async listLabelsByItemIds(itemIds: number[]): Promise<LabelRow[]> {
    const ids = [...new Set(itemIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.#db
      .prepare(`SELECT item_id, name, scope, color FROM item_label WHERE item_id IN (${placeholders}) ORDER BY item_id, name`)
      .all(...ids) as unknown as LabelRow[];
  }

  async listLiveEdgesForSourceRefs(sourceId: string, externalIds: string[], limit: number): Promise<EdgeRow[]> {
    const refs = [...new Set(externalIds.filter(Boolean))].sort();
    const safeLimit = Math.max(0, Math.trunc(Number.isFinite(limit) ? limit : 0));
    if (refs.length === 0 || safeLimit === 0) return [];
    const placeholders = refs.map(() => "?").join(", ");
    const select = `SELECT type, from_source_id, from_external_id, to_source_id, to_external_id,
                           from_state, to_state, lifecycle
                    FROM edge`;
    const from = this.#db
      .prepare(`${select} WHERE deleted_at IS NULL AND from_source_id=? AND from_external_id IN (${placeholders})
                ORDER BY from_external_id, to_source_id, to_external_id, type LIMIT ?`)
      .all(sourceId, ...refs, safeLimit) as unknown as EdgeRow[];
    const to = this.#db
      .prepare(`${select} WHERE deleted_at IS NULL AND to_source_id=? AND to_external_id IN (${placeholders})
                ORDER BY to_external_id, from_source_id, from_external_id, type LIMIT ?`)
      .all(sourceId, ...refs, safeLimit) as unknown as EdgeRow[];
    const byKey = new Map<string, EdgeRow>();
    for (const edge of [...from, ...to]) {
      byKey.set(JSON.stringify([edge.type, edge.from_source_id, edge.from_external_id, edge.to_source_id, edge.to_external_id]), edge);
    }
    return [...byKey.values()]
      .sort((a, b) => a.from_source_id.localeCompare(b.from_source_id) || a.from_external_id.localeCompare(b.from_external_id) || a.to_source_id.localeCompare(b.to_source_id) || a.to_external_id.localeCompare(b.to_external_id) || a.type.localeCompare(b.type))
      .slice(0, safeLimit);
  }

  async listCiRefreshCandidates(sourceId: string, cutoffIso: string, limit: number): Promise<CiRefreshCandidateRow[]> {
    const safeLimit = Math.max(0, Math.trunc(Number.isFinite(limit) ? limit : 0));
    if (safeLimit === 0) return [];
    return this.#db
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

  async listActivities(): Promise<ActivityRow[]> {
    return this.#db
      .prepare(
        `SELECT source_id, external_id, kind, action, project_path, target_kind,
                target_source_id, target_external_id, target_iid, title, url, actor,
                actor_key, occurred_at, summary, details, first_seen_at, last_seen_at
         FROM activity
         -- julianday, not string order: occurred_at keeps the provider's original
         -- UTC offset, so ordering must be by instant (see Store.listActivities).
         ORDER BY julianday(occurred_at) DESC, activity_id DESC`,
      )
      .all() as unknown as ActivityRow[];
  }

  async listActivitiesInRange(fromIso: string, toIso: string): Promise<ActivityRow[]> {
    const { coarseFrom, coarseTo, from, to } = activityRangeBounds(fromIso, toIso);
    return this.#db
      .prepare(
        `SELECT source_id, external_id, kind, action, project_path, target_kind,
                target_source_id, target_external_id, target_iid, title, url, actor,
                actor_key, occurred_at, summary, details, first_seen_at, last_seen_at
         FROM activity
         -- coarse text band first: a range scan on activity_by_time(occurred_at)
         -- avoids reading the whole table; then julianday() trims to the exact
         -- instant window (text alone is offset-sensitive). See activity-range.ts.
         WHERE occurred_at >= ? AND occurred_at <= ?
           AND julianday(occurred_at) >= julianday(?)
           AND julianday(occurred_at) <= julianday(?)
         ORDER BY julianday(occurred_at) DESC, activity_id DESC`,
      )
      .all(coarseFrom, coarseTo, from, to) as unknown as ActivityRow[];
  }

  async listLiveReviewThreads(): Promise<ReviewThreadRow[]> {
    const rows = this.#db
      .prepare(
        `SELECT source_id, external_id, project_path, target_source_id, target_external_id,
                target_iid, title, url, is_resolved, is_outdated, resolved_by, path,
                line, start_line, comments_total, comments_json, last_comment_at, last_seen_at
         FROM review_thread
         WHERE deleted_at IS NULL
         ORDER BY is_resolved ASC, source_id ASC, project_path ASC, target_iid DESC, path ASC, line ASC, external_id ASC`,
      )
      .all() as unknown as Array<Omit<ReviewThreadRow, "is_resolved" | "is_outdated"> & { is_resolved: number; is_outdated: number | null }>;
    return rows.map((r) => ({
      ...r,
      is_resolved: r.is_resolved !== 0,
      is_outdated: r.is_outdated === null ? null : r.is_outdated !== 0,
    }));
  }

  async listRepoActivityBounds(): Promise<RepoActivityBoundsRow[]> {
    return this.#db
      .prepare(
        `SELECT source_id, project_path, observed_since, last_activity_at
         FROM repo_activity_bounds
         ORDER BY source_id, project_key`,
      )
      .all() as unknown as RepoActivityBoundsRow[];
  }

  async listLabels(): Promise<LabelRow[]> {
    return this.#db
      .prepare(`SELECT item_id, name, scope, color FROM item_label`)
      .all() as unknown as LabelRow[];
  }

  async listLiveEdges(): Promise<EdgeRow[]> {
    return this.#db
      .prepare(
        `SELECT type, from_source_id, from_external_id, to_source_id, to_external_id,
                from_state, to_state, lifecycle
         FROM edge WHERE deleted_at IS NULL`,
      )
      .all() as unknown as EdgeRow[];
  }

  async listSources(): Promise<SourceRow[]> {
    return this.#db
      .prepare(
        `SELECT s.source_id, s.kind, s.host, s.display_name,
                ss.last_success_at AS last_success_at, ss.last_status AS last_status
         FROM source s LEFT JOIN sync_state ss ON ss.source_id = s.source_id
         ORDER BY s.source_id`,
      )
      .all() as unknown as SourceRow[];
  }

  // ---- writer lease ----------------------------------------------------------

  async acquireWriterLease(): Promise<boolean> {
    if (this.#path === ":memory:") return true;
    if (this.#lease) return true; // already held by this handle
    const lock = new DatabaseSync(`${this.#path}-lease`);
    try {
      // Fail fast instead of waiting: a refused lease means "skip this run".
      lock.exec("PRAGMA busy_timeout = 0;");
      lock.exec("BEGIN EXCLUSIVE");
    } catch (err) {
      lock.close();
      if (isBusy(err)) return false;
      throw err;
    }
    this.#lease = lock;
    return true;
  }

  async releaseWriterLease(): Promise<void> {
    if (!this.#lease) return;
    const lock = this.#lease;
    // Clear first and tolerate ROLLBACK/close failures: release runs in the
    // runner's finally, and a throwing release must neither mask the run's
    // real error nor leave a handle that believes it still holds the lease.
    this.#lease = null;
    try {
      lock.exec("ROLLBACK");
    } catch {
      // closing the connection releases the lock regardless
    }
    try {
      lock.close();
    } catch {
      // already closed or torn down — the OS lock died with the connection
    }
  }

  // ---- operational surface -------------------------------------------------

  async overview(runsLimit: number): Promise<StoreOverview> {
    const count = (sql: string): number => {
      const row = this.#db.prepare(sql).get() as { n: number };
      return Number(row.n);
    };
    // One GROUP BY into a { key: count } record; a NULL group key (e.g. an edge
    // with no lifecycle) is folded into "(none)" so JSON consumers see no nulls.
    const groupCounts = (sql: string): Record<string, number> => {
      const rows = this.#db.prepare(sql).all() as unknown as { k: string | null; n: number }[];
      const out: Record<string, number> = {};
      for (const r of rows) out[r.k ?? "(none)"] = Number(r.n);
      return out;
    };

    // Row counts for every application table, discovered from sqlite_master so a
    // future migration's tables show up without touching this list.
    const tables: Record<string, number> = {};
    const tableRows = this.#db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as unknown as { name: string }[];
    for (const t of tableRows) tables[t.name] = count(`SELECT COUNT(*) AS n FROM "${t.name}"`);

    const bounds = this.#db
      .prepare(`SELECT MIN(occurred_at) AS earliest, MAX(occurred_at) AS latest FROM activity`)
      .get() as { earliest: string | null; latest: string | null };

    return {
      tables,
      items: {
        live: count(`SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NULL`),
        tombstoned: count(`SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NOT NULL`),
        by_kind: groupCounts(`SELECT kind AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY kind ORDER BY kind`),
        by_state: groupCounts(`SELECT state AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY state ORDER BY state`),
        by_source: groupCounts(`SELECT source_id AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY source_id ORDER BY source_id`),
      },
      edges: {
        live: count(`SELECT COUNT(*) AS n FROM edge WHERE deleted_at IS NULL`),
        tombstoned: count(`SELECT COUNT(*) AS n FROM edge WHERE deleted_at IS NOT NULL`),
        by_type: groupCounts(`SELECT type AS k, COUNT(*) AS n FROM edge WHERE deleted_at IS NULL GROUP BY type ORDER BY type`),
        by_lifecycle: groupCounts(`SELECT lifecycle AS k, COUNT(*) AS n FROM edge WHERE deleted_at IS NULL GROUP BY lifecycle ORDER BY lifecycle`),
      },
      activities: {
        total: count(`SELECT COUNT(*) AS n FROM activity`),
        by_kind: groupCounts(`SELECT kind AS k, COUNT(*) AS n FROM activity GROUP BY kind ORDER BY kind`),
        earliest: bounds.earliest,
        latest: bounds.latest,
      },
      sync_runs: this.#db
        .prepare(
          `SELECT run_id, source_id, mode, status, started_at, finished_at,
                  items_seen, edges_seen, activities_seen, graphql_requests, graphql_cost, graphql_cost_unknown, error
           FROM sync_run ORDER BY run_id DESC LIMIT ?`,
        )
        .all(runsLimit) as unknown as StoreSyncRunRow[],
    };
  }

  async diagnostics(): Promise<StoreDiagnostics> {
    const pragma = (name: string): number => {
      const row = this.#db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
      return Number(row[name] ?? 0);
    };
    return {
      path: this.#path,
      size_bytes: fileSize(this.#path),
      wal_size_bytes: fileSize(`${this.#path}-wal`),
      page_size: pragma("page_size"),
      page_count: pragma("page_count"),
      schema_version: pragma("user_version"),
    };
  }

  // ---- lifecycle -----------------------------------------------------------

  async readSnapshot<T>(fn: (snapshot: Store) => Promise<T>): Promise<T> {
    const run = this.#txQueue.then(async () => {
      this.#db.exec("BEGIN");
      this.#inTransaction = true;
      try {
        const result = await fn(this);
        this.#db.exec("COMMIT");
        return result;
      } catch (err) {
        this.#db.exec("ROLLBACK");
        throw err;
      } finally {
        this.#inTransaction = false;
      }
    });
    this.#txQueue = run.catch(() => undefined);
    return run;
  }

  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    const run = this.#txQueue.then(async () => {
      this.#db.exec("BEGIN");
      this.#inTransaction = true;
      try {
        const result = await fn(this);
        this.#flushRepoActivityBoundsDirty();
        this.#db.exec("COMMIT");
        return result;
      } catch (err) {
        this.#repoActivityBoundsDirty.clear();
        this.#db.exec("ROLLBACK");
        throw err;
      } finally {
        this.#inTransaction = false;
      }
    });
    this.#txQueue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.releaseWriterLease();
    this.#db.close();
  }
}
