#!/usr/bin/env node
// Sync every configured source into the canonical store. Each source runs a
// full sweep by default (enables the soft-delete sweep); --incremental uses the
// stored watermark. --dry-run computes and reports without writing.
//
//   node src/cli/sync.ts [--dry-run] [--incremental] [--source <id>] [--config <path>]

import { loadConfig, tokenFor } from "../config.ts";
import { openDb } from "../db/open.ts";
import { buildSource } from "../sources/registry.ts";
import { syncSource } from "../sync-engine.ts";
import { getWatermark } from "../db/repo.ts";
import { log } from "../log.ts";

interface Args {
  dryRun: boolean;
  full: boolean;
  source: string | null;
  config: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, full: true, source: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry-run" || x === "-n") a.dryRun = true;
    else if (x === "--incremental") a.full = false;
    else if (x === "--full") a.full = true;
    else if (x === "--source") a.source = argv[++i] ?? null;
    else if (x === "--config") a.config = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${x}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const { cfg, path } = loadConfig(args.config);
log.info(`sync ${args.dryRun ? "DRY RUN" : "WRITE"} (${args.full ? "full" : "incremental"}), config ${path}`);

const db = openDb(cfg.db_path);
let failed = false;
try {
  for (const sc of cfg.sources) {
    if (args.source && sc.source_id !== args.source) continue;
    const token = tokenFor(sc);
    if (!token) {
      log.warn(`skip ${sc.source_id}: env ${sc.token_env} not set`);
      continue;
    }
    const source = buildSource(sc, token);
    const prev = args.full ? null : getWatermark(db, sc.source_id);
    const rep = await syncSource(db, source, prev, { full: args.full, dryRun: args.dryRun });
    log.info(
      `[${rep.sourceId}] status=${rep.status} items=${rep.itemsSeen} edges=${rep.edgesSeen} activities=${rep.activitiesSeen} ` +
        `softDeleted=${rep.softDeleted}items/${rep.softDeletedEdges}edges${rep.error ? ` error=${rep.error}` : ""}`,
    );
    if (rep.status === "error") failed = true;
  }
} finally {
  db.close();
}
process.exit(failed ? 1 : 0);
