// Postgres driver for the Store interface, on postgres.js (the `postgres`
// package — zero transitive dependencies, fitting the repo's minimal-dependency
// stance). Loaded lazily by src/db/factory.ts, so SQLite-only deployments never
// resolve it.
//
// Driver-owned facts (see src/db/store.ts for the interface contract):
// - DDL lives in schema/postgres/*.sql; the schema version is tracked in the
//   meta table (key 'schema_version') — Postgres has no PRAGMA user_version.
//   Concurrent migrators serialize on a transaction-scoped advisory lock.
// - Timestamps stay ISO-8601 strings in TEXT columns, exactly like the SQLite
//   driver. Order-by-instant casts ::timestamptz where SQLite uses julianday()
//   (occurred_at preserves the provider's original UTC offset). Plain DESC
//   order-bys add NULLS LAST for parity with SQLite, whose DESC sorts NULLs
//   last.
// - The watermark upsert uses GREATEST (Postgres ignores NULLs in GREATEST),
//   which both COALESCEs a null watermark away AND makes the watermark
//   monotonic — an interleaved older run can never regress it.
// - The writer lease is `pg_try_advisory_lock` on a DEDICATED single-connection
//   client created per acquire: session-scoped, so a holder whose connection
//   (or process) dies releases it automatically — no TTL machinery. Release
//   simply ends that session (the server drops its locks) and never sends a
//   query on it — a query on a crashed connection trips an uncatchable async
//   TypeError inside postgres.js. The lease client pins max_lifetime: null so
//   the pool can never silently replace the session (and its lock) mid-run.
//   The key is namespaced by current_schema() so independent stores in one
//   database (the conformance suite) do not contend.
// - int8 is parsed to JS numbers globally (exact below 2^53 — provider ids and
//   board-scale counts sit far under it): provider-derived columns (iid,
//   demand, target_iid) are BIGINT because SQLite's INTEGER is 64-bit and
//   gitlab.com already emits values past 2^31; COUNT(*) aggregates are int8
//   too. The defensive Number() wraps at read sites stay (harmless either
//   way).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
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
const SCHEMA_DIR = resolve(__dirname, "..", "..", "schema", "postgres");

interface Migration {
  version: number;
  file: string;
}

interface ActivityInstantRow {
  activity_id: number;
  occurred_at: string;
}

// Ordered list of migrations. Append future ones; never edit an applied file.
const MIGRATIONS: Migration[] = [
  { version: 1, file: "0001_init.sql" },
  { version: 2, file: "0002_activity.sql" },
  { version: 3, file: "0003_actor_identity.sql" },
  { version: 4, file: "0004_review_threads.sql" },
  { version: 5, file: "0005_repo_activity_bounds.sql" },
  { version: 6, file: "0006_review_thread_detail.sql" },
  { version: 7, file: "0007_review_thread_target_iid_bigint.sql" },
];
const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

const nz = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

function repoActivityBoundsFromRows(rows: ActivityInstantRow[]): { observedSince: string; lastActivityAt: string } | null {
  let observedSince: { ms: number; id: number; value: string } | null = null;
  let lastActivityAt: { ms: number; id: number; value: string } | null = null;

  for (const row of rows) {
    const ms = Date.parse(row.occurred_at);
    if (!Number.isFinite(ms)) continue;
    const id = Number(row.activity_id);
    if (!observedSince || ms < observedSince.ms || (ms === observedSince.ms && id < observedSince.id)) {
      observedSince = { ms, id, value: row.occurred_at };
    }
    if (!lastActivityAt || ms > lastActivityAt.ms || (ms === lastActivityAt.ms && id > lastActivityAt.id)) {
      lastActivityAt = { ms, id, value: row.occurred_at };
    }
  }

  if (!observedSince || !lastActivityAt) return null;
  return { observedSince: observedSince.value, lastActivityAt: lastActivityAt.value };
}

export interface PgOpenOptions {
  // Postgres schema to hold the store's tables (created when missing). Unset
  // means the connection default (normally `public`). Used by the conformance
  // suite to give every open() a fresh, isolated store in one database.
  schema?: string;
}

