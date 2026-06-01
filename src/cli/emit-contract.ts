#!/usr/bin/env node
// Emit the versioned JSON contract (LAYER 3) from the current store state.
// Writes to stdout, or to --out <file>. The contract is a projection — safe to
// regenerate any time; it is never the stored truth.
//
//   node src/cli/emit-contract.ts [--out <file>] [--config <path>]

import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/open.ts";
import { listSources, listLiveItems, listLabels, listLiveEdges } from "../db/repo.ts";
import { buildContract } from "../contract/build.ts";

interface Args {
  out: string | null;
  config: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { out: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--out") a.out = argv[++i] ?? null;
    else if (x === "--config") a.config = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${x}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const { cfg } = loadConfig(args.config);
const db = openDb(cfg.db_path);
const envelope = buildContract({
  sources: listSources(db),
  items: listLiveItems(db),
  labels: listLabels(db),
  edges: listLiveEdges(db),
  generatedAt: new Date().toISOString(),
});
db.close();

const json = JSON.stringify(envelope, null, 2);
if (args.out) {
  writeFileSync(args.out, json + "\n");
  process.stderr.write(`wrote ${envelope.items.length} items / ${envelope.edges.length} edges -> ${args.out}\n`);
} else {
  process.stdout.write(json + "\n");
}
