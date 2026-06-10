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
import { loadConfig } from "../config.ts";
import { openSqliteStore } from "../db/sqlite.ts";
import { buildContractEnvelope } from "../contract/emit.ts";
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

const store = await openSqliteStore(cfg.db_path);
const envelope = await buildContractEnvelope(store, cfg, new Date().toISOString());
await store.close();

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
