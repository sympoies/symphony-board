// Read-only store statistics for the UI Diagnostics page (GET /api/stats),
// shared by the Docker `api` sidecar (src/cli/range-api.ts) and the standalone
// app server (src/cli/app-server.ts). Same access discipline as range.ts: every
// call opens the SQLite store read-only and closes it before returning, so the
// hosting process never holds a second writable handle.
//
// This is an operational surface, NOT part of the versioned contract — it
// describes the store (sizes, row counts, sync-run history), never the
// work-item data model, so it carries no contract_version and needs no bump.

import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.ts";
import { openDbReadOnly } from "../db/open.ts";

export interface StatsSyncRunRow {
  run_id: number;
  source_id: string;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  items_seen: number;
  edges_seen: number;
  activities_seen: number;
  error: string | null;
}

export interface StoreStats {
  generated_at: string;
  db: {
    path: string;
    size_bytes: number;
    wal_size_bytes: number;
    page_size: number;
    page_count: number;
    schema_version: number;
  };
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
  sync_runs: StatsSyncRunRow[];
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

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number };
  return Number(row.n);
}

// One GROUP BY into a { key: count } record; a NULL group key (e.g. an edge
// with no lifecycle) is folded into "(none)" so JSON consumers see no nulls.
function groupCounts(db: DatabaseSync, sql: string): Record<string, number> {
  const rows = db.prepare(sql).all() as unknown as { k: string | null; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k ?? "(none)"] = Number(r.n);
  return out;
}

export function buildStoreStats(db: DatabaseSync, dbPath: string, runsLimit = DEFAULT_RUNS): StoreStats {
  const pragma = (name: string): number => {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    return Number(row[name] ?? 0);
  };

  // Row counts for every application table, discovered from sqlite_master so a
  // future migration's tables show up without touching this list.
  const tables: Record<string, number> = {};
  const tableRows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as unknown as { name: string }[];
  for (const t of tableRows) tables[t.name] = count(db, `SELECT COUNT(*) AS n FROM "${t.name}"`);

  const bounds = db
    .prepare(`SELECT MIN(occurred_at) AS earliest, MAX(occurred_at) AS latest FROM activity`)
    .get() as { earliest: string | null; latest: string | null };

  return {
    generated_at: new Date().toISOString(),
    db: {
      path: dbPath,
      size_bytes: fileSize(dbPath),
      wal_size_bytes: fileSize(`${dbPath}-wal`),
      page_size: pragma("page_size"),
      page_count: pragma("page_count"),
      schema_version: pragma("user_version"),
    },
    tables,
    items: {
      live: count(db, `SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NULL`),
      tombstoned: count(db, `SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NOT NULL`),
      by_kind: groupCounts(db, `SELECT kind AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY kind ORDER BY kind`),
      by_state: groupCounts(db, `SELECT state AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY state ORDER BY state`),
      by_source: groupCounts(db, `SELECT source_id AS k, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY source_id ORDER BY source_id`),
    },
    edges: {
      live: count(db, `SELECT COUNT(*) AS n FROM edge WHERE deleted_at IS NULL`),
      tombstoned: count(db, `SELECT COUNT(*) AS n FROM edge WHERE deleted_at IS NOT NULL`),
      by_type: groupCounts(db, `SELECT type AS k, COUNT(*) AS n FROM edge WHERE deleted_at IS NULL GROUP BY type ORDER BY type`),
      by_lifecycle: groupCounts(db, `SELECT lifecycle AS k, COUNT(*) AS n FROM edge WHERE deleted_at IS NULL GROUP BY lifecycle ORDER BY lifecycle`),
    },
    activities: {
      total: count(db, `SELECT COUNT(*) AS n FROM activity`),
      by_kind: groupCounts(db, `SELECT kind AS k, COUNT(*) AS n FROM activity GROUP BY kind ORDER BY kind`),
      earliest: bounds.earliest,
      latest: bounds.latest,
    },
    sync_runs: db
      .prepare(
        `SELECT run_id, source_id, mode, status, started_at, finished_at,
                items_seen, edges_seen, activities_seen, error
         FROM sync_run ORDER BY run_id DESC LIMIT ?`,
      )
      .all(runsLimit) as unknown as StatsSyncRunRow[],
  };
}

export function storeStats(cfg: AppConfig, runsLimit = DEFAULT_RUNS): StoreStats {
  const db = openDbReadOnly(cfg.db_path);
  try {
    return buildStoreStats(db, cfg.db_path, runsLimit);
  } finally {
    db.close();
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
// (default 20, capped). A store that does not exist yet — a fresh deployment
// before the first sync — is a 404 the UI maps to "no data yet", not an error.
export function handleStatsRequest(cfg: AppConfig, url: URL, res: ServerResponse): void {
  const runsRaw = Number(url.searchParams.get("runs") ?? String(DEFAULT_RUNS));
  const runs = Number.isFinite(runsRaw) && runsRaw > 0 ? Math.min(Math.trunc(runsRaw), MAX_RUNS) : DEFAULT_RUNS;
  if (cfg.db_path !== ":memory:" && fileSize(cfg.db_path) === 0) {
    json(res, 404, { error: "no_database", message: `no store at ${cfg.db_path} (run a sync first)` });
    return;
  }
  try {
    json(res, 200, storeStats(cfg, runs));
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
}
