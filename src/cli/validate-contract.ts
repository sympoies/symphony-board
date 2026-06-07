#!/usr/bin/env node
// Validate an emitted contract JSON file against the normative schema. A
// producer-side guard usable on its own (CI, a spot check) or as the gate baked
// into `emit` (which validates before writing). Exit 0 = valid, 1 = invalid.
//
//   node src/cli/validate-contract.ts --in data/contract.json

import { readFileSync } from "node:fs";
import { validateContract } from "../contract/validate.ts";

interface Args {
  in: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { in: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--in" || x === "-i") a.in = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${x}`);
  }
  if (!a.in) throw new Error("missing --in <contract.json>");
  return a;
}

const args = parseArgs(process.argv.slice(2));
const data: unknown = JSON.parse(readFileSync(args.in!, "utf8"));
const errors = validateContract(data);

if (errors.length === 0) {
  process.stderr.write(`ok: ${args.in} is a valid contract\n`);
  process.exit(0);
}
process.stderr.write(`invalid: ${args.in} has ${errors.length} schema violation(s):\n`);
for (const e of errors) process.stderr.write(`  ${e.path || "(root)"}: ${e.message}\n`);
process.exit(1);
