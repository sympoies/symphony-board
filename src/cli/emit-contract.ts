#!/usr/bin/env node
// Emit the versioned JSON contract (LAYER 3) from the current store state.
// Writes to stdout, or to --out <file>. The contract is a projection — safe to
// regenerate any time; it is never the stored truth.
//
// Before writing, the envelope is validated against the normative schema (the
// producer guard: a malformed contract must never ship). --no-validate is an
// escape hatch if the validator itself ever rejects a legitimate payload.
//
//   node src/cli/emit-contract.ts [--out <file>] [--config <path>] [--no-validate]

import { writeFileSync } from "node:fs";
import type { RepoDTO } from "@symphony-board/contract";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/open.ts";
import { listSources, listLiveItems, listLabels, listLiveEdges, listActivities } from "../db/repo.ts";
import { buildContract } from "../contract/build.ts";
import { validateContract } from "../contract/validate.ts";

interface Args {
  out: string | null;
  config: string | null;
  validate: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { out: null, config: null, validate: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--out") a.out = argv[++i] ?? null;
    else if (x === "--config") a.config = argv[++i] ?? null;
    else if (x === "--no-validate") a.validate = false;
    else throw new Error(`unknown argument: ${x}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const { cfg } = loadConfig(args.config);

// Config-derived display colors: source-level on each source, repo-level on the
// few project entries that carry one. Display metadata only — read here at emit
// time, never stored in the DB, so buildContract stays a pure mapping.
const sourceColors: Record<string, string> = {};
const repoColors: RepoDTO[] = [];
for (const s of cfg.sources) {
  if (s.color) sourceColors[s.source_id] = s.color;
  for (const p of s.projects) {
    if (typeof p !== "string" && p.color) {
      repoColors.push({ source_id: s.source_id, project_path: p.path, color: p.color });
    }
  }
}

const db = openDb(cfg.db_path);
const envelope = buildContract({
  sources: listSources(db),
  items: listLiveItems(db),
  labels: listLabels(db),
  edges: listLiveEdges(db),
  activities: listActivities(db),
  generatedAt: new Date().toISOString(),
  sourceColors,
  repoColors,
});
db.close();

if (args.validate) {
  const errors = validateContract(envelope);
  if (errors.length > 0) {
    process.stderr.write(`refusing to emit: contract failed schema validation (${errors.length} violation(s)):\n`);
    for (const e of errors) process.stderr.write(`  ${e.path || "(root)"}: ${e.message}\n`);
    process.exit(1);
  }
}

const json = JSON.stringify(envelope, null, 2);
if (args.out) {
  writeFileSync(args.out, json + "\n");
  const totalItems = envelope.item_window?.total_items ?? envelope.items.length;
  process.stderr.write(`wrote ${envelope.items.length}/${totalItems} items / ${envelope.edges.length} edges / ${envelope.activities?.length ?? 0} activities -> ${args.out}\n`);
} else {
  process.stdout.write(json + "\n");
}