// Parse int8 (oid 20) to JS numbers: BIGINT columns and COUNT(*) results come
// back as numbers, like every other driver value. Exact below 2^53.
const PG_TYPES = {
  bigint: { to: 20, from: [20], serialize: (v: unknown) => String(v), parse: (v: string) => Number(v) },
};

// Open the store read-write, creating and migrating its schema as needed.
export async function openPostgresStore(url: string, opts: PgOpenOptions = {}): Promise<Store> {
  const schema = opts.schema?.trim();
  const common = {
    onnotice: () => {},
    types: PG_TYPES,
    ...(schema ? { connection: { search_path: schema } } : {}),
  };
  // The store is a single-writer surface; a handful of connections covers the
  // run connection and a transaction.
  const sql = postgres(url, { ...common, max: 4 });
  // One fresh single-connection client per lease acquire (see the writer-lease
  // notes in the header): its session IS the lease, so it must never be
  // replaced from under the lock.
  const makeLeaseClient = () => postgres(url, { ...common, max: 1, max_lifetime: null });
  try {
    if (schema) await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
    await migrate(sql);
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
  return new PgStore(sql, makeLeaseClient);
}

// Open the store read-only, mirroring openSqliteStoreReadOnly: the session is
// pinned read-only at the server (default_transaction_read_only = on as a
// startup parameter, so every statement — and any BEGIN, including
// transaction() — runs in a read-only transaction and writes fail loudly).
// Never migrates: an older-than-expected schema is an error (the writer owns
// migrations). No writer lease is wired up — a read-only handle has no
// business holding it.
export async function openPostgresStoreReadOnly(url: string, opts: PgOpenOptions = {}): Promise<Store> {
  const schema = opts.schema?.trim();
  // Single read-only session semantics (no pooling/replica routing): the API
  // sidecars open per request, read, and close.
  const sql = postgres(url, {
    onnotice: () => {},
    types: PG_TYPES,
    max: 4,
    connection: {
      default_transaction_read_only: true,
      ...(schema ? { search_path: schema } : {}),
    },
  });
  try {
    const have = await currentVersion(sql);
    if (have < CURRENT_SCHEMA_VERSION) {
      throw new Error(`database schema version ${have} is older than expected ${CURRENT_SCHEMA_VERSION}`);
    }
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
  return new PgStore(sql);
}

async function currentVersion(q: Sql | TransactionSql): Promise<number> {
  const reg = await q`SELECT to_regclass('meta') AS t`;
  if (!reg[0]?.t) return 0;
  const rows = await q`SELECT value FROM meta WHERE key = 'schema_version'`;
  return rows.length ? Number(rows[0]!.value) : 0;
}

async function migrate(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    // Two handles opening the same store concurrently (the conformance
    // suite's openShared) must not both apply DDL; the xact-scoped advisory
    // lock serializes them and releases itself at commit/rollback.
    await tx`SELECT pg_advisory_xact_lock(hashtext('symphony-board:migrate'), hashtext(current_schema()))`;
    const have = await currentVersion(tx);
    for (const m of MIGRATIONS) {
      if (m.version <= have) continue;
      const ddl = readFileSync(resolve(SCHEMA_DIR, m.file), "utf8");
      await tx.unsafe(ddl);
      await tx`INSERT INTO meta (key, value, updated_at)
               VALUES ('schema_version', ${String(m.version)}, ${new Date().toISOString()})
               ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
    }
  });
}

export class PgStore implements Store {
  // The root client (owns the pool, the lease, close()) — null on a
  // transaction view, whose lifetime belongs to its parent.
  readonly #sql: Sql | null;
  // The query handle every method goes through: the root client, or the
  // transaction-scoped handle inside transaction().
  readonly #q: Sql;
  // Factory for dedicated lease sessions — null on a transaction view.
  readonly #makeLeaseClient: (() => Sql) | null;
  // Serializes transaction() calls, mirroring the SQLite driver: the engine is
  // single-writer and the interface promises serialized transactions.
  #txQueue: Promise<unknown> = Promise.resolve();
  #repoActivityBoundsDirty = new Map<string, RepoActivityBoundsBucket>();
  // The dedicated lease session while this handle holds the writer lease.
  #lease: Sql | null = null;

  constructor(sql: Sql, makeLeaseClient?: () => Sql, txHandle?: Sql) {
    this.#sql = txHandle ? null : sql;
    this.#q = txHandle ?? sql;
    this.#makeLeaseClient = txHandle ? null : (makeLeaseClient ?? null);
  }

  // ---- write paths ---------------------------------------------------------

  async ensureSource(d: SourceDescriptor, nowIso: string): Promise<void> {
    await this.#q`
      INSERT INTO source (source_id, kind, host, display_name, created_at)
      VALUES (${d.sourceId}, ${d.kind}, ${d.host}, ${nz(d.displayName)}, ${nowIso})
      ON CONFLICT (source_id) DO UPDATE SET
        kind = excluded.kind, host = excluded.host, display_name = excluded.display_name`;
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
    const prev = await this.#q`
      SELECT content_hash FROM raw WHERE source_id = ${sourceId} AND external_id = ${externalId}`;
    await this.#q`
      INSERT INTO raw (source_id, entity_kind, external_id, api_version, content_hash, fetched_at, payload)
      VALUES (${sourceId}, ${entityKind}, ${externalId}, ${nz(apiVersion)}, ${nz(contentHash)}, ${fetchedAt}, ${payloadJson})
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        entity_kind = excluded.entity_kind, api_version = excluded.api_version,
        content_hash = excluded.content_hash, fetched_at = excluded.fetched_at, payload = excluded.payload`;
    return prev.length === 0 || prev[0]!.content_hash !== contentHash;
  }

  async upsertItem(item: CanonicalItem, normalizerVersion: string, seenAt: string): Promise<number> {
    const rows = await this.#q`
      INSERT INTO item (
        source_id, external_id, kind, project_path, iid, url, title, state, state_raw,
        state_reason, is_draft, author, created_at, updated_at, closed_at, merged_at,
        review_state, ci_state, merge_state, open_review_threads, total_review_threads,
        milestone, demand, normalized_with,
        last_seen_at, deleted_at
      ) VALUES (
        ${item.sourceId}, ${item.externalId}, ${item.kind}, ${nz(item.projectPath)}, ${nz(item.iid)},
        ${item.url}, ${nz(item.title)}, ${item.state}, ${nz(item.stateRaw)}, ${nz(item.stateReason)},
        ${nz(item.isDraft)}, ${nz(item.author)}, ${nz(item.createdAt)}, ${nz(item.updatedAt)},
        ${nz(item.closedAt)}, ${nz(item.mergedAt)}, ${nz(item.reviewState)}, ${nz(item.ciState)},
        ${nz(item.mergeState)}, ${nz(item.openReviewThreads)}, ${nz(item.totalReviewThreads)},
        ${nz(item.milestone)}, ${nz(item.demand)}, ${normalizerVersion},
        ${seenAt}, NULL
      )
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        kind = excluded.kind, project_path = excluded.project_path, iid = excluded.iid,
        url = excluded.url, title = excluded.title, state = excluded.state, state_raw = excluded.state_raw,
        state_reason = excluded.state_reason, is_draft = excluded.is_draft, author = excluded.author,
        created_at = excluded.created_at, updated_at = excluded.updated_at, closed_at = excluded.closed_at,
        merged_at = excluded.merged_at, review_state = excluded.review_state, ci_state = excluded.ci_state,
        merge_state = excluded.merge_state, open_review_threads = excluded.open_review_threads,
        total_review_threads = excluded.total_review_threads, milestone = excluded.milestone, demand = excluded.demand,
        normalized_with = excluded.normalized_with, last_seen_at = excluded.last_seen_at, deleted_at = NULL
      RETURNING item_id`;
    return Number(rows[0]!.item_id);
  }

  async replaceLabels(itemId: number, labels: CanonicalLabel[]): Promise<void> {
    await this.#q`DELETE FROM item_label WHERE item_id = ${itemId}`;
    for (const l of labels) {
      await this.#q`
        INSERT INTO item_label (item_id, name, scope, color)
        VALUES (${itemId}, ${l.name}, ${nz(l.scope)}, ${nz(l.color)})
        ON CONFLICT (item_id, name) DO NOTHING`;
    }
  }

  async upsertEdge(e: ReconciledEdge, nowIso: string): Promise<void> {
    await this.#q`
      INSERT INTO edge (
        type, from_source_id, from_external_id, to_source_id, to_external_id,
        from_state, to_state, lifecycle, discovered_from, first_seen_at, last_seen_at, deleted_at
      ) VALUES (
        ${e.type}, ${e.from.sourceId}, ${e.from.externalId}, ${e.to.sourceId}, ${e.to.externalId},
        ${nz(e.fromState)}, ${nz(e.toState)}, ${nz(e.lifecycle)}, ${e.discoveredFrom}, ${nowIso}, ${nowIso}, NULL
      )
      ON CONFLICT (type, from_source_id, from_external_id, to_source_id, to_external_id) DO UPDATE SET
        from_state = excluded.from_state, to_state = excluded.to_state, lifecycle = excluded.lifecycle,
        discovered_from = excluded.discovered_from, last_seen_at = excluded.last_seen_at, deleted_at = NULL`;
  }

  async upsertActivity(a: CanonicalActivity, nowIso: string): Promise<void> {
    const details = a.details === null ? null : JSON.stringify(a.details);
    const projectPath = nz(a.projectPath);
    const prev = await this.#q`
      SELECT project_path FROM activity WHERE source_id = ${a.sourceId} AND external_id = ${a.externalId}`;
    await this.#q`
      INSERT INTO activity (
        source_id, external_id, kind, action, project_path, target_kind,
        target_source_id, target_external_id, target_iid, title, url, actor,
        actor_key, occurred_at, summary, details, first_seen_at, last_seen_at
      ) VALUES (
        ${a.sourceId}, ${a.externalId}, ${a.kind}, ${a.action}, ${nz(a.projectPath)}, ${nz(a.targetKind)},
        ${nz(a.target?.sourceId)}, ${nz(a.target?.externalId)}, ${nz(a.targetIid)}, ${nz(a.title)},
        ${nz(a.url)}, ${nz(a.actor)}, ${nz(a.actorKey)}, ${a.occurredAt}, ${nz(a.summary)}, ${details},
        ${nowIso}, ${nowIso}
      )
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        kind = excluded.kind, action = excluded.action, project_path = excluded.project_path,
        target_kind = excluded.target_kind, target_source_id = excluded.target_source_id,
        target_external_id = excluded.target_external_id, target_iid = excluded.target_iid,
        title = excluded.title, url = excluded.url, actor = excluded.actor,
        actor_key = excluded.actor_key,
        occurred_at = excluded.occurred_at, summary = excluded.summary,
        details = excluded.details, last_seen_at = excluded.last_seen_at`;
    this.#markRepoActivityBoundsDirty(a.sourceId, projectPath, nowIso);
    if (prev.length > 0 && (prev[0]!.project_path as string | null) !== projectPath) {
      this.#markRepoActivityBoundsDirty(a.sourceId, prev[0]!.project_path as string | null, nowIso);
    }
    if (this.#sql) await this.#flushRepoActivityBoundsDirty();
  }

  async upsertReviewThread(thread: CanonicalReviewThread, nowIso: string): Promise<void> {
    await this.#q`
      INSERT INTO review_thread (
        source_id, external_id, project_path, target_source_id, target_external_id,
        target_iid, title, url, is_resolved, is_outdated, resolved_by, path,
        line, start_line, comments_total, comments_json, last_seen_at, deleted_at
      ) VALUES (
        ${thread.sourceId}, ${thread.externalId}, ${nz(thread.projectPath)}, ${thread.target.sourceId},
        ${thread.target.externalId}, ${nz(thread.targetIid)}, ${nz(thread.title)}, ${nz(thread.url)},
        ${thread.isResolved}, ${nz(thread.isOutdated)}, ${nz(thread.resolvedBy)}, ${nz(thread.path)},
        ${nz(thread.line)}, ${nz(thread.startLine)}, ${thread.commentsTotal}, ${JSON.stringify(thread.comments)},
        ${nowIso}, NULL
      )
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        project_path = excluded.project_path,
        target_source_id = excluded.target_source_id,
        target_external_id = excluded.target_external_id,
        target_iid = excluded.target_iid,
        title = excluded.title,
        url = excluded.url,
        is_resolved = excluded.is_resolved,
        is_outdated = excluded.is_outdated,
        resolved_by = excluded.resolved_by,
        path = excluded.path,
        line = excluded.line,
        start_line = excluded.start_line,
        comments_total = excluded.comments_total,
        comments_json = excluded.comments_json,
        last_seen_at = excluded.last_seen_at,
        deleted_at = NULL`;
  }

  #markRepoActivityBoundsDirty(sourceId: string, projectPath: string | null, updatedAt: string): void {
    const bucket = repoActivityBoundsBucket(sourceId, projectPath, updatedAt);
    this.#repoActivityBoundsDirty.set(repoActivityBoundsBucketId(sourceId, bucket.projectKey), bucket);
  }

  async #flushRepoActivityBoundsDirty(): Promise<void> {
    const buckets = [...this.#repoActivityBoundsDirty.values()];
    this.#repoActivityBoundsDirty.clear();
    for (const bucket of buckets) await this.#refreshRepoActivityBounds(bucket);
  }

  async #refreshRepoActivityBounds(bucket: RepoActivityBoundsBucket): Promise<void> {
    const rows = bucket.projectPath === null
      ? await this.#q`
          SELECT activity_id, occurred_at
          FROM activity
          WHERE source_id = ${bucket.sourceId}
            AND project_path IS NULL`
      : await this.#q`
          SELECT activity_id, occurred_at
          FROM activity
          WHERE source_id = ${bucket.sourceId}
            AND project_path = ${bucket.projectPath}`;
    const bounds = repoActivityBoundsFromRows(rows as unknown as ActivityInstantRow[]);

    if (!bounds) {
      await this.#q`
        DELETE FROM repo_activity_bounds
        WHERE source_id = ${bucket.sourceId} AND project_key = ${bucket.projectKey}`;
      return;
    }

    await this.#q`
      INSERT INTO repo_activity_bounds (
        source_id, project_path, project_key, observed_since, last_activity_at, updated_at
      ) VALUES (
        ${bucket.sourceId}, ${bucket.projectPath}, ${bucket.projectKey},
        ${bounds.observedSince}, ${bounds.lastActivityAt}, ${bucket.updatedAt}
      )
      ON CONFLICT (source_id, project_key) DO UPDATE SET
        project_path = excluded.project_path,
        observed_since = excluded.observed_since,
        last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at`;
  }

  async startRun(sourceId: string, mode: "full" | "incremental", startedAt: string): Promise<number> {
    const rows = await this.#q`
      INSERT INTO sync_run (source_id, mode, status, started_at)
      VALUES (${sourceId}, ${mode}, 'partial', ${startedAt})
      RETURNING run_id`;
    return Number(rows[0]!.run_id);
  }

  async finishRun(
    runId: number,
    status: "ok" | "partial" | "error",
    finishedAt: string,
    itemsSeen: number,
    edgesSeen: number,
    activitiesSeen: number,
    error: string | null,
  ): Promise<void> {
    await this.#q`
      UPDATE sync_run SET status = ${status}, finished_at = ${finishedAt}, items_seen = ${itemsSeen},
        edges_seen = ${edgesSeen}, activities_seen = ${activitiesSeen}, error = ${nz(error)}
      WHERE run_id = ${runId}`;
  }

  async updateSyncState(
    sourceId: string,
    watermark: string | null,
    status: "ok" | "partial" | "error",
    error: string | null,
    nowIso: string,
  ): Promise<void> {
    const lastSuccess = status === "ok" ? nowIso : null;
    // GREATEST ignores NULLs in Postgres: a null incoming watermark keeps the
    // stored one (the COALESCE the interface requires), and a non-null one
    // only ever moves forward.
    await this.#q`
      INSERT INTO sync_state (source_id, watermark, last_run_at, last_success_at, last_status, last_error)
      VALUES (${sourceId}, ${nz(watermark)}, ${nowIso}, ${nz(lastSuccess)}, ${status}, ${nz(error)})
      ON CONFLICT (source_id) DO UPDATE SET
        watermark = GREATEST(excluded.watermark, sync_state.watermark),
        last_run_at = excluded.last_run_at,
        last_success_at = COALESCE(excluded.last_success_at, sync_state.last_success_at),
        last_status = excluded.last_status, last_error = excluded.last_error`;
  }

  async softDeleteUnseenItems(sourceId: string, cutoff: string, nowIso: string): Promise<number> {
    const r = await this.#q`
      UPDATE item SET deleted_at = ${nowIso}
      WHERE source_id = ${sourceId} AND deleted_at IS NULL AND last_seen_at < ${cutoff}`;
    return r.count;
  }

  async softDeleteUnseenEdges(sourceId: string, cutoff: string, nowIso: string): Promise<number> {
    const r = await this.#q`
      UPDATE edge SET deleted_at = ${nowIso}
      WHERE from_source_id = ${sourceId} AND to_source_id = ${sourceId}
        AND deleted_at IS NULL AND last_seen_at < ${cutoff}`;
    return r.count;
  }

  async softDeleteUnseenReviewThreads(sourceId: string, cutoff: string, nowIso: string): Promise<number> {
    const r = await this.#q`
      UPDATE review_thread SET deleted_at = ${nowIso}
      WHERE source_id = ${sourceId} AND deleted_at IS NULL AND last_seen_at < ${cutoff}`;
    return r.count;
  }

  // ---- read paths ----------------------------------------------------------

  async getWatermark(sourceId: string): Promise<string | null> {
    const rows = await this.#q`SELECT watermark FROM sync_state WHERE source_id = ${sourceId}`;
    return (rows[0]?.watermark as string | null | undefined) ?? null;
  }

  async listLiveItems(): Promise<ItemRow[]> {
    const rows = await this.#q`
      SELECT item_id, source_id, external_id, kind, project_path, iid, url, title, state,
             state_raw, state_reason, is_draft, author, created_at, updated_at, closed_at,
             merged_at, review_state, ci_state, merge_state, open_review_threads,
             total_review_threads, milestone, demand, last_seen_at
      FROM item WHERE deleted_at IS NULL
      ORDER BY COALESCE(closed_at, merged_at, updated_at, created_at) DESC NULLS LAST, item_id DESC`;
    return rows as unknown as ItemRow[];
  }

  async listCiRefreshCandidates(sourceId: string, cutoffIso: string, limit: number): Promise<CiRefreshCandidateRow[]> {
    const safeLimit = Math.max(0, Math.trunc(Number.isFinite(limit) ? limit : 0));
    if (safeLimit === 0) return [];
    const rows = await this.#q`
      SELECT source_id, external_id, project_path, iid, state, ci_state,
             updated_at, closed_at, merged_at, last_seen_at
      FROM item
      WHERE deleted_at IS NULL
        AND source_id = ${sourceId}
        AND kind = 'change_request'
        AND project_path IS NOT NULL
        AND iid IS NOT NULL
        AND (
          state = 'open'
          OR COALESCE(merged_at, closed_at, updated_at, created_at) >= ${cutoffIso}
        )
      ORDER BY
        CASE
          WHEN ci_state IN ('pending', 'none') THEN 0
          WHEN state = 'open' THEN 1
          ELSE 2
        END,
        (COALESCE(merged_at, closed_at, updated_at, created_at))::timestamptz DESC NULLS LAST,
        item_id DESC
      LIMIT ${safeLimit}`;
    return rows as unknown as CiRefreshCandidateRow[];
  }

  async listActivities(): Promise<ActivityRow[]> {
    const rows = await this.#q`
      SELECT source_id, external_id, kind, action, project_path, target_kind,
             target_source_id, target_external_id, target_iid, title, url, actor,
             actor_key, occurred_at, summary, details, first_seen_at, last_seen_at
      FROM activity
      ORDER BY occurred_at::timestamptz DESC, activity_id DESC`;
    return rows as unknown as ActivityRow[];
  }

  async listActivitiesInRange(fromIso: string, toIso: string): Promise<ActivityRow[]> {
    const { coarseFrom, coarseTo, from, to } = activityRangeBounds(fromIso, toIso);
    // coarse text band first: a range scan on activity_by_time(occurred_at)
    // avoids reading the whole table; then ::timestamptz trims to the exact
    // instant window (text alone is offset-sensitive). See activity-range.ts.
    const rows = await this.#q`
      SELECT source_id, external_id, kind, action, project_path, target_kind,
             target_source_id, target_external_id, target_iid, title, url, actor,
             actor_key, occurred_at, summary, details, first_seen_at, last_seen_at
      FROM activity
      WHERE occurred_at >= ${coarseFrom} AND occurred_at <= ${coarseTo}
        AND occurred_at::timestamptz >= ${from}::timestamptz
        AND occurred_at::timestamptz <= ${to}::timestamptz
      ORDER BY occurred_at::timestamptz DESC, activity_id DESC`;
    return rows as unknown as ActivityRow[];
  }

  async listLiveReviewThreads(): Promise<ReviewThreadRow[]> {
    const rows = await this.#q`
      SELECT source_id, external_id, project_path, target_source_id, target_external_id,
             target_iid, title, url, is_resolved, is_outdated, resolved_by, path,
             line, start_line, comments_total, comments_json, last_seen_at
      FROM review_thread
      WHERE deleted_at IS NULL
      ORDER BY is_resolved ASC, source_id ASC, project_path ASC NULLS LAST,
               target_iid DESC NULLS LAST, path ASC NULLS LAST, line ASC NULLS LAST, external_id ASC`;
    return rows as unknown as ReviewThreadRow[];
  }

  async listRepoActivityBounds(): Promise<RepoActivityBoundsRow[]> {
    const rows = await this.#q`
      SELECT source_id, project_path, observed_since, last_activity_at
      FROM repo_activity_bounds
      ORDER BY source_id, project_key`;
    return rows as unknown as RepoActivityBoundsRow[];
  }

  async listLabels(): Promise<LabelRow[]> {
    const rows = await this.#q`SELECT item_id, name, scope, color FROM item_label`;
    return rows as unknown as LabelRow[];
  }

  async listLiveEdges(): Promise<EdgeRow[]> {
    const rows = await this.#q`
      SELECT type, from_source_id, from_external_id, to_source_id, to_external_id,
             from_state, to_state, lifecycle
      FROM edge WHERE deleted_at IS NULL`;
    return rows as unknown as EdgeRow[];
  }

  async listSources(): Promise<SourceRow[]> {
    const rows = await this.#q`
      SELECT s.source_id, s.kind, s.host, s.display_name,
             ss.last_success_at AS last_success_at, ss.last_status AS last_status
      FROM source s LEFT JOIN sync_state ss ON ss.source_id = s.source_id
      ORDER BY s.source_id`;
    return rows as unknown as SourceRow[];
  }

  // ---- operational surface -------------------------------------------------

  async overview(runsLimit: number): Promise<StoreOverview> {
    const q = this.#q;
    const count = async (rows: Promise<Array<Record<string, unknown>>>): Promise<number> =>
      Number((await rows)[0]?.n ?? 0);
    const groupCounts = async (rows: Promise<Array<Record<string, unknown>>>): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const r of await rows) out[(r.k as string | null) ?? "(none)"] = Number(r.n);
      return out;
    };

    // Row counts for every application table in the store's schema, discovered
    // from the catalog so a future migration's tables show up automatically.
    const tables: Record<string, number> = {};
    const tableRows = await q`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    for (const t of tableRows) {
      tables[t.name as string] = await count(q`SELECT COUNT(*) AS n FROM ${q(t.name as string)}`);
    }

    const bounds = (await q`SELECT MIN(occurred_at) AS earliest, MAX(occurred_at) AS latest FROM activity`)[0] as {
      earliest: string | null;
      latest: string | null;
    };

    return {
      tables,
      items: {
        live: await count(q`SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NULL`),
        tombstoned: await count(q`SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NOT NULL`),
        by_kind: await groupCounts(q`SELECT kind AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY kind ORDER BY kind`),
        by_state: await groupCounts(q`SELECT state AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY state ORDER BY state`),
        by_source: await groupCounts(q`SELECT source_id AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY source_id ORDER BY source_id`),
      },
      edges: {
        live: await count(q`SELECT COUNT(*) AS n FROM edge WHERE deleted_at IS NULL`),
        tombstoned: await count(q`SELECT COUNT(*) AS n FROM edge WHERE deleted_at IS NOT NULL`),
        by_type: await groupCounts(q`SELECT type AS k, COUNT(*) AS n FROM edge WHERE deleted_at IS NULL GROUP BY type ORDER BY type`),
        by_lifecycle: await groupCounts(q`SELECT lifecycle AS k, COUNT(*) AS n FROM edge WHERE deleted_at IS NULL GROUP BY lifecycle ORDER BY lifecycle`),
      },
      activities: {
        total: await count(q`SELECT COUNT(*) AS n FROM activity`),
        by_kind: await groupCounts(q`SELECT kind AS k, COUNT(*) AS n FROM activity GROUP BY kind ORDER BY kind`),
        earliest: bounds.earliest,
        latest: bounds.latest,
      },
      sync_runs: (
        await q`
          SELECT run_id, source_id, mode, status, started_at, finished_at,
                 items_seen, edges_seen, activities_seen, error
          FROM sync_run ORDER BY run_id DESC LIMIT ${runsLimit}`
      ).map((r) => ({
        ...r,
        run_id: Number(r.run_id),
        items_seen: Number(r.items_seen),
        edges_seen: Number(r.edges_seen),
        activities_seen: Number(r.activities_seen),
      })) as unknown as StoreSyncRunRow[],
    };
  }

  async diagnostics(): Promise<StoreDiagnostics> {
    const q = this.#q;
    const info = (
      await q`
        SELECT current_database() AS db, current_schema() AS schema,
               pg_database_size(current_database()) AS size_bytes,
               current_setting('server_version') AS server_version`
    )[0] as { db: string; schema: string; size_bytes: string | number; server_version: string };
    return {
      driver: "postgres",
      database: info.db,
      schema: info.schema,
      size_bytes: Number(info.size_bytes),
      server_version: info.server_version,
      schema_version: await currentVersion(q),
      ...(this.#lease ? { lease_pid: await this.#leasePid() } : {}),
    };
  }

  // The backend pid of the held lease connection — operational visibility, and
  // the live e2e's handle for killing a "crashed" holder for real.
  async #leasePid(): Promise<number> {
    const rows = await this.#lease!`SELECT pg_backend_pid() AS pid`;
    return Number(rows[0]!.pid);
  }

  // ---- writer lease --------------------------------------------------------

  async acquireWriterLease(): Promise<boolean> {
    if (!this.#makeLeaseClient) throw new Error("acquireWriterLease inside a transaction is invalid");
    // Idempotent on the holder. (If the lease session died underneath a still-
    // running process the lock is already gone server-side; like the SQLite
    // driver, a half-dead handle is not re-verified — process death is the
    // crash model, and the session dying releases the lock for everyone else.)
    if (this.#lease) return true;
    const lease = this.#makeLeaseClient();
    try {
      const rows = await lease`
        SELECT pg_try_advisory_lock(hashtext('symphony-board:writer'), hashtext(current_schema())) AS locked`;
      if (rows[0]?.locked === true) {
        this.#lease = lease;
        return true;
      }
      await lease.end({ timeout: 5 });
      return false;
    } catch (err) {
      await lease.end({ timeout: 0 }).catch(() => {});
      throw err;
    }
  }

  async releaseWriterLease(): Promise<void> {
    const lease = this.#lease;
    if (!lease) return;
    // Clear first; ending the session is the release (the server drops its
    // advisory locks with it). Never query the lease connection here — on a
    // crashed connection that trips an uncatchable async error in postgres.js.
    this.#lease = null;
    await lease.end({ timeout: 0 }).catch(() => {});
  }

  // ---- lifecycle -----------------------------------------------------------

  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (!this.#sql) throw new Error("nested transactions are invalid");
    const sql = this.#sql;
    const run = this.#txQueue.then(
      async () =>
        (await sql.begin(async (tx) => {
          const txStore = new PgStore(sql, undefined, tx as unknown as Sql);
          const result = await fn(txStore);
          await txStore.#flushRepoActivityBoundsDirty();
          return result;
        })) as T,
    );
    this.#txQueue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (!this.#sql) return; // a transaction view's lifetime belongs to its parent
    await this.releaseWriterLease();
    await this.#sql.end({ timeout: 5 });
  }
}
