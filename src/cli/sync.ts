#!/usr/bin/env node
// Sync every configured source into the canonical store. Each source runs a
// full sweep by default (enables the soft-delete sweep); --incremental uses the
// stored watermark. --dry-run computes and reports without writing. This CLI only
// syncs; the contract emit is a separate step (see emit-contract.ts and the loop
// daemon, both of which share the sync-runner module).
//
//   node src/cli/sync.ts [--dry-run] [--incremental] [--source <id>] [--config <path>]

import { loadConfig } from "../config.ts";
import { runConfiguredSync, type SyncMode } from "../sync-runner.ts";
import { log } from "../log.ts";

interface Args {
  dryRun: boolean;
  mode: SyncMode;
  source: string | null;
  config: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, mode: "full", source: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry-run" || x === "-n") a.dryRun = true;
    else if (x === "--incremental") a.mode = "incremental";
    else if (x === "--full") a.mode = "full";
    else if (x === "--source") a.source = argv[++i] ?? null;
    else if (x === "--config") a.config = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${x}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const { cfg, path } = loadConfig(args.config);
log.info(`sync ${args.dryRun ? "DRY RUN" : "WRITE"} (${args.mode}), config ${path}`);

// Sync-only (out=null): this CLI never emits, matching the prior `pnpm run sync`
// behavior. The per-source log lines and exit code come from the shared runner.
const result = await runConfiguredSync(cfg, { mode: args.mode, dryRun: args.dryRun, sourceId: args.source }, null);
process.exit(result.status === "error" ? 1 : 0);
