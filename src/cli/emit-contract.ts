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

import { loadConfig } from "../config.ts";
import { openConfiguredStore } from "../db/factory.ts";
import { ContractValidationError, buildContractEnvelope, emitContractToFile } from "../contract/emit.ts";
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

const store = await openConfiguredStore(cfg);
const generatedAt = new Date().toISOString();
let validationFailed = false;

try {
  if (args.out) {
    const counts = await emitContractToFile(store, cfg, args.out, generatedAt, args.validate);
    process.stderr.write(`wrote ${counts.items}/${counts.totalItems} items / ${counts.edges} edges / ${counts.activities} activities -> ${args.out}\n`);
  } else {
    const envelope = await buildContractEnvelope(store, cfg, generatedAt);
    if (args.validate) {
      const errors = validateContract(envelope);
      if (errors.length > 0) throw new ContractValidationError(errors);
    }
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  }
} catch (err) {
  if (err instanceof ContractValidationError) {
    const { errors } = err;
    process.stderr.write(`refusing to emit: contract failed schema validation (${errors.length} violation(s)):\n`);
    for (const e of errors) process.stderr.write(`  ${e.path || "(root)"}: ${e.message}\n`);
    validationFailed = true;
  } else {
    throw err;
  }
} finally {
  await store.close();
}

if (validationFailed) process.exit(1);
